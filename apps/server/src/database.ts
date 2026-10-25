import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DEMO_MENU, type MenuItem } from '@common-table/contracts';
import { applyOutletRuntimeSettings, EDGE_CONFIG, type OutletRuntimeSettings } from './config.js';

const here = dirname(fileURLToPath(import.meta.url));
const databasePath = resolve(process.env.POS_DATABASE_PATH ?? '.data/common-table.db');
mkdirSync(dirname(databasePath), { recursive: true });

export const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = FULL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.exec(readFileSync(resolve(here, 'schema.sql'), 'utf8'));
const outletColumns = db.pragma('table_info(outlets)') as Array<{ name: string }>;
if (!outletColumns.some(column => column.name === 'tax_rate_bps')) {
  db.exec('ALTER TABLE outlets ADD COLUMN tax_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK(tax_rate_bps BETWEEN 0 AND 10000)');
  db.prepare('UPDATE outlets SET tax_rate_bps=? WHERE id=? AND tenant_id=?').run(EDGE_CONFIG.taxRateBps, EDGE_CONFIG.outletId, EDGE_CONFIG.tenantId);
}
const paymentColumns = db.pragma('table_info(payment_events)') as Array<{ name: string }>;
if (!paymentColumns.some(column => column.name === 'shift_id')) db.exec('ALTER TABLE payment_events ADD COLUMN shift_id TEXT REFERENCES shifts(id)');
if (!paymentColumns.some(column => column.name === 'entry_type')) db.exec("ALTER TABLE payment_events ADD COLUMN entry_type TEXT NOT NULL DEFAULT 'tender'");
if (!paymentColumns.some(column => column.name === 'refund_of')) db.exec('ALTER TABLE payment_events ADD COLUMN refund_of TEXT');
if (!paymentColumns.some(column => column.name === 'refund_reason')) db.exec('ALTER TABLE payment_events ADD COLUMN refund_reason TEXT');
db.exec('CREATE INDEX IF NOT EXISTS payments_by_shift ON payment_events(tenant_id,outlet_id,shift_id,method,status)');
db.exec('CREATE INDEX IF NOT EXISTS payments_by_refund ON payment_events(tenant_id,outlet_id,refund_of,status)');

export const DEMO_TENANT = EDGE_CONFIG.tenantId;
export const DEMO_OUTLET = EDGE_CONFIG.outletId;
export const DEMO_TERMINAL = EDGE_CONFIG.terminalId;
export const DEMO_ACTOR = EDGE_CONFIG.actorId;

const seed = db.transaction(() => {
  db.prepare('INSERT OR IGNORE INTO tenants(id,name) VALUES(?,?)').run(DEMO_TENANT, EDGE_CONFIG.tenantName);
  db.prepare('INSERT OR IGNORE INTO outlets(id,tenant_id,name,timezone,currency,tax_rate_bps) VALUES(?,?,?,?,?,?)')
    .run(DEMO_OUTLET, DEMO_TENANT, EDGE_CONFIG.outletName, EDGE_CONFIG.timezone, EDGE_CONFIG.currency, EDGE_CONFIG.taxRateBps);
  db.prepare('INSERT OR IGNORE INTO terminals(id,tenant_id,outlet_id,name) VALUES(?,?,?,?)')
    .run(DEMO_TERMINAL, DEMO_TENANT, DEMO_OUTLET, EDGE_CONFIG.terminalName);
  const insert = db.prepare(`INSERT OR IGNORE INTO menu_items
    (id,tenant_id,outlet_id,name,category,price_minor,emoji,color,tag,vegetarian,available,kitchen_station)
    VALUES(@id,@tenantId,@outletId,@name,@category,@priceMinor,@emoji,@color,@tag,@vegetarian,@available,@kitchenStation)`);
  if (process.env.NODE_ENV !== 'production') for (const item of DEMO_MENU) insert.run({
    id:item.id,tenantId:DEMO_TENANT,outletId:DEMO_OUTLET,name:item.name,category:item.category,
    priceMinor:item.priceMinor,emoji:item.emoji,color:item.color,tag:item.tag??null,
    vegetarian:item.vegetarian?1:0,available:item.available?1:0,kitchenStation:item.kitchenStation,
  });
  const insertModifier=db.prepare(`INSERT OR IGNORE INTO menu_modifiers
    (id,tenant_id,outlet_id,menu_item_id,group_name,name,price_delta_minor,sort_order)
    VALUES(@id,@tenantId,@outletId,@menuItemId,@group,@name,@priceDeltaMinor,@sortOrder)`);
  if (process.env.NODE_ENV !== 'production') for(const item of DEMO_MENU)item.modifiers.forEach((modifier,index)=>insertModifier.run({
    id:modifier.id,tenantId:DEMO_TENANT,outletId:DEMO_OUTLET,menuItemId:item.id,group:modifier.group,
    name:modifier.name,priceDeltaMinor:modifier.priceDeltaMinor,sortOrder:index,
  }));
  for (const [counterName,nextValue] of [['order',1],['invoice',1],['shift',1]] as const) {
    db.prepare(`INSERT OR IGNORE INTO outlet_counters(tenant_id,outlet_id,counter_name,next_value) VALUES(?,?,?,?)`)
      .run(DEMO_TENANT,DEMO_OUTLET,counterName,nextValue);
  }
});
seed();
const cachedOutletSettings = db.prepare('SELECT name,timezone,currency,tax_rate_bps AS taxRateBps FROM outlets WHERE id=? AND tenant_id=?')
  .get(DEMO_OUTLET, DEMO_TENANT) as OutletRuntimeSettings | undefined;
if (cachedOutletSettings) applyOutletRuntimeSettings(cachedOutletSettings);

export function allocateNumber(counterName: 'order'|'invoice'|'shift', prefix: 'ORD'|'INV'|'SHIFT'): string {
  const row = db.prepare(`SELECT next_value FROM outlet_counters WHERE tenant_id=? AND outlet_id=? AND counter_name=?`)
    .get(DEMO_TENANT,DEMO_OUTLET,counterName) as {next_value:number};
  db.prepare(`UPDATE outlet_counters SET next_value=? WHERE tenant_id=? AND outlet_id=? AND counter_name=?`)
    .run(row.next_value+1,DEMO_TENANT,DEMO_OUTLET,counterName);
  return `J-${prefix}-${String(row.next_value).padStart(6,'0')}`;
}

export function createId(): string { return randomUUID(); }

export interface PendingSyncEvent {
  eventId: string;
  entityType: 'order'|'payment'|'shift'|'cash_movement'|'audit';
  entityId: string;
  action: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  attemptCount: number;
}

const insertSyncEvent = db.prepare(`INSERT INTO sync_outbox
  (event_id,entity_type,entity_id,action,occurred_at,payload_json,created_at)
  VALUES(?,?,?,?,?,?,?)`);

export function enqueueSyncEvent(entityType: PendingSyncEvent['entityType'], entityId: string, action: string,
  payload: Record<string, unknown>, occurredAt: string, eventId = createId()): void {
  insertSyncEvent.run(eventId,entityType,entityId,action,occurredAt,JSON.stringify(payload),new Date().toISOString());
}

export function pendingSyncEvents(limit = 50): PendingSyncEvent[] {
  const rows = db.prepare(`SELECT event_id,entity_type,entity_id,action,occurred_at,payload_json,attempt_count
    FROM sync_outbox WHERE synced_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at<=?)
    ORDER BY outbox_id LIMIT ?`).all(new Date().toISOString(),limit) as Array<{
      event_id:string;entity_type:PendingSyncEvent['entityType'];entity_id:string;action:string;occurred_at:string;payload_json:string;attempt_count:number;
    }>;
  return rows.map(row=>({eventId:row.event_id,entityType:row.entity_type,entityId:row.entity_id,action:row.action,
    occurredAt:row.occurred_at,payload:JSON.parse(row.payload_json) as Record<string,unknown>,attemptCount:row.attempt_count}));
}

export function acknowledgeSyncEvents(eventIds: string[]): void {
  if (!eventIds.length) return;
  const update = db.prepare('UPDATE sync_outbox SET synced_at=?,next_attempt_at=NULL,last_error=NULL WHERE event_id=? AND synced_at IS NULL');
  const syncedAt = new Date().toISOString();
  db.transaction(()=>{for(const eventId of eventIds)update.run(syncedAt,eventId);})();
}

export function failSyncEvents(eventIds: string[], errorMessage: string): void {
  if (!eventIds.length) return;
  const update = db.prepare(`UPDATE sync_outbox SET attempt_count=attempt_count+1,last_error=?,
    next_attempt_at=? WHERE event_id=? AND synced_at IS NULL`);
  const now=Date.now();
  db.transaction(()=>{for(const eventId of eventIds){
    const row=db.prepare('SELECT attempt_count FROM sync_outbox WHERE event_id=? AND synced_at IS NULL').get(eventId) as {attempt_count:number}|undefined;
    if(!row)continue;
    const delayMs=Math.min(5*60_000,1000*2**Math.min(row.attempt_count,8));
    update.run(errorMessage.slice(0,240),new Date(now+delayMs).toISOString(),eventId);
  }})();
}

export function syncOutboxStatus(){
  return db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN synced_at IS NULL THEN 1 ELSE 0 END),0) AS pending,
    COALESCE(SUM(CASE WHEN synced_at IS NULL AND attempt_count>0 THEN 1 ELSE 0 END),0) AS failed,
    MAX(synced_at) AS lastSyncedAt FROM sync_outbox`).get() as {pending:number;failed:number;lastSyncedAt:string|null};
}

export interface ManagedMenuSnapshotItem extends MenuItem {}

export function managedMenuSyncState(){
  return db.prepare('SELECT version,last_synced_at AS lastSyncedAt,last_error AS lastError FROM menu_sync_state WHERE tenant_id=? AND outlet_id=?')
    .get(DEMO_TENANT,DEMO_OUTLET) as {version:string;lastSyncedAt:string;lastError:string|null}|undefined;
}

export function recordManagedMenuSyncError(message:string):void{
  const current=managedMenuSyncState();
  if(!current)return;
  db.prepare('UPDATE menu_sync_state SET last_error=? WHERE tenant_id=? AND outlet_id=?')
    .run(message.slice(0,240),DEMO_TENANT,DEMO_OUTLET);
}

export function markManagedMenuChecked(version:string, syncedAt=new Date().toISOString()):void{
  db.prepare(`INSERT INTO menu_sync_state(tenant_id,outlet_id,version,last_synced_at,last_error) VALUES(?,?,?,?,NULL)
    ON CONFLICT(tenant_id,outlet_id) DO UPDATE SET version=excluded.version,last_synced_at=excluded.last_synced_at,last_error=NULL`)
    .run(DEMO_TENANT,DEMO_OUTLET,version,syncedAt);
}

export function applyManagedMenuSnapshot(version:string,items:ManagedMenuSnapshotItem[],settings:OutletRuntimeSettings,syncedAt=new Date().toISOString()):void{
  if(items.length>5000)throw new Error('The outlet menu exceeds the item limit.');
  const apply=db.transaction(()=>{
    db.prepare('UPDATE outlets SET name=?,timezone=?,currency=?,tax_rate_bps=? WHERE id=? AND tenant_id=?')
      .run(settings.name,settings.timezone,settings.currency,settings.taxRateBps,DEMO_OUTLET,DEMO_TENANT);
    db.prepare('UPDATE menu_items SET available=0,updated_at=? WHERE tenant_id=? AND outlet_id=?')
      .run(syncedAt,DEMO_TENANT,DEMO_OUTLET);
    db.prepare('UPDATE menu_modifiers SET active=0 WHERE tenant_id=? AND outlet_id=?').run(DEMO_TENANT,DEMO_OUTLET);
    const upsertItem=db.prepare(`INSERT INTO menu_items
      (id,tenant_id,outlet_id,name,category,price_minor,emoji,color,tag,vegetarian,available,kitchen_station,version,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,category=excluded.category,price_minor=excluded.price_minor,
        emoji=excluded.emoji,color=excluded.color,tag=excluded.tag,vegetarian=excluded.vegetarian,available=excluded.available,
        kitchen_station=excluded.kitchen_station,version=menu_items.version+1,updated_at=excluded.updated_at
      WHERE menu_items.tenant_id=excluded.tenant_id AND menu_items.outlet_id=excluded.outlet_id`);
    const upsertModifier=db.prepare(`INSERT INTO menu_modifiers
      (id,tenant_id,outlet_id,menu_item_id,group_name,name,price_delta_minor,active,sort_order)
      VALUES(?,?,?,?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET menu_item_id=excluded.menu_item_id,
        group_name=excluded.group_name,name=excluded.name,price_delta_minor=excluded.price_delta_minor,
        active=1,sort_order=excluded.sort_order
      WHERE menu_modifiers.tenant_id=excluded.tenant_id AND menu_modifiers.outlet_id=excluded.outlet_id`);
    for(const item of items){
      const result=upsertItem.run(item.id,DEMO_TENANT,DEMO_OUTLET,item.name,item.category,item.priceMinor,item.emoji,item.color,
        item.tag??null,item.vegetarian?1:0,item.available?1:0,item.kitchenStation,syncedAt);
      if(result.changes!==1)throw new Error('A menu item ID conflicts with data owned by another outlet.');
      for(const [sortOrder,modifier] of item.modifiers.entries()){
        const modifierResult=upsertModifier.run(modifier.id,DEMO_TENANT,DEMO_OUTLET,item.id,modifier.group,modifier.name,modifier.priceDeltaMinor,sortOrder);
        if(modifierResult.changes!==1)throw new Error('A modifier ID conflicts with data owned by another outlet.');
      }
    }
    markManagedMenuChecked(version,syncedAt);
  });
  apply();
  applyOutletRuntimeSettings(settings);
}
