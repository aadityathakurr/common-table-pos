// WebSocket fan-out for order and kitchen updates.
import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { ServerMessage } from '@common-table/contracts';
import { readStaffSessionCookie } from './auth.js';
import { kitchenSnapshot } from './core.js';

export const wss=new WebSocketServer({noServer:true});
const socketRoles=new WeakMap<WebSocket,string>();
export function publish(type:ServerMessage['type'],payload:ServerMessage['payload']){
  const message=JSON.stringify({type,payload} satisfies ServerMessage);
  for(const client of wss.clients)if(client.readyState===WebSocket.OPEN){
    if(socketRoles.get(client)==='kitchen')client.send(JSON.stringify({type:'kitchen.snapshot',payload:kitchenSnapshot()} satisfies ServerMessage));
    else client.send(message);
  }
}
export function attachRealtime(httpServer:Server){
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
}
