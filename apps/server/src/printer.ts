import net, { type AddressInfo } from 'node:net';
import type { KitchenOrder, OrderRecord } from '@common-table/contracts';
import { EDGE_CONFIG } from './config.js';

const ESC = 0x1b;
const GS = 0x1d;
const WIDTH = 48;
const printerHost = process.env.MOCK_PRINTER_HOST ?? '127.0.0.1';
const printerPort = Number(process.env.MOCK_PRINTER_PORT ?? 9100);

function line(char='-'): string { return char.repeat(WIDTH); }
function columns(left: string, right: string): string {
  const a = left.slice(0, Math.max(0, WIDTH-right.length-1));
  return `${a}${' '.repeat(Math.max(1,WIDTH-a.length-right.length))}${right}`;
}
function wrap(text: string, width=WIDTH): string[] {
  const words=text.trim().split(/\s+/);const rows:string[]=[];let row='';
  for(const word of words){if(!word)continue;if((row?row.length+1:0)+word.length>width){if(row)rows.push(row);row=word;}else row=row?`${row} ${word}`:word;}
  if(row)rows.push(row);return rows.length?rows:[''];
}
function command(...bytes: number[]): Buffer { return Buffer.from(bytes); }
function text(value: string): Buffer { return Buffer.from(value.replace(/[^\x20-\x7E\n\r]/g,'?'),'ascii'); }
function money(minor: number): string { return `Rs ${(minor/100).toFixed(2)}`; }
function readableReceipt(raw:Buffer):string{
  return raw.toString('latin1')
    .replace(/\x1b\x40|\x1b[\x61\x45][\s\S]/g,'')
    .replace(/\x1d\x56[\s\S]{2}/g,'')
    .replace(/[\x00-\x08\x0B-\x1F]/g,'');
}

export function formatKitchenTicket(order: KitchenOrder): Buffer {
  const parts:Buffer[]=[command(ESC,0x40),command(ESC,0x61,1),command(ESC,0x45,1),text(`${EDGE_CONFIG.tenantName}\n${EDGE_CONFIG.outletName}\n`),command(ESC,0x45,0),
    text('KITCHEN ORDER\n'),command(ESC,0x61,0),text(line('=')+'\n'),text(columns('ORDER',order.orderNumber)+'\n'),
    text(columns(order.orderType==='dine_in'?(order.tableLabel??'DINE IN'):'TAKEAWAY',new Date(order.createdAt).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}))+'\n'),text(line()+'\n')];
  for(const item of order.lines){parts.push(command(ESC,0x45,1),text(`${item.quantity} x ${item.name}\n`),command(ESC,0x45,0));for(const modifier of item.modifiers)parts.push(text(`    + ${modifier.name}${modifier.priceDeltaMinor?` (${money(modifier.priceDeltaMinor)})`:''}\n`));for(const row of wrap(item.note??''))if(row)parts.push(text(`    ${row}\n`));}
  if(order.note)parts.push(text(line()+ '\n'),text('NOTE: '+wrap(order.note).join('\n')+'\n'));
  parts.push(text(line('=')+'\n\n'),command(GS,0x56,0x41,0x03));
  return Buffer.concat(parts);
}

export function formatReceipt(order: OrderRecord): Buffer {
  const parts:Buffer[]=[command(ESC,0x40),command(ESC,0x61,1),command(ESC,0x45,1),text(`${EDGE_CONFIG.tenantName}\n${EDGE_CONFIG.outletName}\n`),command(ESC,0x45,0),
    text(`${EDGE_CONFIG.locationLabel}\n`),text(line('=')+'\n'),text(`INVOICE  ${order.invoiceNumber??'PENDING'}\n`),
    text(`ORDER    ${order.orderNumber}\n`),text(`${new Date(order.createdAt).toLocaleString('en-IN')}\n`),
    text(`${order.orderType==='dine_in'?(order.tableLabel??'Dine in'):'Takeaway'} - ${order.guestCount} guest(s)\n`),text(line()+'\n')];
  for(const item of order.lines){parts.push(text(columns(`${item.quantity} x ${item.name}`,money(item.lineTotalMinor))+'\n'));for(const modifier of item.modifiers)parts.push(text(`  + ${modifier.name}${modifier.priceDeltaMinor?` (${money(modifier.priceDeltaMinor)})`:''}\n`));}
  parts.push(text(line()+'\n'),text(columns('Subtotal',money(order.subtotalMinor))+'\n'),
    text(columns(`Tax (demo ${order.taxRateBps/100}%)`,money(order.taxTotalMinor))+'\n'),
    command(ESC,0x45,1),text(columns('TOTAL',money(order.totalMinor))+'\n'),command(ESC,0x45,0),
    text(columns(`Paid - ${(order.paymentMethod??'cash').toUpperCase()}`,money(order.totalMinor))+'\n'),text(line('=')+'\n'),
    command(ESC,0x61,1),text('Thank you. See you again!\n\n'),command(GS,0x56,0x41,0x03));
  return Buffer.concat(parts);
}

export function startMockPrinter(): net.Server {
  const server=net.createServer(socket=>{
    const buffers:Buffer[]=[];socket.on('data',chunk=>buffers.push(chunk));socket.on('end',()=>{
      const raw=Buffer.concat(buffers);const printable=readableReceipt(raw);
      console.log(`\n🖨  MOCK 80mm ESC/POS PRINTER · ${raw.length} bytes\n${printable}\n--- paper cut ---\n`);
      socket.end('OK');
    });
  });
  server.on('error',error=>console.error('Mock printer socket error:',error));
  server.listen(printerPort,printerHost,()=>{const addr=server.address() as AddressInfo;console.log(`🖨  Mock ESC/POS printer listening on ${addr.address}:${addr.port}`);});
  return server;
}

export function sendToMockPrinter(payload: Buffer): Promise<void> {
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection({host:printerHost,port:printerPort});
    socket.setTimeout(2500);
    socket.on('data',()=>undefined);
    socket.once('connect',()=>{socket.end(payload);});
    socket.once('end',resolve);
    socket.once('error',reject);
    socket.once('timeout',()=>socket.destroy(new Error('Mock printer timed out')));
  });
}
