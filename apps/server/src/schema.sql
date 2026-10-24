PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS outlets (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata', currency TEXT NOT NULL DEFAULT 'INR',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS terminals (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, outlet_id TEXT NOT NULL, name TEXT NOT NULL,
  device_key_hash TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(tenant_id,outlet_id) REFERENCES outlets(tenant_id,id), UNIQUE(tenant_id,outlet_id,id)
);
CREATE TABLE IF NOT EXISTS menu_items (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, outlet_id TEXT NOT NULL, name TEXT NOT NULL,
  category TEXT NOT NULL, price_minor INTEGER NOT NULL CHECK(price_minor >= 0), emoji TEXT NOT NULL,
  color TEXT NOT NULL, tag TEXT, vegetarian INTEGER NOT NULL DEFAULT 0, available INTEGER NOT NULL DEFAULT 1,
  kitchen_station TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(tenant_id,outlet_id) REFERENCES outlets(tenant_id,id), UNIQUE(tenant_id,outlet_id,id)
);
CREATE TABLE IF NOT EXISTS menu_modifiers (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, outlet_id TEXT NOT NULL, menu_item_id TEXT NOT NULL,
  group_name TEXT NOT NULL, name TEXT NOT NULL, price_delta_minor INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(tenant_id,outlet_id,menu_item_id) REFERENCES menu_items(tenant_id,outlet_id,id),
  UNIQUE(tenant_id,outlet_id,id)
);
CREATE INDEX IF NOT EXISTS modifiers_by_item ON menu_modifiers(tenant_id,outlet_id,menu_item_id,group_name,sort_order);
CREATE TABLE IF NOT EXISTS outlet_counters (
  tenant_id TEXT NOT NULL, outlet_id TEXT NOT NULL, counter_name TEXT NOT NULL, next_value INTEGER NOT NULL,
  PRIMARY KEY(tenant_id,outlet_id,counter_name),
  FOREIGN KEY(tenant_id,outlet_id) REFERENCES outlets(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, tenant_id TEXT NOT NULL, outlet_id TEXT NOT NULL,
  terminal_id TEXT NOT NULL, order_number TEXT NOT NULL, order_type TEXT NOT NULL CHECK(order_type IN ('dine_in','takeaway')),
  table_label TEXT, guest_count INTEGER NOT NULL DEFAULT 1 CHECK(guest_count > 0),
  status TEXT NOT NULL CHECK(status IN ('sent','preparing','ready','paid','cancelled')),
  note TEXT, currency TEXT NOT NULL DEFAULT 'INR', subtotal_minor INTEGER NOT NULL,
  tax_total_minor INTEGER NOT NULL, tax_rate_bps INTEGER NOT NULL DEFAULT 0,
  total_minor INTEGER NOT NULL, payment_method TEXT, invoice_number TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(tenant_id,outlet_id) REFERENCES outlets(tenant_id,id),
  FOREIGN KEY(tenant_id,outlet_id,terminal_id) REFERENCES terminals(tenant_id,outlet_id,id),
  UNIQUE(tenant_id,outlet_id,order_number), UNIQUE(tenant_id,outlet_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS orders_invoice_number ON orders(tenant_id,outlet_id,invoice_number)
  WHERE invoice_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_kitchen_queue ON orders(tenant_id,outlet_id,status,created_at)
  WHERE status IN ('sent','preparing','ready');
CREATE INDEX IF NOT EXISTS orders_outlet_history ON orders(tenant_id,outlet_id,created_at DESC);
CREATE TABLE IF NOT EXISTS order_lines (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, outlet_id TEXT NOT NULL, order_id TEXT NOT NULL,
  menu_item_id TEXT NOT NULL, item_name_snapshot TEXT NOT NULL, category_snapshot TEXT NOT NULL,
  unit_price_minor INTEGER NOT NULL, modifiers_json TEXT NOT NULL DEFAULT '[]', quantity REAL NOT NULL CHECK(quantity > 0),
  line_total_minor INTEGER NOT NULL, kitchen_station TEXT NOT NULL, note TEXT,
  FOREIGN KEY(tenant_id,outlet_id,order_id) REFERENCES orders(tenant_id,outlet_id,id),
  FOREIGN KEY(tenant_id,outlet_id,menu_item_id) REFERENCES menu_items(tenant_id,outlet_id,id)
);
CREATE INDEX IF NOT EXISTS order_lines_by_order ON order_lines(tenant_id,outlet_id,order_id);
CREATE TABLE IF NOT EXISTS kitchen_tickets (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, outlet_id TEXT NOT NULL, order_id TEXT NOT NULL,
  station TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('new','preparing','ready','voided')),
  created_at TEXT NOT NULL, ready_at TEXT,
  FOREIGN KEY(tenant_id,outlet_id,order_id) REFERENCES orders(tenant_id,outlet_id,id)
);
CREATE INDEX IF NOT EXISTS tickets_by_station ON kitchen_tickets(tenant_id,outlet_id,station,status,created_at);
CREATE TABLE IF NOT EXISTS payment_events (
  id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, tenant_id TEXT NOT NULL, outlet_id TEXT NOT NULL,
  order_id TEXT NOT NULL, terminal_id TEXT NOT NULL, method TEXT NOT NULL CHECK(method IN ('cash','upi','card')),
  amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0), status TEXT NOT NULL CHECK(status IN ('succeeded','failed')),
  provider_reference TEXT, created_at TEXT NOT NULL,
  FOREIGN KEY(tenant_id,outlet_id,order_id) REFERENCES orders(tenant_id,outlet_id,id)
);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, outlet_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  terminal_id TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  action TEXT NOT NULL, reason TEXT, payload_json TEXT NOT NULL DEFAULT '{}', occurred_at TEXT NOT NULL,
  FOREIGN KEY(tenant_id,outlet_id) REFERENCES outlets(tenant_id,id)
);
