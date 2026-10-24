import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DEMO_MENU } from '@common-table/contracts';
import { EDGE_CONFIG } from './config.js';

const here = dirname(fileURLToPath(import.meta.url));
const databasePath = resolve(process.env.POS_DATABASE_PATH ?? '.data/common-table.db');
mkdirSync(dirname(databasePath), { recursive: true });

export const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = FULL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.exec(readFileSync(resolve(here, 'schema.sql'), 'utf8'));

export const DEMO_TENANT = EDGE_CONFIG.tenantId;
export const DEMO_OUTLET = EDGE_CONFIG.outletId;
export const DEMO_TERMINAL = EDGE_CONFIG.terminalId;
export const DEMO_ACTOR = EDGE_CONFIG.actorId;
export const DEMO_TAX_RATE_BPS = EDGE_CONFIG.taxRateBps;

const seed = db.transaction(() => {
  db.prepare('INSERT OR IGNORE INTO tenants(id,name) VALUES(?,?)').run(DEMO_TENANT, EDGE_CONFIG.tenantName);
  db.prepare('INSERT OR IGNORE INTO outlets(id,tenant_id,name,timezone,currency) VALUES(?,?,?,?,?)')
    .run(DEMO_OUTLET, DEMO_TENANT, EDGE_CONFIG.outletName, EDGE_CONFIG.timezone, EDGE_CONFIG.currency);
  db.prepare('INSERT OR IGNORE INTO terminals(id,tenant_id,outlet_id,name) VALUES(?,?,?,?)')
    .run(DEMO_TERMINAL, DEMO_TENANT, DEMO_OUTLET, EDGE_CONFIG.terminalName);
  const insert = db.prepare(`INSERT OR IGNORE INTO menu_items
    (id,tenant_id,outlet_id,name,category,price_minor,emoji,color,tag,vegetarian,available,kitchen_station)
    VALUES(@id,@tenantId,@outletId,@name,@category,@priceMinor,@emoji,@color,@tag,@vegetarian,@available,@kitchenStation)`);
  for (const item of DEMO_MENU) insert.run({
    id:item.id,tenantId:DEMO_TENANT,outletId:DEMO_OUTLET,name:item.name,category:item.category,
    priceMinor:item.priceMinor,emoji:item.emoji,color:item.color,tag:item.tag??null,
    vegetarian:item.vegetarian?1:0,available:item.available?1:0,kitchenStation:item.kitchenStation,
  });
  const insertModifier=db.prepare(`INSERT OR IGNORE INTO menu_modifiers
    (id,tenant_id,outlet_id,menu_item_id,group_name,name,price_delta_minor,sort_order)
    VALUES(@id,@tenantId,@outletId,@menuItemId,@group,@name,@priceDeltaMinor,@sortOrder)`);
  for(const item of DEMO_MENU)item.modifiers.forEach((modifier,index)=>insertModifier.run({
    id:modifier.id,tenantId:DEMO_TENANT,outletId:DEMO_OUTLET,menuItemId:item.id,group:modifier.group,
    name:modifier.name,priceDeltaMinor:modifier.priceDeltaMinor,sortOrder:index,
  }));
  for (const [counterName,nextValue] of [['order',1],['invoice',1]] as const) {
    db.prepare(`INSERT OR IGNORE INTO outlet_counters(tenant_id,outlet_id,counter_name,next_value) VALUES(?,?,?,?)`)
      .run(DEMO_TENANT,DEMO_OUTLET,counterName,nextValue);
  }
});
seed();

export function allocateNumber(counterName: 'order'|'invoice', prefix: 'ORD'|'INV'): string {
  const row = db.prepare(`SELECT next_value FROM outlet_counters WHERE tenant_id=? AND outlet_id=? AND counter_name=?`)
    .get(DEMO_TENANT,DEMO_OUTLET,counterName) as {next_value:number};
  db.prepare(`UPDATE outlet_counters SET next_value=? WHERE tenant_id=? AND outlet_id=? AND counter_name=?`)
    .run(row.next_value+1,DEMO_TENANT,DEMO_OUTLET,counterName);
  return `J-${prefix}-${String(row.next_value).padStart(6,'0')}`;
}

export function createId(): string { return randomUUID(); }
