import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DEMO_MENU, type MenuItem, type OutletLayoutConfig } from '@common-table/contracts';
import { applyOutletRuntimeSettings, EDGE_CONFIG, type OutletRuntimeSettings } from './config.js';

const here = dirname(fileURLToPath(import.meta.url));
export const DATABASE_PATH = resolve(process.env.POS_DATABASE_PATH ?? '.data/common-table.db');
mkdirSync(dirname(DATABASE_PATH), { recursive: true });

export const db = new Database(DATABASE_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = FULL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.exec(readFileSync(resolve(here, 'schema.sql'), 'utf8'));
const outboxDefinition=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sync_outbox'").get() as {sql:string}|undefined;
if(outboxDefinition&&!outboxDefinition.sql.includes("'inventory'")){
  db.exec(`BEGIN;
    CREATE TABLE sync_outbox_new (
      outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      entity_type TEXT NOT NULL CHECK(entity_type IN ('order','payment','shift','cash_movement','audit','inventory')),
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
      next_attempt_at TEXT,
      last_error TEXT,
      synced_at TEXT,
      created_at TEXT NOT NULL
    );
    INSERT INTO sync_outbox_new SELECT * FROM sync_outbox;
    DROP TABLE sync_outbox;
    ALTER TABLE sync_outbox_new RENAME TO sync_outbox;
    CREATE INDEX sync_outbox_pending ON sync_outbox(next_attempt_at,outbox_id) WHERE synced_at IS NULL;
    COMMIT;`);
}
const outletColumns = db.pragma('table_info(outlets)') as Array<{ name: string }>;
if (!outletColumns.some(column => column.name === 'tax_rate_bps')) {
  db.exec('ALTER TABLE outlets ADD COLUMN tax_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK(tax_rate_bps BETWEEN 0 AND 10000)');
  db.prepare('UPDATE outlets SET tax_rate_bps=? WHERE id=? AND tenant_id=?').run(EDGE_CONFIG.taxRateBps, EDGE_CONFIG.outletId, EDGE_CONFIG.tenantId);
}
const receiptColumns = [
  ['receipt_name', EDGE_CONFIG.receiptName], ['receipt_address', EDGE_CONFIG.receiptAddress],
  ['receipt_phone', EDGE_CONFIG.receiptPhone], ['gstin', EDGE_CONFIG.gstin], ['receipt_footer', EDGE_CONFIG.receiptFooter],
] as const;
for (const [column, initialValue] of receiptColumns) {
  if (!outletColumns.some(existing => existing.name === column)) {
    db.exec(`ALTER TABLE outlets ADD COLUMN ${column} TEXT`);
    db.prepare(`UPDATE outlets SET ${column}=? WHERE id=? AND tenant_id=?`)
      .run(initialValue || null, EDGE_CONFIG.outletId, EDGE_CONFIG.tenantId);
  }
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
  db.prepare(`INSERT OR IGNORE INTO outlets
    (id,tenant_id,name,timezone,currency,tax_rate_bps,receipt_name,receipt_address,receipt_phone,gstin,receipt_footer)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(DEMO_OUTLET, DEMO_TENANT, EDGE_CONFIG.outletName, EDGE_CONFIG.timezone, EDGE_CONFIG.currency, EDGE_CONFIG.taxRateBps,
      EDGE_CONFIG.receiptName || null, EDGE_CONFIG.receiptAddress || null, EDGE_CONFIG.receiptPhone || null,
      EDGE_CONFIG.gstin || null, EDGE_CONFIG.receiptFooter || null);
  db.prepare('INSERT OR IGNORE INTO terminals(id,tenant_id,outlet_id,name) VALUES(?,?,?,?)')
    .run(DEMO_TERMINAL, DEMO_TENANT, DEMO_OUTLET, EDGE_CONFIG.terminalName);
  if (process.env.NODE_ENV !== 'production') {
    const areas = [
      { id: 'demo-area-main', name: 'Main floor', order: 0, tables: ['Table 01','Table 02','Table 03','Table 04','Table 05'] },
      { id: 'demo-area-patio', name: 'Patio', order: 1, tables: ['Patio 01'] },
      { id: 'demo-area-bar', name: 'Bar', order: 2, tables: ['Bar 01','Bar 02'] },
    ];
    const insertArea = db.prepare('INSERT OR IGNORE INTO dining_areas(id,tenant_id,outlet_id,name,sort_order) VALUES(?,?,?,?,?)');
    const insertTable = db.prepare('INSERT OR IGNORE INTO dining_tables(id,tenant_id,outlet_id,area_id,name,capacity,sort_order) VALUES(?,?,?,?,?,?,?)');
    for (const area of areas) {
      insertArea.run(area.id, DEMO_TENANT, DEMO_OUTLET, area.name, area.order);
      area.tables.forEach((name, index) => insertTable.run(`${area.id}-${index + 1}`, DEMO_TENANT, DEMO_OUTLET, area.id, name, area.name === 'Main floor' ? 2 : 4, index));
    }
    const stationNames = [...new Set(DEMO_MENU.map(item => item.kitchenStation))];
    const insertStation = db.prepare('INSERT OR IGNORE INTO kitchen_stations(id,tenant_id,outlet_id,name,sort_order) VALUES(?,?,?,?,?)');
    stationNames.forEach((name, index) => insertStation.run(`demo-station-${index + 1}`, DEMO_TENANT, DEMO_OUTLET, name, index));
  }
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
const cachedOutletSettings = db.prepare(`SELECT name,timezone,currency,tax_rate_bps AS taxRateBps,
  receipt_name AS receiptName,receipt_address AS receiptAddress,receipt_phone AS receiptPhone,gstin,receipt_footer AS receiptFooter
  FROM outlets WHERE id=? AND tenant_id=?`)
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
  entityType: 'order'|'payment'|'shift'|'cash_movement'|'audit'|'inventory';
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
  const markInventory = db.prepare(`UPDATE edge_inventory_movements SET synced=1 WHERE event_id=?
    AND EXISTS (SELECT 1 FROM sync_outbox WHERE event_id=? AND entity_type='inventory')`);
  const syncedAt = new Date().toISOString();
  db.transaction(()=>{for(const eventId of eventIds){markInventory.run(eventId,eventId);update.run(syncedAt,eventId);}})();
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
export type ManagedOutletLayout = OutletLayoutConfig;
export interface ManagedInventoryItem { id:string;name:string;unit:string;reorderLevel:number;active:boolean;onHand:number; }
export interface ManagedInventoryRecipe { menuItemId:string;inventoryItemId:string;quantityPerSale:number; }

export function localInventoryBalances(){
  return db.prepare(`SELECT i.id AS inventoryItemId,i.name,i.unit,i.active,i.reorder_level AS reorderLevel,
    i.cloud_on_hand+COALESCE(SUM(m.quantity_delta),0) AS onHand,
    i.cloud_on_hand+COALESCE(SUM(m.quantity_delta),0)<=i.reorder_level AS lowStock
    FROM edge_inventory_items i LEFT JOIN edge_inventory_movements m
      ON m.tenant_id=i.tenant_id AND m.outlet_id=i.outlet_id AND m.inventory_item_id=i.id
    WHERE i.tenant_id=? AND i.outlet_id=? GROUP BY i.id ORDER BY i.name`)
    .all(DEMO_TENANT,DEMO_OUTLET) as Array<{inventoryItemId:string;name:string;unit:string;active:number;reorderLevel:number;onHand:number;lowStock:number}>;
}

export function recordPaidOrderInventoryConsumption(orderId:string,orderNumber:string,actorId:string,occurredAt:string):number{
  const recipeRows=db.prepare(`SELECT r.inventory_item_id AS inventoryItemId,r.quantity_per_sale AS quantityPerSale,l.quantity
    FROM order_lines l JOIN edge_inventory_recipes r ON r.tenant_id=l.tenant_id AND r.outlet_id=l.outlet_id AND r.menu_item_id=l.menu_item_id
    JOIN edge_inventory_items i ON i.tenant_id=r.tenant_id AND i.outlet_id=r.outlet_id AND i.id=r.inventory_item_id AND i.active=1
    LEFT JOIN order_line_voids v ON v.order_line_id=l.id
    WHERE l.tenant_id=? AND l.outlet_id=? AND l.order_id=? AND v.order_line_id IS NULL`)
    .all(DEMO_TENANT,DEMO_OUTLET,orderId) as Array<{inventoryItemId:string;quantityPerSale:number;quantity:number}>;
  const consumed=new Map<string,number>();
  for(const row of recipeRows){
    const milli=Math.round(Number(row.quantityPerSale)*Number(row.quantity)*1000);
    if(!Number.isSafeInteger(milli)||milli<=0)throw new Error('A recipe produced an invalid stock quantity.');
    consumed.set(row.inventoryItemId,(consumed.get(row.inventoryItemId)??0)+milli);
  }
  const insert=db.prepare(`INSERT INTO edge_inventory_movements
    (id,event_id,command_id,tenant_id,outlet_id,inventory_item_id,order_id,actor_id,quantity,quantity_delta,reason,occurred_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  for(const [inventoryItemId,milli] of consumed){
    const quantity=milli/1000;const commandId=`sale:${orderId}:${inventoryItemId}`;
    const id=createId();const eventId=createId();const reason=`Order ${orderNumber} paid`;
    insert.run(id,eventId,commandId,DEMO_TENANT,DEMO_OUTLET,inventoryItemId,orderId,actorId,quantity,-quantity,reason,occurredAt);
    enqueueSyncEvent('inventory',id,'inventory.sale_consumed',{
      movementId:id,commandId,inventoryItemId,orderId,actorId,quantity,reason,occurredAt,
    },occurredAt,eventId);
  }
  return consumed.size;
}

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

export function applyManagedMenuSnapshot(version:string,items:ManagedMenuSnapshotItem[],inventoryItems:ManagedInventoryItem[],recipes:ManagedInventoryRecipe[],settings:OutletRuntimeSettings,layout:ManagedOutletLayout,syncedAt=new Date().toISOString()):void{
  if(items.length>5000)throw new Error('The outlet menu exceeds the item limit.');
  if(inventoryItems.length>20000||recipes.length>50000)throw new Error('The outlet inventory recipe snapshot exceeds its supported size.');
  const apply=db.transaction(()=>{
    db.prepare(`UPDATE outlets SET name=?,timezone=?,currency=?,tax_rate_bps=?,receipt_name=?,receipt_address=?,receipt_phone=?,gstin=?,receipt_footer=?
      WHERE id=? AND tenant_id=?`)
      .run(settings.name,settings.timezone,settings.currency,settings.taxRateBps,
        settings.receiptName || null,settings.receiptAddress || null,settings.receiptPhone || null,
        settings.gstin || null,settings.receiptFooter || null,DEMO_OUTLET,DEMO_TENANT);
    db.prepare('DELETE FROM dining_tables WHERE tenant_id=? AND outlet_id=?').run(DEMO_TENANT, DEMO_OUTLET);
    db.prepare('DELETE FROM dining_areas WHERE tenant_id=? AND outlet_id=?').run(DEMO_TENANT, DEMO_OUTLET);
    db.prepare('DELETE FROM kitchen_stations WHERE tenant_id=? AND outlet_id=?').run(DEMO_TENANT, DEMO_OUTLET);
    const insertArea=db.prepare('INSERT INTO dining_areas(id,tenant_id,outlet_id,name,sort_order,active) VALUES(?,?,?,?,?,1)');
    const insertTable=db.prepare('INSERT INTO dining_tables(id,tenant_id,outlet_id,area_id,name,capacity,sort_order,active) VALUES(?,?,?,?,?,?,?,1)');
    const insertStation=db.prepare('INSERT INTO kitchen_stations(id,tenant_id,outlet_id,name,sort_order,active) VALUES(?,?,?,?,?,1)');
    for(const area of layout.areas){
      insertArea.run(area.id,DEMO_TENANT,DEMO_OUTLET,area.name,area.sortOrder);
      for(const table of area.tables)insertTable.run(table.id,DEMO_TENANT,DEMO_OUTLET,area.id,table.name,table.capacity,table.sortOrder);
    }
    for(const station of layout.stations)insertStation.run(station.id,DEMO_TENANT,DEMO_OUTLET,station.name,station.sortOrder);
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
    db.prepare('UPDATE edge_inventory_items SET active=0,updated_at=? WHERE tenant_id=? AND outlet_id=?')
      .run(syncedAt,DEMO_TENANT,DEMO_OUTLET);
    const upsertInventoryItem=db.prepare(`INSERT INTO edge_inventory_items
      (id,tenant_id,outlet_id,name,unit,reorder_level,active,cloud_on_hand,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,unit=excluded.unit,reorder_level=excluded.reorder_level,
        active=excluded.active,cloud_on_hand=excluded.cloud_on_hand,updated_at=excluded.updated_at
      WHERE edge_inventory_items.tenant_id=excluded.tenant_id AND edge_inventory_items.outlet_id=excluded.outlet_id`);
    for(const item of inventoryItems){
      const result=upsertInventoryItem.run(item.id,DEMO_TENANT,DEMO_OUTLET,item.name,item.unit,item.reorderLevel,item.active?1:0,item.onHand,syncedAt);
      if(result.changes!==1)throw new Error('An inventory item ID conflicts with data owned by another outlet.');
    }
    db.prepare('DELETE FROM edge_inventory_recipes WHERE tenant_id=? AND outlet_id=?').run(DEMO_TENANT,DEMO_OUTLET);
    const insertRecipe=db.prepare(`INSERT INTO edge_inventory_recipes
      (tenant_id,outlet_id,menu_item_id,inventory_item_id,quantity_per_sale) VALUES(?,?,?,?,?)`);
    for(const recipe of recipes)insertRecipe.run(DEMO_TENANT,DEMO_OUTLET,recipe.menuItemId,recipe.inventoryItemId,recipe.quantityPerSale);
    // The snapshot includes all cloud-acknowledged consumption, so only pending edge movements remain local.
    db.prepare('DELETE FROM edge_inventory_movements WHERE tenant_id=? AND outlet_id=? AND synced=1').run(DEMO_TENANT,DEMO_OUTLET);
    markManagedMenuChecked(version,syncedAt);
  });
  apply();
  applyOutletRuntimeSettings(settings);
}
