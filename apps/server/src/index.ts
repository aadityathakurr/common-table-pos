import express, { type Request, type Response } from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddOrderLinesCommand, CashMovementCommand, CreateOrderCommand, KitchenOrder, OrderLine, OrderLineDraft, OrderRecord, OrderStatus, PaymentCommand, PaymentMethod, ServerMessage, ShiftRecord, ShiftSummary } from '@common-table/contracts';
import { allocateNumber, createId, db, DEMO_ACTOR, DEMO_OUTLET, DEMO_TAX_RATE_BPS, DEMO_TENANT, DEMO_TERMINAL, enqueueSyncEvent, syncOutboxStatus } from './database.js';
import { checkEdgeConfiguration, EDGE_CONFIG } from './config.js';
import { formatKitchenTicket, formatReceipt, printerStatus, sendToPrinter, startPrinterAdapter } from './printer.js';
import { buildDailySalesReport, dailySalesCsv, localBusinessDate } from './reports.js';
import { getSyncStatus, startSyncWorker } from './sync.js';
import { clearedSessionCookie, createStaffSession, currentStaff, readStaffSession, readStaffSessionCookie, requireRoles, sessionCookie, sessionMiddleware, StaffAuthError } from './auth.js';

const app=express();
const httpServer=createServer(app);
const wss=new WebSocketServer({noServer:true});
const socketRoles=new WeakMap<WebSocket,string>();
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
function queuePrint(payload:Buffer,label:string){
  if(printerStatus().mode==='disabled')return;
  void sendToPrinter(payload).catch(error=>console.error(`${label} printer is not reachable:`,error));
}
function routeParam(req:Request,name:string):string{
  const value=req.params[name];
  return Array.isArray(value)?String(value[0]??''):String(value??'');
}
function publish(type:ServerMessage['type'],payload:ServerMessage['payload']){
  const message=JSON.stringify({type,payload} satisfies ServerMessage);
  for(const client of wss.clients)if(client.readyState===WebSocket.OPEN){
    if(socketRoles.get(client)==='kitchen')client.send(JSON.stringify({type:'kitchen.snapshot',payload:kitchenSnapshot()} satisfies ServerMessage));
    else client.send(message);
  }
}
function mapLines(orderId:string):OrderLine[]{
  return (db.prepare(`SELECT l.id,l.menu_item_id AS menuItemId,l.item_name_snapshot AS name,l.category_snapshot AS category,
    l.quantity,l.unit_price_minor AS unitPriceMinor,l.modifiers_json AS modifiersJson,l.line_total_minor AS lineTotalMinor,
    l.kitchen_station AS kitchenStation,l.note,v.voided_at AS voidedAt,v.reason AS voidReason
    FROM order_lines l LEFT JOIN order_line_voids v ON v.order_line_id=l.id WHERE l.order_id=? ORDER BY l.rowid`).all(orderId) as Array<OrderLine & {note:string|null;modifiersJson:string;voidedAt:string|null;voidReason:string|null}>)
    .map(line=>({...line,modifiers:JSON.parse(line.modifiersJson) as OrderLine['modifiers'],note:line.note??undefined,
      ...(line.voidedAt?{voidedAt:line.voidedAt,voidReason:line.voidReason??undefined}:{})}));
}
function mapOrder(row:Record<string,unknown>):OrderRecord{
  const lines=mapLines(String(row.id));
  return {
    id:String(row.id),commandId:String(row.command_id),tenantId:String(row.tenant_id),outletId:String(row.outlet_id),
    terminalId:String(row.terminal_id),currency:String(row.currency??EDGE_CONFIG.currency),orderNumber:String(row.order_number),orderType:row.order_type as 'dine_in'|'takeaway',
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
function mapShift(row:Record<string,unknown>):ShiftRecord{
  return {id:String(row.id),shiftNumber:String(row.shift_number),status:row.status as ShiftRecord['status'],openedAt:String(row.opened_at),openingFloatMinor:Number(row.opening_float_minor),
    ...(row.closed_at?{closedAt:String(row.closed_at)}:{}),...(row.counted_cash_minor!=null?{countedCashMinor:Number(row.counted_cash_minor)}:{}),
    ...(row.expected_cash_minor!=null?{expectedCashMinor:Number(row.expected_cash_minor)}:{}),...(row.variance_minor!=null?{varianceMinor:Number(row.variance_minor)}:{})};
}
function shiftSummary(shiftId:string):ShiftSummary|undefined{
  const row=db.prepare('SELECT * FROM shifts WHERE id=? AND tenant_id=? AND outlet_id=?').get(shiftId,DEMO_TENANT,DEMO_OUTLET) as Record<string,unknown>|undefined;
  if(!row)return undefined;
  const shift=mapShift(row);
  const salesRows=db.prepare(`SELECT method,SUM(CASE WHEN entry_type='refund' THEN -amount_minor ELSE amount_minor END) AS amount_minor FROM payment_events
    WHERE tenant_id=? AND outlet_id=? AND shift_id=? AND status='succeeded' GROUP BY method`).all(DEMO_TENANT,DEMO_OUTLET,shiftId) as Array<{method:PaymentMethod;amount_minor:number|null}>;
  const salesByMethod:Record<PaymentMethod,number>={cash:0,upi:0,card:0};
  for(const sale of salesRows)salesByMethod[sale.method]=Number(sale.amount_minor??0);
  const movements=db.prepare(`SELECT movement_type,SUM(amount_minor) AS amount_minor FROM cash_movements
    WHERE tenant_id=? AND outlet_id=? AND shift_id=? GROUP BY movement_type`).all(DEMO_TENANT,DEMO_OUTLET,shiftId) as Array<{movement_type:'cash_in'|'cash_out';amount_minor:number|null}>;
  const cashInMinor=Number(movements.find(row=>row.movement_type==='cash_in')?.amount_minor??0);
  const cashOutMinor=Number(movements.find(row=>row.movement_type==='cash_out')?.amount_minor??0);
  const expectedCashMinor=shift.openingFloatMinor+salesByMethod.cash+cashInMinor-cashOutMinor;
  return {shift,salesByMethod,cashInMinor,cashOutMinor,expectedCashMinor};
}
function kitchenOrders():KitchenOrder[]{
  const rows=db.prepare(`SELECT kt.id AS ticket_id,kt.station AS kitchen_station,kt.status AS ticket_status,o.*
    FROM kitchen_tickets kt JOIN orders o ON o.id=kt.order_id AND o.tenant_id=kt.tenant_id AND o.outlet_id=kt.outlet_id
    WHERE kt.tenant_id=? AND kt.outlet_id=? AND kt.status!='voided' AND o.status IN ('sent','preparing','ready')
    ORDER BY o.created_at,kt.station`)
    .all(DEMO_TENANT,DEMO_OUTLET) as Array<Record<string,unknown>>;
  return rows.flatMap(row=>{
    const order=mapOrder(row);const kitchenStation=String(row.kitchen_station);
    const lines=order.lines.filter(line=>line.kitchenStation===kitchenStation);
    if(!lines.some(line=>!line.voidedAt))return [];
    return [{...order,ticketId:String(row.ticket_id),kitchenStation,ticketStatus:row.ticket_status as 'new'|'preparing'|'ready'|'voided',lines}];
  });
}
function kitchenSnapshot():KitchenOrder[]{
  return kitchenOrders().map(ticket=>({
    id:ticket.id,ticketId:ticket.ticketId??ticket.id,kitchenStation:ticket.kitchenStation??'Unknown station',ticketStatus:ticket.ticketStatus??'new',
    orderNumber:ticket.orderNumber,orderType:ticket.orderType,tableLabel:ticket.tableLabel,status:ticket.status,note:ticket.note,createdAt:ticket.createdAt,
    lines:ticket.lines.map(line=>({id:line.id,menuItemId:line.menuItemId,name:line.name,category:line.category,quantity:line.quantity,
      kitchenStation:line.kitchenStation,note:line.note,modifiers:line.modifiers.map(({id,group,name})=>({id,group,name,priceDeltaMinor:0})),voidedAt:line.voidedAt} as OrderLine)),
  }));
}
function refreshOrderKitchenStatus(orderId:string,timestamp:string){
  const rows=db.prepare(`SELECT kt.status FROM kitchen_tickets kt WHERE kt.tenant_id=? AND kt.outlet_id=? AND kt.order_id=? AND kt.status!='voided'
    AND EXISTS (SELECT 1 FROM order_lines l LEFT JOIN order_line_voids v ON v.order_line_id=l.id
      WHERE l.tenant_id=kt.tenant_id AND l.outlet_id=kt.outlet_id AND l.order_id=kt.order_id AND l.kitchen_station=kt.station AND v.order_line_id IS NULL)`)
    .all(DEMO_TENANT,DEMO_OUTLET,orderId) as Array<{status:'new'|'preparing'|'ready'}>;
  if(!rows.length)return undefined;
  const status=rows.every(row=>row.status==='ready')?'ready':rows.some(row=>row.status==='preparing')?'preparing':'sent';
  db.prepare('UPDATE orders SET status=?,updated_at=? WHERE id=?').run(status,timestamp,orderId);
  return status;
}
function audit(entityType:string,entityId:string,action:string,reason:string|null,payload:Record<string,unknown>={},actorId=DEMO_ACTOR){
  const eventId=createId();const occurredAt=new Date().toISOString();
  db.prepare(`INSERT INTO audit_events(id,tenant_id,outlet_id,actor_id,terminal_id,entity_type,entity_id,action,reason,payload_json,occurred_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(eventId,DEMO_TENANT,DEMO_OUTLET,actorId,DEMO_TERMINAL,entityType,entityId,action,reason,JSON.stringify(payload),occurredAt);
  enqueueSyncEvent('audit',entityId,action,{entityType,entityId,actorId,terminalId:DEMO_TERMINAL,reason,payload},occurredAt,eventId);
}
type PreparedOrderLine={id:string;menuItemId:string;name:string;category:string;kitchenStation:string;quantity:number;basePriceMinor:number;modifiers:OrderLine['modifiers'];lineTotalMinor:number;note:string|null};
function prepareLines(lines:OrderLineDraft[]):PreparedOrderLine[]{
  if(!Array.isArray(lines)||lines.length===0||lines.length>50)throw new Error('An order change needs between 1 and 50 items.');
  return lines.map(line=>{
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
}
function recalculateOrder(orderId:string,timestamp:string){
  const subtotal=Number((db.prepare(`SELECT COALESCE(SUM(l.line_total_minor),0) AS subtotal FROM order_lines l
    LEFT JOIN order_line_voids v ON v.order_line_id=l.id WHERE l.order_id=? AND v.order_line_id IS NULL`).get(orderId) as {subtotal:number}).subtotal);
  const taxRate=Number((db.prepare('SELECT tax_rate_bps FROM orders WHERE id=?').get(orderId) as {tax_rate_bps:number}).tax_rate_bps);
  const tax=Math.round(subtotal*taxRate/10000);
  db.prepare('UPDATE orders SET subtotal_minor=?,tax_total_minor=?,total_minor=?,updated_at=? WHERE id=?').run(subtotal,tax,subtotal+tax,timestamp,orderId);
}
function rememberEdit(commandId:string,orderId:string,action:'lines_added'|'line_voided'|'order_voided',request:unknown,timestamp:string){
  if(editReplay(commandId,orderId,action,request))return true;
  db.prepare('INSERT INTO order_edit_commands(command_id,tenant_id,outlet_id,order_id,action,request_json,occurred_at) VALUES(?,?,?,?,?,?,?)')
    .run(commandId,DEMO_TENANT,DEMO_OUTLET,orderId,action,JSON.stringify(request),timestamp);
  return false;
}
function editReplay(commandId:string,orderId:string,action:'lines_added'|'line_voided'|'order_voided',request:unknown){
  const previous=db.prepare('SELECT order_id,action,request_json FROM order_edit_commands WHERE command_id=?').get(commandId) as {order_id:string;action:string;request_json:string}|undefined;
  if(!previous)return false;
  if(previous.order_id!==orderId||previous.action!==action||previous.request_json!==JSON.stringify(request))throw new Error('This commandId was already used for a different order change.');
  return true;
}
function persistAddedLines(orderId:string,lines:PreparedOrderLine[],timestamp:string){
  const insert=db.prepare(`INSERT INTO order_lines(id,tenant_id,outlet_id,order_id,menu_item_id,item_name_snapshot,category_snapshot,unit_price_minor,modifiers_json,quantity,line_total_minor,kitchen_station,note)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for(const line of lines)insert.run(line.id,DEMO_TENANT,DEMO_OUTLET,orderId,line.menuItemId,line.name,line.category,line.basePriceMinor,JSON.stringify(line.modifiers),line.quantity,line.lineTotalMinor,line.kitchenStation,line.note);
  const known=new Set((db.prepare('SELECT station FROM kitchen_tickets WHERE order_id=?').all(orderId) as Array<{station:string}>).map(ticket=>ticket.station));
  const insertTicket=db.prepare(`INSERT INTO kitchen_tickets(id,tenant_id,outlet_id,order_id,station,status,created_at) VALUES(?,?,?,?,?,'new',?)`);
  for(const station of new Set(lines.map(line=>line.kitchenStation))){
    if(known.has(station))db.prepare("UPDATE kitchen_tickets SET status='new',ready_at=NULL WHERE tenant_id=? AND outlet_id=? AND order_id=? AND station=?")
      .run(DEMO_TENANT,DEMO_OUTLET,orderId,station);
    else insertTicket.run(createId(),DEMO_TENANT,DEMO_OUTLET,orderId,station,timestamp);
  }
}
function createOrder(command:CreateOrderCommand,actorId=DEMO_ACTOR):{order:OrderRecord;duplicate:boolean}{
  const existing=db.prepare('SELECT * FROM orders WHERE command_id=?').get(command.commandId) as Record<string,unknown>|undefined;
  if(existing)return {order:mapOrder(existing),duplicate:true};
  if(command.tenantId!==DEMO_TENANT||command.outletId!==DEMO_OUTLET||command.terminalId!==DEMO_TERMINAL)throw new Error('Unknown demo tenant, outlet, or terminal.');
  if(!Array.isArray(command.lines)||command.lines.length===0||command.lines.length>50)throw new Error('An order needs between 1 and 50 items.');
  if(command.orderType!=='dine_in'&&command.orderType!=='takeaway')throw new Error('Unsupported order type.');
  if(command.orderType==='dine_in'&&!command.tableLabel?.trim())throw new Error('Choose a table for dine-in orders.');
  const prepared=prepareLines(command.lines);
  const subtotalMinor=prepared.reduce((sum,line)=>sum+line.lineTotalMinor,0);
  const taxTotalMinor=Math.round(subtotalMinor*DEMO_TAX_RATE_BPS/10000);
  const totalMinor=subtotalMinor+taxTotalMinor;
  const orderId=randomUUID();const timestamp=new Date().toISOString();
  const create=db.transaction(()=>{
    const orderNumber=allocateNumber('order','ORD');
    db.prepare(`INSERT INTO orders(id,command_id,tenant_id,outlet_id,terminal_id,order_number,order_type,table_label,guest_count,status,note,currency,subtotal_minor,tax_total_minor,tax_rate_bps,total_minor,created_at,updated_at)
      VALUES(@id,@commandId,@tenantId,@outletId,@terminalId,@orderNumber,@orderType,@tableLabel,@guestCount,'sent',@note,@currency,@subtotalMinor,@taxTotalMinor,@taxRateBps,@totalMinor,@createdAt,@updatedAt)`).run({
      id:orderId,commandId:command.commandId,tenantId:DEMO_TENANT,outletId:DEMO_OUTLET,terminalId:DEMO_TERMINAL,orderNumber,
      orderType:command.orderType,tableLabel:command.orderType==='dine_in'?command.tableLabel:null,guestCount:Math.max(1,Math.min(20,Math.floor(command.guestCount??1))),
      note:command.note?.slice(0,140)??null,currency:EDGE_CONFIG.currency,subtotalMinor,taxTotalMinor,taxRateBps:DEMO_TAX_RATE_BPS,totalMinor,createdAt:timestamp,updatedAt:timestamp,
    });
    const insertLine=db.prepare(`INSERT INTO order_lines(id,tenant_id,outlet_id,order_id,menu_item_id,item_name_snapshot,category_snapshot,unit_price_minor,modifiers_json,quantity,line_total_minor,kitchen_station,note)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for(const line of prepared)insertLine.run(line.id,DEMO_TENANT,DEMO_OUTLET,orderId,line.menuItemId,line.name,line.category,line.basePriceMinor,JSON.stringify(line.modifiers),line.quantity,line.lineTotalMinor,line.kitchenStation,line.note);
    const stations=new Set(prepared.map(line=>line.kitchenStation));
    const insertTicket=db.prepare(`INSERT INTO kitchen_tickets(id,tenant_id,outlet_id,order_id,station,status,created_at) VALUES(?,?,?,?,?,'new',?)`);
    for(const station of stations)insertTicket.run(createId(),DEMO_TENANT,DEMO_OUTLET,orderId,station,timestamp);
    audit('order',orderId,'order.sent_to_kitchen',null,{orderNumber,terminalId:DEMO_TERMINAL,lineCount:prepared.length},actorId);
    enqueueSyncEvent('order',orderId,'order.created',{id:orderId,commandId:command.commandId,tenantId:DEMO_TENANT,outletId:DEMO_OUTLET,
      terminalId:DEMO_TERMINAL,orderNumber,orderType:command.orderType,tableLabel:command.orderType==='dine_in'?command.tableLabel:null,
      guestCount:Math.max(1,Math.min(20,Math.floor(command.guestCount??1))),status:'sent',note:command.note?.slice(0,140)??null,
      currency:EDGE_CONFIG.currency,subtotalMinor,taxTotalMinor,taxRateBps:DEMO_TAX_RATE_BPS,totalMinor,createdAt:timestamp,updatedAt:timestamp,
      lines:prepared.map(line=>({id:line.id,menuItemId:line.menuItemId,name:line.name,category:line.category,quantity:line.quantity,
        unitPriceMinor:line.basePriceMinor,lineTotalMinor:line.lineTotalMinor,kitchenStation:line.kitchenStation,note:line.note,modifiers:line.modifiers}))},timestamp);
  });
  create();
  const order=orderById(orderId)!;
  return {order,duplicate:false};
}

app.get('/api/health',(_req,res)=>res.json({status:'ok',service:'common-table-edge',outletId:DEMO_OUTLET,taxRateBps:DEMO_TAX_RATE_BPS,printer:printerStatus()}));
app.get('/api/context',(_req,res)=>res.json({
  tenantId:DEMO_TENANT,tenantName:EDGE_CONFIG.tenantName,outletId:DEMO_OUTLET,outletName:EDGE_CONFIG.outletName,
  terminalId:DEMO_TERMINAL,terminalName:EDGE_CONFIG.terminalName,locationLabel:EDGE_CONFIG.locationLabel,
  currency:EDGE_CONFIG.currency,timeZone:EDGE_CONFIG.timezone,taxRateBps:DEMO_TAX_RATE_BPS,
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
app.get('/api/auth/session',(req,res)=>{
  let session=readStaffSession(req);
  if(!session&&process.env.NODE_ENV!=='production'){
    session=currentStaff(res);
    res.setHeader('Set-Cookie',sessionCookie(session,EDGE_CONFIG.secureSessionCookie));
  }
  if(!session)return fail(res,401,'Sign in to this outlet before continuing.');
  return res.json({userId:session.userId,email:session.email,displayName:session.displayName,role:session.role,tenantId:session.tenantId,outletId:session.outletId,expiresAt:session.expiresAt});
});
app.post('/api/auth/session',async(req,res)=>{
  const authorization=req.header('authorization')??'';
  const accessToken=authorization.startsWith('Bearer ')?authorization.slice(7).trim():'';
  if(!accessToken)return fail(res,401,'A Supabase sign-in token is required.');
  try{
    const session=await createStaffSession(accessToken);
    res.setHeader('Set-Cookie',sessionCookie(session,EDGE_CONFIG.secureSessionCookie));
    return res.json({userId:session.userId,email:session.email,displayName:session.displayName,role:session.role,tenantId:session.tenantId,outletId:session.outletId,expiresAt:session.expiresAt});
  }catch(error){
    const authError=error instanceof StaffAuthError?error:new StaffAuthError('Could not verify this staff session.',503);
    return fail(res,authError.status,authError.message);
  }
});
app.delete('/api/auth/session',(_req,res)=>{
  res.setHeader('Set-Cookie',clearedSessionCookie(EDGE_CONFIG.secureSessionCookie));
  return res.status(204).end();
});
app.use('/api',sessionMiddleware());
app.get('/api/menu',requireRoles('owner','manager','cashier','kitchen','viewer'),(_req,res)=>{
  const rows=db.prepare('SELECT id,name,category,price_minor AS priceMinor,emoji,color,tag,vegetarian,available,kitchen_station AS kitchenStation FROM menu_items WHERE tenant_id=? AND outlet_id=? AND available=1 ORDER BY rowid')
    .all(DEMO_TENANT,DEMO_OUTLET) as Array<Record<string,unknown>>;
  const modifiers=db.prepare(`SELECT id,menu_item_id AS menuItemId,group_name AS "group",name,price_delta_minor AS priceDeltaMinor FROM menu_modifiers WHERE tenant_id=? AND outlet_id=? AND active=1 ORDER BY sort_order`)
    .all(DEMO_TENANT,DEMO_OUTLET) as Array<Record<string,unknown>>;
  res.json(rows.map(row=>({...row,priceMinor:Number(row.priceMinor),vegetarian:Boolean(row.vegetarian),available:Boolean(row.available),modifiers:modifiers.filter(modifier=>modifier.menuItemId===row.id).map(({menuItemId,...modifier})=>({...modifier,priceDeltaMinor:Number(modifier.priceDeltaMinor)}))})));
});
app.get('/api/kitchen',requireRoles('owner','manager','kitchen'),(_req,res)=>res.json(kitchenSnapshot()));
app.get('/api/reports/daily',requireRoles('owner','manager','viewer'),(req,res)=>{
  const date=typeof req.query.date==='string'?req.query.date:localBusinessDate();
  const report=buildDailySalesReport(date);
  if(!report)return fail(res,400,'Use a valid report date in YYYY-MM-DD format.');
  return res.json(report);
});
app.get('/api/reports/daily.csv',requireRoles('owner','manager','viewer'),(req,res)=>{
  const date=typeof req.query.date==='string'?req.query.date:localBusinessDate();
  const report=buildDailySalesReport(date);
  if(!report)return fail(res,400,'Use a valid report date in YYYY-MM-DD format.');
  res.setHeader('content-type','text/csv; charset=utf-8');
  res.setHeader('content-disposition',`attachment; filename="common-table-${date}.csv"`);
  return res.send(dailySalesCsv(report));
});
app.patch('/api/orders/:orderId/stations/:station/status',requireRoles('owner','manager','kitchen'),(req,res)=>{
  const nextStatus=(req.body as {status?:unknown}).status;
  if(nextStatus!=='preparing'&&nextStatus!=='ready')return fail(res,400,'Kitchen ticket status must be preparing or ready.');
  const before=orderById(routeParam(req,'orderId'));if(!before)return fail(res,404,'Order not found.');
  if(before.status==='paid'||before.status==='cancelled')return fail(res,409,'Paid or cancelled orders cannot be updated by the kitchen.');
  const ticket=db.prepare('SELECT id,status FROM kitchen_tickets WHERE tenant_id=? AND outlet_id=? AND order_id=? AND station=?')
    .get(DEMO_TENANT,DEMO_OUTLET,before.id,routeParam(req,'station')) as {id:string;status:'new'|'preparing'|'ready'|'voided'}|undefined;
  if(!ticket)return fail(res,404,'Kitchen ticket not found for this station.');
  if(ticket.status==='voided')return fail(res,409,'This station ticket no longer has active items.');
  if(ticket.status===nextStatus)return res.json(currentStaff(res).role==='kitchen'?{status:before.status}:before);
  const allowed:Record<string,string[]>={new:['preparing','ready'],preparing:['ready']};
  if(!allowed[ticket.status]?.includes(nextStatus))return fail(res,409,`Cannot move a ${ticket.status} kitchen ticket to ${nextStatus}.`);
  const timestamp=new Date().toISOString();
  db.transaction(()=>{
    db.prepare('UPDATE kitchen_tickets SET status=?,ready_at=? WHERE id=?').run(nextStatus,nextStatus==='ready'?timestamp:null,ticket.id);
    refreshOrderKitchenStatus(before.id,timestamp);
    audit('order',before.id,`order.kitchen_ticket.${nextStatus}`,null,{ticketId:ticket.id,station:routeParam(req,'station')},currentStaff(res).userId);
    enqueueSyncEvent('order',before.id,`order.kitchen_ticket.${nextStatus}`,{orderId:before.id,ticketId:ticket.id,station:routeParam(req,'station'),status:nextStatus},timestamp);
  })();
  const after=orderById(before.id)!;publish('order.updated',after);
  return res.json(currentStaff(res).role==='kitchen'?{status:after.status}:after);
});
app.get('/api/orders/:orderId',requireRoles('owner','manager','cashier'), (req,res)=>{const order=orderById(routeParam(req,'orderId'));if(!order)return fail(res,404,'Order not found.');return res.json(order);});
app.get('/api/orders',requireRoles('owner','manager','cashier'),(_req,res)=>{
  const rows=db.prepare('SELECT * FROM orders WHERE tenant_id=? AND outlet_id=? ORDER BY created_at DESC LIMIT 100').all(DEMO_TENANT,DEMO_OUTLET) as Array<Record<string,unknown>>;
  return res.json(rows.map(mapOrder));
});
app.get('/api/orders/:orderId/payments',requireRoles('owner','manager'),(req,res)=>{
  const orderId=routeParam(req,'orderId');
  if(!orderById(orderId))return fail(res,404,'Order not found.');
  const tenders=db.prepare(`SELECT p.id,p.method,p.amount_minor AS amountMinor,p.created_at AS createdAt,
      p.amount_minor-COALESCE(SUM(r.amount_minor),0) AS refundableMinor
    FROM payment_events p LEFT JOIN payment_events r ON r.tenant_id=p.tenant_id AND r.outlet_id=p.outlet_id
      AND r.refund_of=p.id AND r.status='succeeded' AND r.entry_type='refund'
    WHERE p.tenant_id=? AND p.outlet_id=? AND p.order_id=? AND p.status='succeeded' AND p.entry_type='tender'
    GROUP BY p.id ORDER BY p.created_at,p.id`).all(DEMO_TENANT,DEMO_OUTLET,orderId) as Array<Record<string,unknown>>;
  const refunds=db.prepare(`SELECT id,refund_of AS paymentId,method,amount_minor AS amountMinor,refund_reason AS reason,created_at AS createdAt
    FROM payment_events WHERE tenant_id=? AND outlet_id=? AND order_id=? AND status='succeeded' AND entry_type='refund' ORDER BY created_at,id`)
    .all(DEMO_TENANT,DEMO_OUTLET,orderId) as Array<Record<string,unknown>>;
  return res.json({tenders:tenders.map(row=>({...row,amountMinor:Number(row.amountMinor),refundableMinor:Number(row.refundableMinor)})),refunds});
});
app.get('/api/sync/status',requireRoles('owner','manager','cashier','kitchen','viewer'),(_req,res)=>res.json({...getSyncStatus(),outbox:syncOutboxStatus()}));
app.get('/api/shifts/current',requireRoles('owner','manager','cashier'),(_req,res)=>{
  const row=db.prepare("SELECT id FROM shifts WHERE tenant_id=? AND outlet_id=? AND status='open'").get(DEMO_TENANT,DEMO_OUTLET) as {id:string}|undefined;
  return res.json({shift:row?shiftSummary(row.id):null});
});
app.post('/api/shifts/open',requireRoles('owner','manager','cashier'),(req,res)=>{
  const body=req.body as {commandId?:unknown;openingFloatMinor?:unknown};
  if(typeof body.commandId!=='string'||body.commandId.length<8)return fail(res,400,'A stable commandId is required to open a shift.');
  const openingFloatMinor=Number(body.openingFloatMinor);
  if(!Number.isSafeInteger(openingFloatMinor)||openingFloatMinor<0)return fail(res,400,'Opening float must be a non-negative amount in minor currency units.');
  const replay=db.prepare('SELECT id FROM shifts WHERE command_id=?').get(body.commandId) as {id:string}|undefined;
  if(replay)return res.json(shiftSummary(replay.id));
  const current=db.prepare("SELECT id FROM shifts WHERE tenant_id=? AND outlet_id=? AND status='open'").get(DEMO_TENANT,DEMO_OUTLET);
  if(current)return fail(res,409,'A shift is already open for this outlet.');
  const id=createId();const openedAt=new Date().toISOString();
  try{db.transaction(()=>{
    const shiftNumber=allocateNumber('shift','SHIFT');
    db.prepare(`INSERT INTO shifts(id,command_id,tenant_id,outlet_id,terminal_id,actor_id,shift_number,opening_float_minor,status,opened_at)
      VALUES(?,?,?,?,?,?,?,?,'open',?)`).run(id,body.commandId,DEMO_TENANT,DEMO_OUTLET,DEMO_TERMINAL,currentStaff(res).userId,shiftNumber,openingFloatMinor,openedAt);
    audit('shift',id,'shift.opened',null,{shiftNumber,openingFloatMinor},currentStaff(res).userId);
    enqueueSyncEvent('shift',id,'shift.opened',{id,shiftNumber,status:'open',openedAt,openingFloatMinor,
      tenantId:DEMO_TENANT,outletId:DEMO_OUTLET,terminalId:DEMO_TERMINAL},openedAt);
  })();}catch(error){return fail(res,409,error instanceof Error?error.message:'Unable to open shift.');}
  return res.status(201).json(shiftSummary(id));
});
app.post('/api/shifts/:shiftId/cash-movements',requireRoles('owner','manager','cashier'),(req,res)=>{
  const body=req.body as Partial<CashMovementCommand>;
  if(typeof body.commandId!=='string'||body.commandId.length<8)return fail(res,400,'A stable commandId is required for cash movement.');
  if(body.type!=='cash_in'&&body.type!=='cash_out')return fail(res,400,'Choose cash in or cash out.');
  const amountMinor=Number(body.amountMinor);if(!Number.isSafeInteger(amountMinor)||amountMinor<=0)return fail(res,400,'Cash movement must be greater than zero.');
  const reason=typeof body.reason==='string'?body.reason.trim():'';if(reason.length<3||reason.length>120)return fail(res,400,'Enter a reason between 3 and 120 characters.');
  const replay=db.prepare('SELECT shift_id FROM cash_movements WHERE command_id=?').get(body.commandId) as {shift_id:string}|undefined;
  if(replay)return res.json(shiftSummary(replay.shift_id));
  const shift=db.prepare("SELECT id FROM shifts WHERE id=? AND tenant_id=? AND outlet_id=? AND status='open'").get(routeParam(req,'shiftId'),DEMO_TENANT,DEMO_OUTLET);
  if(!shift)return fail(res,409,'Open a shift before recording cash movement.');
  db.transaction(()=>{
    const movementId=createId();const occurredAt=new Date().toISOString();
    db.prepare(`INSERT INTO cash_movements(id,command_id,tenant_id,outlet_id,shift_id,terminal_id,actor_id,movement_type,amount_minor,reason,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(movementId,body.commandId,DEMO_TENANT,DEMO_OUTLET,routeParam(req,'shiftId'),DEMO_TERMINAL,currentStaff(res).userId,body.type,amountMinor,reason,occurredAt);
    audit('shift',routeParam(req,'shiftId'),`shift.${body.type}`,reason,{amountMinor,commandId:body.commandId},currentStaff(res).userId);
    enqueueSyncEvent('cash_movement',movementId,`shift.${body.type}`,{id:movementId,commandId:body.commandId,shiftId:routeParam(req,'shiftId'),
      movementType:body.type,amountMinor,reason,tenantId:DEMO_TENANT,outletId:DEMO_OUTLET,terminalId:DEMO_TERMINAL,actorId:currentStaff(res).userId},occurredAt);
  })();
  return res.status(201).json(shiftSummary(routeParam(req,'shiftId')));
});
app.post('/api/shifts/:shiftId/close',requireRoles('owner','manager','cashier'),(req,res)=>{
  const body=req.body as {commandId?:unknown;countedCashMinor?:unknown};
  if(typeof body.commandId!=='string'||body.commandId.length<8)return fail(res,400,'A stable commandId is required to close a shift.');
  const countedCashMinor=Number(body.countedCashMinor);if(!Number.isSafeInteger(countedCashMinor)||countedCashMinor<0)return fail(res,400,'Counted cash must be a non-negative amount in minor currency units.');
  const replay=db.prepare('SELECT id FROM shifts WHERE close_command_id=?').get(body.commandId) as {id:string}|undefined;
  if(replay)return res.json(shiftSummary(replay.id));
  const summary=shiftSummary(routeParam(req,'shiftId'));if(!summary||summary.shift.status!=='open')return fail(res,409,'This shift is not open.');
  const unsettled=db.prepare(`SELECT COUNT(*) AS count FROM orders WHERE tenant_id=? AND outlet_id=? AND created_at>=? AND status IN ('sent','preparing','ready')`)
    .get(DEMO_TENANT,DEMO_OUTLET,summary.shift.openedAt) as {count:number};
  if(unsettled.count>0)return fail(res,409,`Close or cancel ${unsettled.count} open order${unsettled.count===1?'':'s'} before closing the shift.`);
  const closedAt=new Date().toISOString();const varianceMinor=countedCashMinor-summary.expectedCashMinor;
  db.transaction(()=>{
    db.prepare(`UPDATE shifts SET status='closed',closed_at=?,close_command_id=?,counted_cash_minor=?,expected_cash_minor=?,variance_minor=? WHERE id=? AND status='open'`)
      .run(closedAt,body.commandId,countedCashMinor,summary.expectedCashMinor,varianceMinor,routeParam(req,'shiftId'));
    audit('shift',routeParam(req,'shiftId'),'shift.closed',null,{countedCashMinor,expectedCashMinor:summary.expectedCashMinor,varianceMinor},currentStaff(res).userId);
    enqueueSyncEvent('shift',routeParam(req,'shiftId'),'shift.closed',{...summary.shift,status:'closed',closedAt,countedCashMinor,
      expectedCashMinor:summary.expectedCashMinor,varianceMinor,tenantId:DEMO_TENANT,outletId:DEMO_OUTLET,terminalId:DEMO_TERMINAL},closedAt);
  })();
  return res.json(shiftSummary(routeParam(req,'shiftId')));
});
app.post('/api/orders',requireRoles('owner','manager','cashier'),(req:Request,res:Response)=>{
  const body=req.body as Partial<CreateOrderCommand>;
  if(typeof body.commandId!=='string'||body.commandId.length<8)return fail(res,400,'A stable commandId is required for idempotent retries.');
  try{
    const {order,duplicate}=createOrder(body as CreateOrderCommand,currentStaff(res).userId);
    publish(duplicate?'order.updated':'order.created',order);
    if(!duplicate)queuePrint(formatKitchenTicket(order),'KOT');
    return res.status(duplicate?200:201).json(order);
  }catch(error){return fail(res,400,error instanceof Error?error.message:'Unable to create order.');}
});
app.post('/api/orders/:orderId/lines',requireRoles('owner','manager','cashier'),(req,res)=>{
  const body=req.body as Partial<AddOrderLinesCommand>;
  if(typeof body.commandId!=='string'||body.commandId.length<8)return fail(res,400,'A stable commandId is required for idempotent order edits.');
  const before=orderById(routeParam(req,'orderId'));if(!before)return fail(res,404,'Order not found.');
  try{if(editReplay(body.commandId,before.id,'lines_added',{lines:body.lines}))return res.json(before);}catch(error){return fail(res,409,error instanceof Error?error.message:'Invalid idempotency key.');}
  if(before.status==='paid'||before.status==='cancelled')return fail(res,409,'Only unpaid, active orders can be edited.');
  let prepared:PreparedOrderLine[];
  try{prepared=prepareLines(body.lines as OrderLineDraft[]);}catch(error){return fail(res,400,error instanceof Error?error.message:'Invalid order lines.');}
  const timestamp=new Date().toISOString();
  try{
    const duplicate=db.transaction(()=>{
      if(rememberEdit(body.commandId!,before.id,'lines_added',{lines:body.lines},timestamp))return true;
      persistAddedLines(before.id,prepared,timestamp);
      const stations=[...new Set(prepared.map(line=>line.kitchenStation))];
      for(const station of stations)db.prepare("UPDATE kitchen_tickets SET status='new',ready_at=NULL WHERE order_id=? AND station=?").run(before.id,station);
      recalculateOrder(before.id,timestamp);
      refreshOrderKitchenStatus(before.id,timestamp);
      audit('order',before.id,'order.lines_added',null,{commandId:body.commandId,lineIds:prepared.map(line=>line.id),lineCount:prepared.length},currentStaff(res).userId);
      enqueueSyncEvent('order',before.id,'order.lines_added',{...orderById(before.id)!},timestamp);
      return false;
    })();
    const after=orderById(before.id)!;publish('order.updated',after);
    if(!duplicate){const update={...after,lines:after.lines.filter(line=>prepared.some(added=>added.id===line.id))};queuePrint(formatKitchenTicket(update),'KOT update');}
    return res.status(duplicate?200:201).json(after);
  }catch(error){return fail(res,409,error instanceof Error?error.message:'Could not add items to the order.');}
});
app.post('/api/orders/:orderId/lines/:lineId/void',requireRoles('owner','manager'),(req,res)=>{
  const body=req.body as {commandId?:unknown;reason?:unknown};
  if(typeof body.commandId!=='string'||body.commandId.length<8)return fail(res,400,'A stable commandId is required for idempotent voids.');
  if(typeof body.reason!=='string'||body.reason.trim().length<3||body.reason.trim().length>120)return fail(res,400,'Enter a void reason between 3 and 120 characters.');
  const before=orderById(routeParam(req,'orderId'));if(!before)return fail(res,404,'Order not found.');
  const reason=body.reason.trim();
  try{if(editReplay(body.commandId,before.id,'line_voided',{lineId:routeParam(req,'lineId'),reason}))return res.json(before);}catch(error){return fail(res,409,error instanceof Error?error.message:'Invalid idempotency key.');}
  if(before.status==='paid'||before.status==='cancelled')return fail(res,409,'Paid or cancelled orders cannot be voided.');
  const line=before.lines.find(candidate=>candidate.id===routeParam(req,'lineId'));if(!line)return fail(res,404,'Order item not found.');
  if(line.voidedAt)return fail(res,409,'This item is already voided.');
  const timestamp=new Date().toISOString();
  try{
    db.transaction(()=>{
      if(rememberEdit(body.commandId as string,before.id,'line_voided',{lineId:line.id,reason},timestamp))return;
      db.prepare('INSERT INTO order_line_voids(order_line_id,tenant_id,outlet_id,order_id,actor_id,reason,voided_at) VALUES(?,?,?,?,?,?,?)')
        .run(line.id,DEMO_TENANT,DEMO_OUTLET,before.id,currentStaff(res).userId,reason,timestamp);
      recalculateOrder(before.id,timestamp);
      const remaining=Number((db.prepare(`SELECT COUNT(*) AS count FROM order_lines l LEFT JOIN order_line_voids v ON v.order_line_id=l.id
        WHERE l.order_id=? AND v.order_line_id IS NULL`).get(before.id) as {count:number}).count);
      if(!remaining){db.prepare("UPDATE orders SET status='cancelled',updated_at=? WHERE id=?").run(timestamp,before.id);db.prepare("UPDATE kitchen_tickets SET status='voided' WHERE order_id=?").run(before.id);}
      else {
        const stationRemaining=Number((db.prepare(`SELECT COUNT(*) AS count FROM order_lines l LEFT JOIN order_line_voids v ON v.order_line_id=l.id
          WHERE l.order_id=? AND l.kitchen_station=? AND v.order_line_id IS NULL`).get(before.id,line.kitchenStation) as {count:number}).count);
        if(!stationRemaining)db.prepare("UPDATE kitchen_tickets SET status='voided',ready_at=NULL WHERE tenant_id=? AND outlet_id=? AND order_id=? AND station=?")
          .run(DEMO_TENANT,DEMO_OUTLET,before.id,line.kitchenStation);
        refreshOrderKitchenStatus(before.id,timestamp);
      }
      audit('order',before.id,'order.line_voided',reason,{lineId:line.id,itemName:line.name,quantity:line.quantity},currentStaff(res).userId);
      enqueueSyncEvent('order',before.id,'order.line_voided',{...orderById(before.id)!},timestamp);
    })();
    const after=orderById(before.id)!;publish('order.updated',after);
    const voidUpdate={...after,lines:[{...line,voidedAt:timestamp,voidReason:reason}]};queuePrint(formatKitchenTicket(voidUpdate),'KOT void');
    return res.json(after);
  }catch(error){return fail(res,409,error instanceof Error?error.message:'Could not void this item.');}
});
app.post('/api/orders/:orderId/void',requireRoles('owner','manager'),(req,res)=>{
  const body=req.body as {commandId?:unknown;reason?:unknown};
  if(typeof body.commandId!=='string'||body.commandId.length<8)return fail(res,400,'A stable commandId is required for idempotent voids.');
  if(typeof body.reason!=='string'||body.reason.trim().length<3||body.reason.trim().length>120)return fail(res,400,'Enter a void reason between 3 and 120 characters.');
  const before=orderById(routeParam(req,'orderId'));if(!before)return fail(res,404,'Order not found.');
  const reason=body.reason.trim();
  try{if(editReplay(body.commandId,before.id,'order_voided',{reason}))return res.json(before);}catch(error){return fail(res,409,error instanceof Error?error.message:'Invalid idempotency key.');}
  if(before.status==='paid'||before.status==='cancelled')return fail(res,409,'Paid or already cancelled orders cannot be voided.');
  const remaining=before.lines.filter(line=>!line.voidedAt);if(!remaining.length)return fail(res,409,'This order has no active items to void.');
  const timestamp=new Date().toISOString();
  try{
    db.transaction(()=>{
      if(rememberEdit(body.commandId as string,before.id,'order_voided',{reason},timestamp))return;
      const insert=db.prepare('INSERT INTO order_line_voids(order_line_id,tenant_id,outlet_id,order_id,actor_id,reason,voided_at) VALUES(?,?,?,?,?,?,?)');
      for(const line of remaining)insert.run(line.id,DEMO_TENANT,DEMO_OUTLET,before.id,currentStaff(res).userId,reason,timestamp);
      db.prepare("UPDATE orders SET status='cancelled',subtotal_minor=0,tax_total_minor=0,total_minor=0,updated_at=? WHERE id=?").run(timestamp,before.id);
      db.prepare("UPDATE kitchen_tickets SET status='voided' WHERE order_id=?").run(before.id);
      audit('order',before.id,'order.voided',reason,{lineIds:remaining.map(line=>line.id),lineCount:remaining.length},currentStaff(res).userId);
      enqueueSyncEvent('order',before.id,'order.voided',{...orderById(before.id)!},timestamp);
    })();
    const after=orderById(before.id)!;publish('order.updated',after);
    queuePrint(formatKitchenTicket({...after,lines:remaining.map(line=>({...line,voidedAt:timestamp,voidReason:reason}))}),'KOT void');
    return res.json(after);
  }catch(error){return fail(res,409,error instanceof Error?error.message:'Could not void this order.');}
});
app.patch('/api/orders/:orderId/status',requireRoles('owner','manager'),(req,res)=>{
  const nextStatus=(req.body as {status?:OrderStatus}).status;
  const allowed:Record<string,OrderStatus[]>={sent:['preparing','ready'],preparing:['ready']};
  const before=orderById(routeParam(req,'orderId'));if(!before)return fail(res,404,'Order not found.');
  if(!nextStatus||!allowed[before.status]?.includes(nextStatus))return fail(res,409,`Cannot move an order from ${before.status} to ${nextStatus??'unknown'}.`);
  const timestamp=new Date().toISOString();
  const update=db.transaction(()=>{
    db.prepare('UPDATE orders SET status=?,updated_at=? WHERE id=?').run(nextStatus,timestamp,before.id);
    db.prepare('UPDATE kitchen_tickets SET status=?,ready_at=? WHERE order_id=?').run(nextStatus==='ready'?'ready':nextStatus==='preparing'?'preparing':nextStatus==='cancelled'?'voided':'new',nextStatus==='ready'?timestamp:null,before.id);
    audit('order',before.id,`order.${nextStatus}`,null,{},currentStaff(res).userId);
    enqueueSyncEvent('order',before.id,`order.${nextStatus}`,{...orderById(before.id)!},timestamp);
  });update();
  const after=orderById(before.id)!;publish('order.updated',after);return res.json(after);
});
app.post('/api/orders/:orderId/payment',requireRoles('owner','manager','cashier'),(req,res)=>{
  const body=req.body as Partial<PaymentCommand>;
  if(typeof body.commandId!=='string'||body.commandId.length<8)return fail(res,400,'A stable payment commandId is required.');
  const before=orderById(routeParam(req,'orderId'));if(!before)return fail(res,404,'Order not found.');
  const tenders=Array.isArray(body.tenders)?body.tenders:[{method:body.method,amountMinor:body.amountMinor}];
  if(tenders.length<1||tenders.length>3)return fail(res,400,'Choose between one and three tenders.');
  const payments=tenders.map((tender,index)=>({
    commandId:tenders.length===1?body.commandId:`${body.commandId}:${index+1}`,
    method:tender?.method,amountMinor:tender?.amountMinor,
  }));
  if(payments.some(payment=>!payment.method||!(['cash','upi','card'] as const).includes(payment.method)
    ||!Number.isSafeInteger(payment.amountMinor)||Number(payment.amountMinor)<=0))
    return fail(res,400,'Each tender needs a valid method and a positive amount.');
  const dueCommandIds=payments.map(payment=>payment.commandId);
  const duplicateRows=db.prepare(`SELECT command_id,method,amount_minor FROM payment_events WHERE command_id IN (${dueCommandIds.map(()=>'?').join(',')})`)
    .all(...dueCommandIds) as Array<{command_id:string;method:PaymentMethod;amount_minor:number}>;
  if(duplicateRows.length){
    const same=duplicateRows.length===payments.length&&payments.every(payment=>duplicateRows.some(row=>row.command_id===payment.commandId
      &&row.method===payment.method&&Number(row.amount_minor)===payment.amountMinor));
    if(!same)return fail(res,409,'This payment command was already used for different tender amounts.');
    return res.json(before);
  }
  if(before.status==='paid')return fail(res,409,'This order already has a recorded payment.');
  if(before.status==='cancelled')return fail(res,409,'Cancelled orders cannot be paid.');
  if(payments.reduce((sum,payment)=>sum+Number(payment.amountMinor),0)!==before.totalMinor)return fail(res,409,'Tender amounts must add up to the order total.');
  if(typeof body.shiftId!=='string')return fail(res,409,'Open a shift before recording payment.');
  const shift=db.prepare("SELECT id FROM shifts WHERE id=? AND tenant_id=? AND outlet_id=? AND status='open'").get(body.shiftId,DEMO_TENANT,DEMO_OUTLET);
  if(!shift)return fail(res,409,'This payment must be assigned to an open shift.');
  const timestamp=new Date().toISOString();
  const paymentIds=payments.map(()=>createId());
  let invoiceNumber='';
  const pay=db.transaction(()=>{
    invoiceNumber=allocateNumber('invoice','INV');
    const insert=db.prepare('INSERT INTO payment_events(id,command_id,tenant_id,outlet_id,order_id,terminal_id,method,amount_minor,status,shift_id,created_at) VALUES(?,?,?,?,?,?,?,? ,\'succeeded\',?,?)');
    payments.forEach((payment,index)=>{
      const paymentId=paymentIds[index]!;
      insert.run(paymentId,payment.commandId,DEMO_TENANT,DEMO_OUTLET,before.id,DEMO_TERMINAL,payment.method,payment.amountMinor,body.shiftId,timestamp);
      enqueueSyncEvent('payment',paymentId,'payment.recorded',{id:paymentId,commandId:payment.commandId,batchCommandId:body.commandId,orderId:before.id,
        shiftId:body.shiftId,method:payment.method,amountMinor:payment.amountMinor,status:'succeeded',invoiceNumber,createdAt:timestamp,
        tenantId:DEMO_TENANT,outletId:DEMO_OUTLET,terminalId:DEMO_TERMINAL},timestamp);
    });
    const singleMethod=payments.every(payment=>payment.method===payments[0]?.method)?payments[0]?.method:null;
    db.prepare('UPDATE orders SET status=\'paid\',payment_method=?,invoice_number=?,updated_at=? WHERE id=?').run(singleMethod,invoiceNumber,timestamp,before.id);
    audit('order',before.id,'order.payment_recorded',null,{payments:payments.map(({method,amountMinor})=>({method,amountMinor})),invoiceNumber,amountMinor:before.totalMinor,shiftId:body.shiftId},currentStaff(res).userId);
  });pay();
  const order=orderById(before.id)!;publish('order.updated',order);
  queuePrint(formatReceipt(order),'Receipt');
  return res.json(order);
});
app.post('/api/orders/:orderId/refunds',requireRoles('owner','manager'),(req,res)=>{
  const body=req.body as {commandId?:unknown;paymentId?:unknown;shiftId?:unknown;amountMinor?:unknown;reason?:unknown};
  if(typeof body.commandId!=='string'||body.commandId.length<8||body.commandId.length>160)return fail(res,400,'A stable refund commandId is required.');
  if(typeof body.paymentId!=='string'||body.paymentId.length<1||body.paymentId.length>120)return fail(res,400,'Choose the original tender to refund.');
  if(!Number.isSafeInteger(body.amountMinor)||Number(body.amountMinor)<=0)return fail(res,400,'Refund amount must be a positive whole number of minor currency units.');
  if(typeof body.reason!=='string'||body.reason.trim().length<3||body.reason.trim().length>120)return fail(res,400,'Enter a refund reason between 3 and 120 characters.');
  if(typeof body.shiftId!=='string'||body.shiftId.length<1||body.shiftId.length>120)return fail(res,409,'Open a shift before recording a refund.');
  const orderId=routeParam(req,'orderId');
  const before=orderById(orderId);if(!before)return fail(res,404,'Order not found.');
  if(before.status!=='paid')return fail(res,409,'Only paid orders can be refunded.');
  const duplicate=db.prepare(`SELECT id,order_id,refund_of,amount_minor,refund_reason,method,shift_id,created_at
    FROM payment_events WHERE command_id=? AND tenant_id=? AND outlet_id=?`).get(body.commandId,DEMO_TENANT,DEMO_OUTLET) as {
      id:string;order_id:string;refund_of:string|null;amount_minor:number;refund_reason:string|null;method:PaymentMethod;shift_id:string|null;created_at:string
    }|undefined;
  if(duplicate){
    if(duplicate.order_id!==orderId||duplicate.refund_of!==body.paymentId||Number(duplicate.amount_minor)!==body.amountMinor
      ||duplicate.refund_reason!==body.reason.trim()||duplicate.shift_id!==body.shiftId)
      return fail(res,409,'This refund command was already used for different details.');
    return res.json({order:before,refund:{id:duplicate.id,commandId:String(body.commandId),paymentId:duplicate.refund_of,
      shiftId:duplicate.shift_id,method:duplicate.method,amountMinor:Number(duplicate.amount_minor),reason:duplicate.refund_reason,
      status:'succeeded',createdAt:duplicate.created_at}});
  }
  const original=db.prepare(`SELECT id,method,amount_minor FROM payment_events
    WHERE id=? AND tenant_id=? AND outlet_id=? AND order_id=? AND status='succeeded' AND entry_type='tender'`)
    .get(body.paymentId,DEMO_TENANT,DEMO_OUTLET,orderId) as {id:string;method:PaymentMethod;amount_minor:number}|undefined;
  if(!original)return fail(res,404,'Original successful tender not found for this order.');
  const shift=db.prepare("SELECT id FROM shifts WHERE id=? AND tenant_id=? AND outlet_id=? AND status='open'")
    .get(body.shiftId,DEMO_TENANT,DEMO_OUTLET);
  if(!shift)return fail(res,409,'Refunds must be assigned to an open shift.');
  const refunded=db.prepare(`SELECT COALESCE(SUM(amount_minor),0) AS amount_minor FROM payment_events
    WHERE tenant_id=? AND outlet_id=? AND refund_of=? AND status='succeeded' AND entry_type='refund'`)
    .get(DEMO_TENANT,DEMO_OUTLET,original.id) as {amount_minor:number};
  if(Number(body.amountMinor)>Number(original.amount_minor)-Number(refunded.amount_minor))return fail(res,409,'Refund exceeds the remaining refundable amount for this tender.');
  const timestamp=new Date().toISOString();const refundId=createId();const actor=currentStaff(res);
  const refund={id:refundId,commandId:body.commandId,paymentId:original.id,shiftId:String(body.shiftId),method:original.method,
    amountMinor:Number(body.amountMinor),reason:body.reason.trim(),status:'succeeded',createdAt:timestamp};
  const record=db.transaction(()=>{
    db.prepare(`INSERT INTO payment_events(id,command_id,tenant_id,outlet_id,order_id,terminal_id,method,amount_minor,status,shift_id,entry_type,refund_of,refund_reason,created_at)
      VALUES(?,?,?,?,?,?,?,?,'succeeded',?,'refund',?,?,?)`).run(refundId,body.commandId,DEMO_TENANT,DEMO_OUTLET,orderId,DEMO_TERMINAL,
      original.method,body.amountMinor,body.shiftId,original.id,refund.reason,timestamp);
    audit('payment',refundId,'payment.refunded',refund.reason,{...refund,tenantId:DEMO_TENANT,outletId:DEMO_OUTLET,terminalId:DEMO_TERMINAL},actor.userId);
    enqueueSyncEvent('payment',refundId,'payment.refunded',{...refund,tenantId:DEMO_TENANT,outletId:DEMO_OUTLET,terminalId:DEMO_TERMINAL},timestamp);
  });
  try{record();}catch(error){if(error instanceof Error&&/UNIQUE constraint failed: payment_events.command_id/.test(error.message))return fail(res,409,'This refund command was already used. Retry with its original details.');throw error;}
  return res.status(201).json({order:before,refund});
});
app.post('/api/printer/test',requireRoles('owner','manager'),(_req,res)=>{
  const printer=printerStatus();
  if(printer.mode==='disabled')return fail(res,503,'Printer output is disabled on this edge.');
  const sample:KitchenOrder={id:'sample',orderNumber:'J-ORD-000001',orderType:'takeaway',tableLabel:null,status:'sent',note:'Printer connection check',createdAt:new Date().toISOString(),lines:[]};
  void sendToPrinter(formatKitchenTicket(sample)).catch(error=>console.error('Printer test failed:',error));
  return res.json({status:'queued',...printer});
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
  const origin=request.headers.origin;
  if(origin){try{if(new URL(origin).host!==request.headers.host){socket.destroy();return;}}catch{socket.destroy();return;}}
  const session=readStaffSessionCookie(request.headers.cookie);
  if(!session){socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');socket.destroy();return;}
  if(session.role==='viewer'){socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();return;}
  (request as typeof request & {staffRole?:string}).staffRole=session.role;
  wss.handleUpgrade(request,socket,head,webSocket=>wss.emit('connection',webSocket,request));
});
wss.on('connection',(webSocket,request)=>{
  const role=(request as typeof request & {staffRole?:string}).staffRole;
  socketRoles.set(webSocket,role??'');
  webSocket.send(JSON.stringify({type:'kitchen.snapshot',payload:kitchenSnapshot()} satisfies ServerMessage));
});

const printer=startPrinterAdapter();
const stopSyncWorker=startSyncWorker();
httpServer.listen(port,'0.0.0.0',()=>console.log(`🍽️  Common Table edge server listening on http://0.0.0.0:${port}`));
function shutdown(){httpServer.close();wss.close();printer?.close();stopSyncWorker();db.close();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
