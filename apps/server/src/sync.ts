import { acknowledgeSyncEvents, applyManagedMenuSnapshot, failSyncEvents, managedMenuSyncState, markManagedMenuChecked, pendingSyncEvents, recordManagedMenuSyncError, syncOutboxStatus, type ManagedInventoryItem, type ManagedInventoryRecipe, type ManagedMenuSnapshotItem, type ManagedOutletLayout } from './database.js';
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
    &&(item.taxCode===undefined||item.taxCode===null||(typeof item.taxCode==='string'&&item.taxCode.trim().length>0&&item.taxCode.length<=30&&!/[\u0000-\u001f\u007f]/.test(item.taxCode)))
    &&(item.taxRateBps===undefined||item.taxRateBps===null||(Number.isSafeInteger(item.taxRateBps)&&Number(item.taxRateBps)>=0&&Number(item.taxRateBps)<=10_000))
    &&Array.isArray(item.modifiers)&&item.modifiers.length<=32&&item.modifiers.every(modifier=>{
      if(!modifier||typeof modifier!=='object'||Array.isArray(modifier))return false;
      const row=modifier as Record<string,unknown>;
      return typeof row.id==='string'&&row.id.length>0&&row.id.length<=120
        &&typeof row.group==='string'&&row.group.length>0&&row.group.length<=80
        &&typeof row.name==='string'&&row.name.length>0&&row.name.length<=120
        &&Number.isSafeInteger(row.priceDeltaMinor)&&Number(row.priceDeltaMinor)>=0;
    });
}

function validOutletLayout(value:unknown):value is ManagedOutletLayout{
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const layout=value as Record<string,unknown>;
  if(!Array.isArray(layout.areas)||layout.areas.length>100||!Array.isArray(layout.stations)||layout.stations.length>100)return false;
  const areaIds=new Set<string>();const areaNames=new Set<string>();const tableIds=new Set<string>();const tableNames=new Set<string>();
  let tableCount=0;
  const validLabel=(label:string,max:number)=>label.trim().length>0&&label.length<=max&&!/[\u0000-\u001f\u007f]/.test(label);
  for(const candidate of layout.areas){
    if(!candidate||typeof candidate!=='object'||Array.isArray(candidate))return false;
    const area=candidate as Record<string,unknown>;
    if(typeof area.id!=='string'||!area.id.trim()||area.id.length>120||areaIds.has(area.id)
      ||typeof area.name!=='string'||!validLabel(area.name,80)||areaNames.has(area.name)
      ||!Number.isSafeInteger(area.sortOrder)||Number(area.sortOrder)<0||!Array.isArray(area.tables))return false;
    areaIds.add(area.id);areaNames.add(area.name);tableCount+=area.tables.length;
    if(tableCount>500)return false;
    for(const row of area.tables){
      if(!row||typeof row!=='object'||Array.isArray(row))return false;
      const table=row as Record<string,unknown>;
      if(typeof table.id!=='string'||!table.id.trim()||table.id.length>120||tableIds.has(table.id)
        ||typeof table.name!=='string'||!validLabel(table.name,40)||tableNames.has(table.name)
        ||!Number.isSafeInteger(table.capacity)||Number(table.capacity)<1||Number(table.capacity)>50
        ||!Number.isSafeInteger(table.sortOrder)||Number(table.sortOrder)<0)return false;
      tableIds.add(table.id);tableNames.add(table.name);
    }
  }
  const stationIds=new Set<string>();const stationNames=new Set<string>();
  for(const row of layout.stations){
    if(!row||typeof row!=='object'||Array.isArray(row))return false;
    const station=row as Record<string,unknown>;
    if(typeof station.id!=='string'||!station.id.trim()||station.id.length>120||stationIds.has(station.id)
      ||typeof station.name!=='string'||!validLabel(station.name,80)||stationNames.has(station.name)
      ||!Number.isSafeInteger(station.sortOrder)||Number(station.sortOrder)<0)return false;
    stationIds.add(station.id);stationNames.add(station.name);
  }
  return true;
}

function validInventorySnapshot(items:unknown,recipes:unknown,menuItems:ManagedMenuSnapshotItem[]):items is ManagedInventoryItem[]{
  if(!Array.isArray(items)||items.length>20000||!Array.isArray(recipes)||recipes.length>50000)return false;
  const inventoryIds=new Set<string>();
  for(const value of items){
    if(!value||typeof value!=='object'||Array.isArray(value))return false;
    const row=value as Record<string,unknown>;
    if(typeof row.id!=='string'||!row.id.trim()||row.id.length>120||inventoryIds.has(row.id)
      ||typeof row.name!=='string'||!row.name.trim()||row.name.length>120||/[\u0000-\u001f\u007f]/.test(row.name)
      ||!['each','g','kg','ml','l','portion','pack'].includes(String(row.unit))
      ||!Number.isFinite(Number(row.reorderLevel))||Number(row.reorderLevel)<0||Number(row.reorderLevel)>1_000_000_000
      ||!Number.isFinite(Number(row.onHand))||Math.abs(Number(row.onHand))>1_000_000_000||typeof row.active!=='boolean')return false;
    inventoryIds.add(row.id);
  }
  const menuIds=new Set(menuItems.map(item=>item.id));const seen=new Set<string>();
  for(const value of recipes){
    if(!value||typeof value!=='object'||Array.isArray(value))return false;
    const row=value as Record<string,unknown>;const pair=`${String(row.menuItemId)}:${String(row.inventoryItemId)}`;
    if(typeof row.menuItemId!=='string'||!menuIds.has(row.menuItemId)||typeof row.inventoryItemId!=='string'
      ||!inventoryIds.has(row.inventoryItemId)||seen.has(pair)||!Number.isFinite(Number(row.quantityPerSale))
      ||Number(row.quantityPerSale)<=0||Number(row.quantityPerSale)>1_000_000_000
      ||Math.round(Number(row.quantityPerSale)*1000)!==Number(row.quantityPerSale)*1000)return false;
    seen.add(pair);
  }
  return true;
}

export function getSyncStatus(){
  const stats=syncOutboxStatus();
  return {configured:Boolean(SYNC_CONFIG.url&&SYNC_CONFIG.terminalKey),pending:stats.pending,failed:stats.failed,
    lastSyncedAt:stats.lastSyncedAt,lastError,menu:{...managedMenuSyncState(),lastError:menuError??managedMenuSyncState()?.lastError??null}};
}

export async function syncMenuOnce():Promise<boolean>{
  if(menuSending||sending||!SYNC_CONFIG.url||!SYNC_CONFIG.terminalKey)return false;
  menuSending=true;
  const previous=managedMenuSyncState();
  try{
    const response=await fetch(SYNC_CONFIG.url,{method:'GET',headers:{'x-pos-terminal-key':SYNC_CONFIG.terminalKey,
      ...(previous?.version?{'if-none-match':`"${previous.version}"`}:{})},signal:AbortSignal.timeout(15_000)});
    if(response.status===304){
      if(!previous)throw new Error('The menu sync server returned an unexpected unchanged response.');
      markManagedMenuChecked(previous.version);
      menuError=null;
      return true;
    }
    const result=await response.json().catch(()=>({})) as {tenantId?:unknown;outletId?:unknown;version?:unknown;outletConfig?:unknown;items?:unknown;inventoryItems?:unknown;recipes?:unknown;layout?:unknown;error?:unknown};
    if(!response.ok)throw new Error(typeof result.error==='string'?result.error:`Menu sync returned HTTP ${response.status}.`);
    if(result.tenantId!==EDGE_CONFIG.tenantId||result.outletId!==EDGE_CONFIG.outletId)
      throw new Error('The cloud menu belongs to a different outlet.');
    const outletConfig=parseOutletRuntimeSettings(result.outletConfig);
    if(typeof result.version!=='string'||!/^[0-9a-f]{64}$/.test(result.version)||!Array.isArray(result.items)||!validOutletLayout(result.layout)
      ||result.items.length>5000||!result.items.every(validMenuItem))throw new Error('The cloud returned an invalid menu snapshot.');
    const ids=new Set((result.items as ManagedMenuSnapshotItem[]).map(item=>item.id));
    if(ids.size!==(result.items as ManagedMenuSnapshotItem[]).length)throw new Error('The cloud menu contains duplicate item IDs.');
    if(!validInventorySnapshot(result.inventoryItems,result.recipes,result.items as ManagedMenuSnapshotItem[]))throw new Error('The cloud returned an invalid inventory recipe snapshot.');
    applyManagedMenuSnapshot(result.version,result.items as ManagedMenuSnapshotItem[],result.inventoryItems as ManagedInventoryItem[],
      result.recipes as ManagedInventoryRecipe[],outletConfig,result.layout);
    menuError=null;
    console.log(JSON.stringify({level:'info',event:'menu.sync_succeeded',count:result.items.length,version:result.version}));
    return true;
  }catch(error){
    menuError=error instanceof Error?error.message:'Menu sync failed.';
    recordManagedMenuSyncError(menuError);
    console.error(JSON.stringify({level:'warn',event:'menu.sync_failed',reason:menuError}));
    return false;
  }finally{menuSending=false;}
}

async function syncOnce():Promise<void>{
  if(sending||menuSending||!SYNC_CONFIG.url||!SYNC_CONFIG.terminalKey)return;
  const events=pendingSyncEvents(50);if(!events.length)return;
  sending=true;
  const ids=events.map(event=>event.eventId);
  try{
    const response=await fetch(SYNC_CONFIG.url,{method:'POST',headers:{'content-type':'application/json','x-pos-terminal-key':SYNC_CONFIG.terminalKey},
      body:JSON.stringify({events:events.map(({attemptCount:_,...event})=>event)}),signal:AbortSignal.timeout(15_000)});
    const result=await response.json().catch(()=>({})) as {acceptedEventIds?:unknown;rejectedEvents?:unknown;error?:unknown};
    if(!response.ok)throw new Error(typeof result.error==='string'?result.error:`Sync endpoint returned HTTP ${response.status}.`);
    if(!Array.isArray(result.acceptedEventIds)||result.acceptedEventIds.some(id=>typeof id!=='string'||!ids.includes(id)))
      throw new Error('Sync acknowledgement did not match the submitted events.');
    const accepted=new Set(result.acceptedEventIds as string[]);
    const acknowledged=ids.filter(id=>accepted.has(id));
    acknowledgeSyncEvents(acknowledged);
    const reported=Array.isArray(result.rejectedEvents)?result.rejectedEvents.filter(value=>value&&typeof value==='object'&&!Array.isArray(value)) as Array<{eventId?:unknown;code?:unknown}>:[];
    const rejectionById=new Map(reported.filter(value=>typeof value.eventId==='string'&&ids.includes(value.eventId)&&!accepted.has(value.eventId))
      .map(value=>[value.eventId as string,value]));
    const rejected=ids.filter(id=>!accepted.has(id));
    for(const eventId of rejected){
      const event=events.find(candidate=>candidate.eventId===eventId);
      const rejection=rejectionById.get(eventId);
      const staleCount=event?.action==='inventory.count_adjustment'&&rejection?.code==='40001';
      failSyncEvents([eventId],staleCount?'Stock changed after this count began. Refresh inventory and count again.':'The cloud rejected this event. Check the local record and retry after resolving the issue.',Boolean(staleCount));
    }
    if(rejected.length)lastError=`${rejected.length} event(s) need review.`;
    else lastError=null;
    console.log(JSON.stringify({level:rejected.length?'warn':'info',event:rejected.length?'sync.batch_completed_with_rejections':'sync.batch_succeeded',
      accepted:acknowledged.length,rejected:rejected.length}));
  }catch(error){
    lastError=error instanceof Error?error.message:'Cloud sync failed.';
    failSyncEvents(ids,lastError);
    console.error(JSON.stringify({level:'warn',event:'sync.batch_failed',count:ids.length,reason:lastError}));
  }finally{sending=false;}
}

export function startSyncWorker():()=>Promise<void>{
  if(!SYNC_CONFIG.url||!SYNC_CONFIG.terminalKey){
    console.log(JSON.stringify({level:'info',event:'sync.disabled',reason:'POS_SYNC_URL or POS_TERMINAL_KEY is not configured.'}));
    return async()=>undefined;
  }
  let stopped=false;
  const inFlight=new Set<Promise<unknown>>();
  const track=<T>(task:Promise<T>):Promise<T>=>{
    inFlight.add(task);
    void task.then(()=>inFlight.delete(task),()=>inFlight.delete(task));
    return task;
  };
  const refreshMenu=()=>stopped?undefined:track(syncMenuOnce());
  const flushOutbox=()=>stopped?undefined:track(syncOnce());
  // Fetch the current menu baseline first. If pending outbox events exist,
  // starting both workers at once lets syncOnce grab the lock and silently
  // skip the startup menu refresh until the 30 second interval.
  const initialMenuSync=refreshMenu();
  if(initialMenuSync)void initialMenuSync.then(()=>{if(!stopped)flushOutbox();}).catch(error=>{
    console.error(JSON.stringify({level:'error',event:'sync.startup_failed',reason:error instanceof Error?error.message:'unknown'}));
  });
  interval=setInterval(()=>{void flushOutbox()?.catch(error=>console.error(JSON.stringify({level:'error',event:'sync.worker_failed',reason:error instanceof Error?error.message:'unknown'})));},5_000);
  menuInterval=setInterval(()=>{void refreshMenu()?.catch(error=>console.error(JSON.stringify({level:'error',event:'menu.sync_worker_failed',reason:error instanceof Error?error.message:'unknown'})));},30_000);
  return async()=>{
    stopped=true;
    if(interval)clearInterval(interval);
    if(menuInterval)clearInterval(menuInterval);
    await Promise.allSettled([...inFlight]);
  };
}
