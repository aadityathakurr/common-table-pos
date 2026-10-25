import { acknowledgeSyncEvents, failSyncEvents, pendingSyncEvents, syncOutboxStatus } from './database.js';
import { SYNC_CONFIG } from './config.js';

let sending = false;
let interval: NodeJS.Timeout | undefined;
let lastError: string | null = null;

export function getSyncStatus(){
  const stats=syncOutboxStatus();
  return {configured:Boolean(SYNC_CONFIG.url&&SYNC_CONFIG.terminalKey),pending:stats.pending,failed:stats.failed,
    lastSyncedAt:stats.lastSyncedAt,lastError};
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
  interval=setInterval(()=>void syncOnce(),5_000);
  return ()=>{if(interval)clearInterval(interval);};
}
