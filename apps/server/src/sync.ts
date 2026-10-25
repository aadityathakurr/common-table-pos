import { acknowledgeSyncEvents, applyManagedMenuSnapshot, failSyncEvents, managedMenuSyncState, markManagedMenuChecked, pendingSyncEvents, recordManagedMenuSyncError, syncOutboxStatus, type ManagedMenuSnapshotItem } from './database.js';
import { EDGE_CONFIG, parseOutletRuntimeSettings, SYNC_CONFIG } from './config.js';

let sending = false;
let interval: NodeJS.Timeout | undefined;
let menuInterval: NodeJS.Timeout | undefined;
let lastError: string | null = null;
let menuSending = false;
let menuError: string | null = null;

function validMenuItem(value:unknown):value is ManagedMenuSnapshotItem{
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const item=value as Record<string,unknown>;
  return typeof item.id==='string'&&item.id.length>0&&item.id.length<=120
    &&typeof item.name==='string'&&item.name.trim().length>0&&item.name.length<=120
    &&typeof item.category==='string'&&item.category.trim().length>0&&item.category.length<=80
    &&Number.isSafeInteger(item.priceMinor)&&Number(item.priceMinor)>=0&&Number(item.priceMinor)<=100_000_000
    &&typeof item.emoji==='string'&&item.emoji.length<=32&&typeof item.color==='string'&&/^#[0-9a-f]{6}$/i.test(item.color)
    &&(item.tag===null||typeof item.tag==='string')&&typeof item.vegetarian==='boolean'&&typeof item.available==='boolean'
    &&typeof item.kitchenStation==='string'&&item.kitchenStation.trim().length>0&&item.kitchenStation.length<=80
    &&Array.isArray(item.modifiers)&&item.modifiers.length<=32&&item.modifiers.every(modifier=>{
      if(!modifier||typeof modifier!=='object'||Array.isArray(modifier))return false;
      const row=modifier as Record<string,unknown>;
      return typeof row.id==='string'&&row.id.length>0&&row.id.length<=120
        &&typeof row.group==='string'&&row.group.length>0&&row.group.length<=80
        &&typeof row.name==='string'&&row.name.length>0&&row.name.length<=120
        &&Number.isSafeInteger(row.priceDeltaMinor)&&Number(row.priceDeltaMinor)>=0;
    });
}

export function getSyncStatus(){
  const stats=syncOutboxStatus();
  return {configured:Boolean(SYNC_CONFIG.url&&SYNC_CONFIG.terminalKey),pending:stats.pending,failed:stats.failed,
    lastSyncedAt:stats.lastSyncedAt,lastError,menu:{...managedMenuSyncState(),lastError:menuError??managedMenuSyncState()?.lastError??null}};
}

export async function syncMenuOnce():Promise<void>{
  if(menuSending||!SYNC_CONFIG.url||!SYNC_CONFIG.terminalKey)return;
  menuSending=true;
  const previous=managedMenuSyncState();
  try{
    const response=await fetch(SYNC_CONFIG.url,{method:'GET',headers:{'x-pos-terminal-key':SYNC_CONFIG.terminalKey,
      ...(previous?.version?{'if-none-match':`"${previous.version}"`}:{})},signal:AbortSignal.timeout(15_000)});
    if(response.status===304){
      if(!previous)throw new Error('The menu sync server returned an unexpected unchanged response.');
      markManagedMenuChecked(previous.version);
      menuError=null;
      return;
    }
    const result=await response.json().catch(()=>({})) as {tenantId?:unknown;outletId?:unknown;version?:unknown;outletConfig?:unknown;items?:unknown;error?:unknown};
    if(!response.ok)throw new Error(typeof result.error==='string'?result.error:`Menu sync returned HTTP ${response.status}.`);
    if(result.tenantId!==EDGE_CONFIG.tenantId||result.outletId!==EDGE_CONFIG.outletId)
      throw new Error('The cloud menu belongs to a different outlet.');
    const outletConfig=parseOutletRuntimeSettings(result.outletConfig);
    if(typeof result.version!=='string'||!/^[0-9a-f]{64}$/.test(result.version)||!Array.isArray(result.items)
      ||result.items.length>5000||!result.items.every(validMenuItem))throw new Error('The cloud returned an invalid menu snapshot.');
    const ids=new Set((result.items as ManagedMenuSnapshotItem[]).map(item=>item.id));
    if(ids.size!==(result.items as ManagedMenuSnapshotItem[]).length)throw new Error('The cloud menu contains duplicate item IDs.');
    applyManagedMenuSnapshot(result.version,result.items as ManagedMenuSnapshotItem[],outletConfig);
    menuError=null;
    console.log(JSON.stringify({level:'info',event:'menu.sync_succeeded',count:result.items.length,version:result.version}));
  }catch(error){
    menuError=error instanceof Error?error.message:'Menu sync failed.';
    recordManagedMenuSyncError(menuError);
    console.error(JSON.stringify({level:'warn',event:'menu.sync_failed',reason:menuError}));
  }finally{menuSending=false;}
}

async function syncOnce():Promise<void>{
  if(sending||!SYNC_CONFIG.url||!SYNC_CONFIG.terminalKey)return;
  const events=pendingSyncEvents(50);if(!events.length)return;
  sending=true;
  const ids=events.map(event=>event.eventId);
  try{
    const response=await fetch(SYNC_CONFIG.url,{method:'POST',headers:{'content-type':'application/json','x-pos-terminal-key':SYNC_CONFIG.terminalKey},
      body:JSON.stringify({events:events.map(({attemptCount:_,...event})=>event)}),signal:AbortSignal.timeout(15_000)});
    const result=await response.json().catch(()=>({})) as {acceptedEventIds?:unknown;error?:unknown};
    if(!response.ok)throw new Error(typeof result.error==='string'?result.error:`Sync endpoint returned HTTP ${response.status}.`);
    if(!Array.isArray(result.acceptedEventIds)||result.acceptedEventIds.some(id=>typeof id!=='string'||!ids.includes(id)))
      throw new Error('Sync acknowledgement did not match the submitted events.');
    const accepted=new Set(result.acceptedEventIds as string[]);
    const acknowledged=ids.filter(id=>accepted.has(id));
    acknowledgeSyncEvents(acknowledged);
    const rejected=ids.filter(id=>!accepted.has(id));
    if(rejected.length){failSyncEvents(rejected,'The cloud did not acknowledge this event.');throw new Error(`${rejected.length} event(s) were not acknowledged.`);}
    lastError=null;
    console.log(JSON.stringify({level:'info',event:'sync.batch_succeeded',count:acknowledged.length}));
  }catch(error){
    lastError=error instanceof Error?error.message:'Cloud sync failed.';
    failSyncEvents(ids,lastError);
    console.error(JSON.stringify({level:'warn',event:'sync.batch_failed',count:ids.length,reason:lastError}));
  }finally{sending=false;}
}

export function startSyncWorker():()=>void{
  if(!SYNC_CONFIG.url||!SYNC_CONFIG.terminalKey){
    console.log(JSON.stringify({level:'info',event:'sync.disabled',reason:'POS_SYNC_URL or POS_TERMINAL_KEY is not configured.'}));
    return ()=>undefined;
  }
  void syncOnce();
  void syncMenuOnce();
  interval=setInterval(()=>void syncOnce(),5_000);
  menuInterval=setInterval(()=>void syncMenuOnce(),30_000);
  return ()=>{if(interval)clearInterval(interval);if(menuInterval)clearInterval(menuInterval);};
}
