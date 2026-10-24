import type { CreateOrderCommand } from '@common-table/contracts';

export interface QueuedOrder {
  command: CreateOrderCommand;
  queuedAt: string;
}

const DB_NAME='common-table-offline';
const STORE='order-outbox';

function openOfflineDb():Promise<IDBDatabase>{
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(DB_NAME,1);
    request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains(STORE))request.result.createObjectStore(STORE,{keyPath:'command.commandId'});};
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
}
export async function listQueuedOrders():Promise<QueuedOrder[]>{
  const db=await openOfflineDb();const rows=await new Promise<QueuedOrder[]>((resolve,reject)=>{const request=db.transaction(STORE,'readonly').objectStore(STORE).getAll();request.onsuccess=()=>resolve(request.result as QueuedOrder[]);request.onerror=()=>reject(request.error);});db.close();return rows.sort((a,b)=>a.queuedAt.localeCompare(b.queuedAt));
}
export async function queueOrder(command:CreateOrderCommand):Promise<void>{
  const db=await openOfflineDb();await new Promise<void>((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).put({command,queuedAt:new Date().toISOString()} satisfies QueuedOrder);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});db.close();
}
export async function removeQueuedOrder(commandId:string):Promise<void>{
  const db=await openOfflineDb();await new Promise<void>((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).delete(commandId);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});db.close();
}
