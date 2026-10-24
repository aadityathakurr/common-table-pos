import express, { type Request, type Response } from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CreateOrderCommand, KitchenOrder, OrderLine, OrderRecord, OrderStatus, PaymentCommand, PaymentMethod, ServerMessage } from '@common-table/contracts';
import { allocateNumber, createId, db, DEMO_ACTOR, DEMO_OUTLET, DEMO_TAX_RATE_BPS, DEMO_TENANT, DEMO_TERMINAL } from './database.js';
import { checkEdgeConfiguration, EDGE_CONFIG } from './config.js';
import { formatKitchenTicket, formatReceipt, sendToMockPrinter, startMockPrinter } from './printer.js';

const app=express();
const httpServer=createServer(app);
const wss=new WebSocketServer({noServer:true});
const port=Number(process.env.PORT??3001);
app.disable('x-powered-by');
app.use(express.json({limit:'128kb'}));
app.use((req,res,next)=>{
  const supplied=req.header('x-request-id');
  const requestId=supplied&&/^[A-Za-z0-9._-]{8,80}$/.test(supplied)?supplied:randomUUID();
  const startedAt=performance.now();
  res.setHeader('x-request-id',requestId);
  res.on('finish',()=>console.log(JSON.stringify({
    level:res.statusCode>=500?'error':'info',event:'http.request',requestId,method:req.method,
    path:req.path,status:res.statusCode,durationMs:Math.round(performance.now()-startedAt),
  })));
  next();
});

function fail(res:Response,status:number,message:string){return res.status(status).json({error:message});}
function publish(type:ServerMessage['type'],payload:ServerMessage['payload']){
  const message=JSON.stringify({type,payload} satisfies ServerMessage);
  for(const client of wss.clients)if(client.readyState===WebSocket.OPEN)client.send(message);
}
function mapLines(orderId:string):OrderLine[]{
  return (db.prepare(`SELECT id,menu_item_id AS menuItemId,item_name_snapshot AS name,category_snapshot AS category,
    quantity,unit_price_minor AS unitPriceMinor,modifiers_json AS modifiersJson,line_total_minor AS lineTotalMinor,kitchen_station AS kitchenStation,note
    FROM order_lines WHERE order_id=? ORDER BY rowid`).all(orderId) as Array<OrderLine & {note:string|null}>)
    .map(line=>({...line,modifiers:JSON.parse((line as OrderLine&{modifiersJson?:string}).modifiersJson??'[]') as OrderLine['modifiers'],note:line.note??undefined}));
}
function mapOrder(row:Record<string,unknown>):OrderRecord{
  const lines=mapLines(String(row.id));
  return {
    id:String(row.id),commandId:String(row.command_id),tenantId:String(row.tenant_id),outletId:String(row.outlet_id),
    terminalId:String(row.terminal_id),orderNumber:String(row.order_number),orderType:row.order_type as 'dine_in'|'takeaway',
    tableLabel:row.table_label==null?null:String(row.table_label),guestCount:Number(row.guest_count),status:row.status as OrderStatus,
    note:row.note==null?null:String(row.note),createdAt:String(row.created_at),lines,
    taxRateBps:Number(row.tax_rate_bps),subtotalMinor:Number(row.subtotal_minor),taxTotalMinor:Number(row.tax_total_minor),
    totalMinor:Number(row.total_minor),...(row.invoice_number?{invoiceNumber:String(row.invoice_number)}:{}),
    ...(row.payment_method?{paymentMethod:row.payment_method as PaymentMethod}:{}),
  };
}
function orderById(id:string):OrderRecord|undefined{
  const row=db.prepare('SELECT * FROM orders WHERE id=? AND tenant_id=? AND outlet_id=?').get(id,DEMO_TENANT,DEMO_OUTLET) as Record<string,unknown>|undefined;
  return row?mapOrder(row):undefined;
}
function kitchenOrders():KitchenOrder[]{
  const rows=db.prepare(`SELECT * FROM orders WHERE tenant_id=? AND outlet_id=? AND status IN ('sent','preparing','ready') ORDER BY created_at`)
    .all(DEMO_TENANT,DEMO_OUTLET) as Array<Record<string,unknown>>;
  return rows.map(row=>mapOrder(row));
}
function audit(entityType:string,entityId:string,action:string,reason:string|null,payload:Record<string,unknown>={}){
  db.prepare(`INSERT INTO audit_events(id,tenant_id,outlet_id,actor_id,terminal_id,entity_type,entity_id,action,reason,payload_json,occurred_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(createId(),DEMO_TENANT,DEMO_OUTLET,DEMO_ACTOR,DEMO_TERMINAL,entityType,entityId,action,reason,JSON.stringify(payload),new Date().toISOString());
}
function createOrder(command:CreateOrderCommand):{order:OrderRecord;duplicate:boolean}{
  const existing=db.prepare('SELECT * FROM orders WHERE command_id=?').get(command.commandId) as Record<string,unknown>|undefined;
  if(existing)return {order:mapOrder(existing),duplicate:true};
  if(command.tenantId!==DEMO_TENANT||command.outletId!==DEMO_OUTLET||command.terminalId!==DEMO_TERMINAL)throw new Error('Unknown demo tenant, outlet, or terminal.');
  if(!Array.isArray(command.lines)||command.lines.length===0||command.lines.length>50)throw new Error('An order needs between 1 and 50 items.');
  if(command.orderType!=='dine_in'&&command.orderType!=='takeaway')throw new Error('Unsupported order type.');
  if(command.orderType==='dine_in'&&!command.tableLabel?.trim())throw new Error('Choose a table for dine-in orders.');
  const prepared=command.lines.map(line=>{
    const menu=db.prepare('SELECT * FROM menu_items WHERE id=? AND tenant_id=? AND outlet_id=? AND available=1').get(line.menuItemId,DEMO_TENANT,DEMO_OUTLET) as Record<string,unknown>|undefined;
    if(!menu)throw new Error(`Menu item ${line.menuItemId} is unavailable.`);
    if(!Number.isFinite(line.quantity)||line.quantity<=0||line.quantity>99)throw new Error('Item quantities must be between 0 and 99.');
    const quantity=Math.round(line.quantity*1000)/1000;
    const modifierIds=[...new Set(line.modifierIds??[])];
    if(modifierIds.length>(line.modifierIds??[]).length||modifierIds.length>8)throw new Error('Choose valid item modifiers.');
    const modifiers=modifierIds.length?db.prepare(`SELECT id,group_name AS "group",name,price_delta_minor AS priceDeltaMinor FROM menu_modifiers
      WHERE tenant_id=? AND outlet_id=? AND menu_item_id=? AND active=1 AND id IN (${modifierIds.map(()=>'?').join(',')}) ORDER BY sort_order`)
      .all(DEMO_TENANT,DEMO_OUTLET,line.menuItemId,...modifierIds) as OrderLine['modifiers']:[];
    if(modifiers.length!==modifierIds.length)throw new Error(`One or more modifiers for ${String(menu.name)} are no longer available.`);
    const groupCounts=new Map<string,number>();for(const modifier of modifiers)groupCounts.set(modifier.group,(groupCounts.get(modifier.group)??0)+1);
    for(const [group,count] of groupCounts)if(group!=='Add-on'&&count>1)throw new Error(`Select only one ${group.toLowerCase()} option.`);
    const basePriceMinor=Number(menu.price_minor);const unitPriceMinor=basePriceMinor+modifiers.reduce((sum,modifier)=>sum+modifier.priceDeltaMinor,0);
    return {id:createId(),menuItemId:String(menu.id),name:String(menu.name),category:String(menu.category),kitchenStation:String(menu.kitchen_station),quantity,basePriceMinor,modifiers,lineTotalMinor:Math.round(unitPriceMinor*quantity),note:line.note?.slice(0,140)??null};
  });
  const subtotalMinor=prepared.reduce((sum,line)=>sum+line.lineTotalMinor,0);
  const taxTotalMinor=Math.round(subtotalMinor*DEMO_TAX_RATE_BPS/10000);
  const totalMinor=subtotalMinor+taxTotalMinor;
  const orderId=randomUUID();const timestamp=new Date().toISOString();
  const create=db.transaction(()=>{
    const orderNumber=allocateNumber('order','ORD');
    db.prepare(`INSERT INTO orders(id,command_id,tenant_id,outlet_id,terminal_id,order_number,order_type,table_label,guest_count,status,note,currency,subtotal_minor,tax_total_minor,tax_rate_bps,total_minor,created_at,updated_at)
      VALUES(@id,@commandId,@tenantId,@outletId,@terminalId,@orderNumber,@orderType,@tableLabel,@guestCount,'sent',@note,'INR',@subtotalMinor,@taxTotalMinor,@taxRateBps,@totalMinor,@createdAt,@updatedAt)`).run({
      id:orderId,commandId:command.commandId,tenantId:DEMO_TENANT,outletId:DEMO_OUTLET,terminalId:DEMO_TERMINAL,orderNumber,
      orderType:command.orderType,tableLabel:command.orderType==='dine_in'?command.tableLabel:null,guestCount:Math.max(1,Math.min(20,Math.floor(command.guestCount??1))),
      note:command.note?.slice(0,140)??null,subtotalMinor,taxTotalMinor,taxRateBps:DEMO_TAX_RATE_BPS,totalMinor,createdAt:timestamp,updatedAt:timestamp,
    });
    const insertLine=db.prepare(`INSERT INTO order_lines(id,tenant_id,outlet_id,order_id,menu_item_id,item_name_snapshot,category_snapshot,unit_price_minor,modifiers_json,quantity,line_total_minor,kitchen_station,note)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for(const line of prepared)insertLine.run(line.id,DEMO_TENANT,DEMO_OUTLET,orderId,line.menuItemId,line.name,line.category,line.basePriceMinor,JSON.stringify(line.modifiers),line.quantity,line.lineTotalMinor,line.kitchenStation,line.note);
    const stations=new Set(prepared.map(line=>line.kitchenStation));
    const insertTicket=db.prepare(`INSERT INTO kitchen_tickets(id,tenant_id,outlet_id,order_id,station,status,created_at) VALUES(?,?,?,?,?,'new',?)`);
    for(const station of stations)insertTicket.run(createId(),DEMO_TENANT,DEMO_OUTLET,orderId,station,timestamp);
    audit('order',orderId,'order.sent_to_kitchen',null,{orderNumber,terminalId:DEMO_TERMINAL,lineCount:prepared.length});
  });
  create();
  const order=orderById(orderId)!;
  return {order,duplicate:false};
}

app.get('/api/health',(_req,res)=>res.json({status:'ok',service:'common-table-edge',outletId:DEMO_OUTLET,taxRateBps:DEMO_TAX_RATE_BPS,printer:{host:process.env.MOCK_PRINTER_HOST??'127.0.0.1',port:Number(process.env.MOCK_PRINTER_PORT??9100)}}));
app.get('/api/context',(_req,res)=>res.json({
  tenantId:DEMO_TENANT,tenantName:EDGE_CONFIG.tenantName,outletId:DEMO_OUTLET,outletName:EDGE_CONFIG.outletName,
  terminalId:DEMO_TERMINAL,terminalName:EDGE_CONFIG.terminalName,locationLabel:EDGE_CONFIG.locationLabel,
  currency:EDGE_CONFIG.currency,taxRateBps:DEMO_TAX_RATE_BPS,
}));
app.get('/api/ready',(_req,res)=>{
  try{
    checkEdgeConfiguration();
    const databaseCheck=db.prepare('PRAGMA quick_check').get() as {quick_check?:string};
    if(databaseCheck.quick_check!=='ok')return res.status(503).json({status:'not_ready',checks:{database:'failed',configuration:'ok'}});
    db.prepare('SELECT 1').get();
    return res.json({status:'ready',checks:{database:'ok',configuration:'ok'}});
  }catch(error){
    console.error(JSON.stringify({level:'error',event:'readiness.failed',reason:error instanceof Error?error.message:'unknown'}));
    return res.status(503).json({status:'not_ready',checks:{database:'unknown',configuration:'failed'}});
  }
});
app.get('/api/menu',(_req,res)=>{
  const rows=db.prepare('SELECT id,name,category,price_minor AS priceMinor,emoji,color,tag,vegetarian,available,kitchen_station AS kitchenStation FROM menu_items WHERE tenant_id=? AND outlet_id=? AND available=1 ORDER BY rowid')
    .all(DEMO_TENANT,DEMO_OUTLET) as Array<Record<string,unknown>>;
  const modifiers=db.prepare(`SELECT id,menu_item_id AS menuItemId,group_name AS "group",name,price_delta_minor AS priceDeltaMinor FROM menu_modifiers WHERE tenant_id=? AND outlet_id=? AND active=1 ORDER BY sort_order`)
    .all(DEMO_TENANT,DEMO_OUTLET) as Array<Record<string,unknown>>;
  res.json(rows.map(row=>({...row,priceMinor:Number(row.priceMinor),vegetarian:Boolean(row.vegetarian),available:Boolean(row.available),modifiers:modifiers.filter(modifier=>modifier.menuItemId===row.id).map(({menuItemId,...modifier})=>({...modifier,priceDeltaMinor:Number(modifier.priceDeltaMinor)}))})));
});
app.get('/api/kitchen',(_req,res)=>res.json(kitchenOrders()));
app.get('/api/orders/:orderId', (req,res)=>{const order=orderById(req.params.orderId);if(!order)return fail(res,404,'Order not found.');return res.json(order);});
app.get('/api/orders',(_req,res)=>{
  const rows=db.prepare('SELECT * FROM orders WHERE tenant_id=? AND outlet_id=? ORDER BY created_at DESC LIMIT 100').all(DEMO_TENANT,DEMO_OUTLET) as Array<Record<string,unknown>>;
  return res.json(rows.map(mapOrder));
});
app.post('/api/orders',(req:Request,res:Response)=>{
  const body=req.body as Partial<CreateOrderCommand>;
  if(typeof body.commandId!=='string'||body.commandId.length<8)return fail(res,400,'A stable commandId is required for idempotent retries.');
  try{
    const {order,duplicate}=createOrder(body as CreateOrderCommand);
    publish(duplicate?'order.updated':'order.created',order);
    if(!duplicate)void sendToMockPrinter(formatKitchenTicket(order)).catch(error=>console.error('KOT printer is not reachable:',error));
    return res.status(duplicate?200:201).json(order);
  }catch(error){return fail(res,400,error instanceof Error?error.message:'Unable to create order.');}
});
app.patch('/api/orders/:orderId/status',(req,res)=>{
  const nextStatus=(req.body as {status?:OrderStatus}).status;
  const allowed:Record<string,OrderStatus[]>={sent:['preparing','ready','cancelled'],preparing:['ready','cancelled'],ready:['cancelled']};
  const before=orderById(req.params.orderId);if(!before)return fail(res,404,'Order not found.');
  if(!nextStatus||!allowed[before.status]?.includes(nextStatus))return fail(res,409,`Cannot move an order from ${before.status} to ${nextStatus??'unknown'}.`);
  const timestamp=new Date().toISOString();
  const update=db.transaction(()=>{
    db.prepare('UPDATE orders SET status=?,updated_at=? WHERE id=?').run(nextStatus,timestamp,before.id);
    db.prepare('UPDATE kitchen_tickets SET status=?,ready_at=? WHERE order_id=?').run(nextStatus==='ready'?'ready':nextStatus==='preparing'?'preparing':nextStatus==='cancelled'?'voided':'new',nextStatus==='ready'?timestamp:null,before.id);
    audit('order',before.id,`order.${nextStatus}`,null);
  });update();
  const after=orderById(before.id)!;publish('order.updated',after);return res.json(after);
});
app.post('/api/orders/:orderId/payment',(req,res)=>{
  const body=req.body as Partial<PaymentCommand>;
  if(typeof body.commandId!=='string'||body.commandId.length<8)return fail(res,400,'A stable payment commandId is required.');
  const method=body.method;if(!method||!(['cash','upi','card'] as const).includes(method))return fail(res,400,'Choose cash, UPI, or card.');
  const before=orderById(req.params.orderId);if(!before)return fail(res,404,'Order not found.');
  if(before.status==='paid')return res.json(before);
  if(before.status==='cancelled')return fail(res,409,'Cancelled orders cannot be paid.');
  if(Number(body.amountMinor)!==before.totalMinor)return fail(res,409,'Payment amount does not match the order total.');
  const duplicate=db.prepare('SELECT id FROM payment_events WHERE command_id=?').get(body.commandId);
  if(duplicate)return res.json(before);
  const timestamp=new Date().toISOString();
  const pay=db.transaction(()=>{
    const invoiceNumber=allocateNumber('invoice','INV');
    db.prepare('INSERT INTO payment_events(id,command_id,tenant_id,outlet_id,order_id,terminal_id,method,amount_minor,status,created_at) VALUES(?,?,?,?,?,?,?,? ,\'succeeded\',?)')
      .run(createId(),body.commandId,DEMO_TENANT,DEMO_OUTLET,before.id,DEMO_TERMINAL,method,before.totalMinor,timestamp);
    db.prepare('UPDATE orders SET status=\'paid\',payment_method=?,invoice_number=?,updated_at=? WHERE id=?').run(method,invoiceNumber,timestamp,before.id);
    audit('order',before.id,'order.payment_recorded',null,{method,invoiceNumber,amountMinor:before.totalMinor});
  });pay();
  const order=orderById(before.id)!;publish('order.updated',order);
  void sendToMockPrinter(formatReceipt(order)).catch(error=>console.error('Receipt printer is not reachable:',error));
  return res.json(order);
});
app.post('/api/printer/test',(_req,res)=>{
  const sample:KitchenOrder={id:'sample',orderNumber:'J-ORD-000001',orderType:'takeaway',tableLabel:null,status:'sent',note:'Printer connection check',createdAt:new Date().toISOString(),lines:[]};
  void sendToMockPrinter(formatKitchenTicket(sample)).catch(()=>undefined);
  return res.json({status:'queued',host:process.env.MOCK_PRINTER_HOST??'127.0.0.1',port:Number(process.env.MOCK_PRINTER_PORT??9100)});
});
const webDist=resolve(dirname(fileURLToPath(import.meta.url)),'../../web/dist');
if(existsSync(webDist)){
  app.use(express.static(webDist,{index:false}));
  app.get(/^(?!\/api(?:\/|$)|\/socket(?:\/|$)).*/,(_req,res)=>res.sendFile(resolve(webDist,'index.html')));
}
app.use((_req,res)=>fail(res,404,'Route not found.'));

httpServer.on('upgrade',(request,socket,head)=>{
  const url=new URL(request.url??'/',`http://${request.headers.host??'localhost'}`);
  if(url.pathname!=='/socket'){socket.destroy();return;}
  wss.handleUpgrade(request,socket,head,webSocket=>wss.emit('connection',webSocket,request));
});
wss.on('connection',webSocket=>{
  webSocket.send(JSON.stringify({type:'kitchen.snapshot',payload:kitchenOrders()} satisfies ServerMessage));
});

const printer=startMockPrinter();
httpServer.listen(port,'0.0.0.0',()=>console.log(`🍽️  Common Table edge server listening on http://0.0.0.0:${port}`));
function shutdown(){httpServer.close();wss.close();printer.close();db.close();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
