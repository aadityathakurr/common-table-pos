-- Common Table POS: scalable PostgreSQL core schema.
-- Apply only after selecting/creating a PostgreSQL environment and reviewing deployment settings.
-- Money is stored in the currency's minor unit (paise for INR); tax rules are effective-dated data.

BEGIN;

CREATE TABLE tenants (
    tenant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE brands (
    tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
    brand_id uuid NOT NULL DEFAULT gen_random_uuid(),
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, brand_id)
);

CREATE TABLE outlets (
    tenant_id uuid NOT NULL,
    outlet_id uuid NOT NULL DEFAULT gen_random_uuid(),
    brand_id uuid NOT NULL,
    name text NOT NULL,
    timezone text NOT NULL DEFAULT 'Asia/Kolkata',
    currency char(3) NOT NULL DEFAULT 'INR',
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','closed')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, outlet_id),
    FOREIGN KEY (tenant_id, brand_id) REFERENCES brands(tenant_id, brand_id)
);

CREATE TABLE users (
    tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
    user_id uuid NOT NULL DEFAULT gen_random_uuid(),
    email text NOT NULL,
    display_name text NOT NULL,
    password_hash text,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, user_id),
    UNIQUE (tenant_id, email)
);

CREATE TABLE roles (
    tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
    role_id uuid NOT NULL DEFAULT gen_random_uuid(),
    name text NOT NULL,
    permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, role_id),
    UNIQUE (tenant_id, name)
);

CREATE TABLE outlet_users (
    tenant_id uuid NOT NULL,
    outlet_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, outlet_id, user_id),
    FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets(tenant_id, outlet_id),
    FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, user_id),
    FOREIGN KEY (tenant_id, role_id) REFERENCES roles(tenant_id, role_id)
);

CREATE TABLE terminals (
    tenant_id uuid NOT NULL,
    outlet_id uuid NOT NULL,
    terminal_id uuid NOT NULL DEFAULT gen_random_uuid(),
    name text NOT NULL,
    device_key_hash text NOT NULL,
    last_seen_at timestamptz,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, outlet_id, terminal_id),
    UNIQUE (tenant_id, device_key_hash),
    FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets(tenant_id, outlet_id)
);

CREATE TABLE menu_categories (
    tenant_id uuid NOT NULL,
    outlet_id uuid NOT NULL,
    category_id uuid NOT NULL DEFAULT gen_random_uuid(),
    name text NOT NULL,
    sort_order integer NOT NULL DEFAULT 0,
    active boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, outlet_id, category_id),
    FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets(tenant_id, outlet_id)
);

CREATE TABLE menu_items (
    tenant_id uuid NOT NULL,
    outlet_id uuid NOT NULL,
    item_id uuid NOT NULL DEFAULT gen_random_uuid(),
    category_id uuid,
    name text NOT NULL,
    sku text,
    description text,
    price_minor bigint NOT NULL CHECK (price_minor >= 0),
    currency char(3) NOT NULL DEFAULT 'INR',
    tax_rule_key text,
    kitchen_station text NOT NULL DEFAULT 'Main kitchen',
    vegetarian boolean NOT NULL DEFAULT false,
    available boolean NOT NULL DEFAULT true,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, outlet_id, item_id),
    FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets(tenant_id, outlet_id),
    FOREIGN KEY (tenant_id, outlet_id, category_id)
        REFERENCES menu_categories(tenant_id, outlet_id, category_id),
    UNIQUE (tenant_id, outlet_id, sku)
);

CREATE TABLE shifts (
    tenant_id uuid NOT NULL,
    outlet_id uuid NOT NULL,
    shift_id uuid NOT NULL DEFAULT gen_random_uuid(),
    opened_by uuid NOT NULL,
    opened_at timestamptz NOT NULL DEFAULT now(),
    opening_cash_minor bigint NOT NULL DEFAULT 0 CHECK (opening_cash_minor >= 0),
    closed_by uuid,
    closed_at timestamptz,
    closing_cash_minor bigint CHECK (closing_cash_minor >= 0),
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
    PRIMARY KEY (tenant_id, outlet_id, shift_id),
    FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets(tenant_id, outlet_id),
    FOREIGN KEY (tenant_id, opened_by) REFERENCES users(tenant_id, user_id),
    FOREIGN KEY (tenant_id, closed_by) REFERENCES users(tenant_id, user_id),
    CHECK ((status = 'open' AND closed_at IS NULL) OR (status = 'closed' AND closed_at IS NOT NULL))
);

CREATE TABLE orders (
    tenant_id uuid NOT NULL,
    outlet_id uuid NOT NULL,
    order_id uuid NOT NULL DEFAULT gen_random_uuid(),
    idempotency_key text NOT NULL,
    terminal_id uuid NOT NULL,
    shift_id uuid,
    order_number text NOT NULL,
    order_type text NOT NULL CHECK (order_type IN ('dine_in','takeaway','delivery','qr')),
    table_label text,
    status text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','sent','preparing','ready','served','paid','cancelled','refunded')),
    currency char(3) NOT NULL DEFAULT 'INR',
    subtotal_minor bigint NOT NULL DEFAULT 0 CHECK (subtotal_minor >= 0),
    tax_total_minor bigint NOT NULL DEFAULT 0 CHECK (tax_total_minor >= 0),
    discount_total_minor bigint NOT NULL DEFAULT 0 CHECK (discount_total_minor >= 0),
    total_minor bigint NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
    tax_rate_bps integer NOT NULL DEFAULT 0 CHECK (tax_rate_bps >= 0),
    invoice_number text,
    note text,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    closed_at timestamptz,
    PRIMARY KEY (tenant_id, outlet_id, order_id),
    UNIQUE (tenant_id, outlet_id, order_number),
    UNIQUE (tenant_id, outlet_id, idempotency_key),
    UNIQUE (tenant_id, outlet_id, invoice_number),
    FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets(tenant_id, outlet_id),
    FOREIGN KEY (tenant_id, outlet_id, terminal_id) REFERENCES terminals(tenant_id, outlet_id, terminal_id),
    FOREIGN KEY (tenant_id, outlet_id, shift_id) REFERENCES shifts(tenant_id, outlet_id, shift_id),
    FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, user_id)
);
CREATE INDEX orders_outlet_created_idx ON orders(tenant_id, outlet_id, created_at DESC);
CREATE INDEX orders_kitchen_queue_idx ON orders(tenant_id, outlet_id, status, created_at)
    WHERE status IN ('sent','preparing','ready');

CREATE TABLE order_lines (
    tenant_id uuid NOT NULL,
    outlet_id uuid NOT NULL,
    order_id uuid NOT NULL,
    line_id uuid NOT NULL DEFAULT gen_random_uuid(),
    menu_item_id uuid,
    item_snapshot jsonb NOT NULL,
    kitchen_station text NOT NULL DEFAULT 'Main kitchen',
    modifiers_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
    quantity numeric(10,3) NOT NULL CHECK (quantity > 0),
    unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
    tax_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
    discount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
    line_total_minor bigint NOT NULL CHECK (line_total_minor >= 0),
    note text,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, outlet_id, order_id, line_id),
    FOREIGN KEY (tenant_id, outlet_id, order_id) REFERENCES orders(tenant_id, outlet_id, order_id),
    FOREIGN KEY (tenant_id, outlet_id, menu_item_id) REFERENCES menu_items(tenant_id, outlet_id, item_id)
);

CREATE TABLE kitchen_tickets (
    tenant_id uuid NOT NULL,
    outlet_id uuid NOT NULL,
    ticket_id uuid NOT NULL DEFAULT gen_random_uuid(),
    order_id uuid NOT NULL,
    station text NOT NULL,
    ticket_number text NOT NULL,
    status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','preparing','ready','voided')),
    created_at timestamptz NOT NULL DEFAULT now(),
    ready_at timestamptz,
    PRIMARY KEY (tenant_id, outlet_id, ticket_id),
    FOREIGN KEY (tenant_id, outlet_id, order_id) REFERENCES orders(tenant_id, outlet_id, order_id)
);
CREATE INDEX kitchen_tickets_queue_idx ON kitchen_tickets(tenant_id, outlet_id, station, status, created_at);

CREATE TABLE payment_events (
    tenant_id uuid NOT NULL,
    outlet_id uuid NOT NULL,
    payment_id uuid NOT NULL DEFAULT gen_random_uuid(),
    order_id uuid NOT NULL,
    terminal_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    method text NOT NULL CHECK (method IN ('cash','upi','card','other')),
    status text NOT NULL CHECK (status IN ('pending','succeeded','failed','refunded','voided')),
    amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
    provider_reference text,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, outlet_id, payment_id),
    UNIQUE (tenant_id, outlet_id, idempotency_key),
    FOREIGN KEY (tenant_id, outlet_id, order_id) REFERENCES orders(tenant_id, outlet_id, order_id),
    FOREIGN KEY (tenant_id, outlet_id, terminal_id) REFERENCES terminals(tenant_id, outlet_id, terminal_id)
);

CREATE TABLE audit_events (
    tenant_id uuid NOT NULL,
    outlet_id uuid NOT NULL,
    event_id uuid NOT NULL DEFAULT gen_random_uuid(),
    actor_id uuid,
    terminal_id uuid,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    action text NOT NULL,
    reason text,
    data jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, outlet_id, event_id),
    FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets(tenant_id, outlet_id),
    FOREIGN KEY (tenant_id, actor_id) REFERENCES users(tenant_id, user_id),
    FOREIGN KEY (tenant_id, outlet_id, terminal_id) REFERENCES terminals(tenant_id, outlet_id, terminal_id)
);
CREATE INDEX audit_events_entity_idx ON audit_events(tenant_id, outlet_id, entity_type, entity_id, occurred_at DESC);

CREATE TABLE sync_outbox (
    tenant_id uuid NOT NULL,
    outlet_id uuid NOT NULL,
    event_id uuid NOT NULL,
    terminal_id uuid NOT NULL,
    local_sequence bigint NOT NULL,
    aggregate_type text NOT NULL,
    aggregate_id uuid NOT NULL,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    occurred_at timestamptz NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, outlet_id, event_id),
    UNIQUE (tenant_id, outlet_id, terminal_id, local_sequence),
    FOREIGN KEY (tenant_id, outlet_id, terminal_id) REFERENCES terminals(tenant_id, outlet_id, terminal_id)
);
CREATE INDEX sync_outbox_aggregate_idx ON sync_outbox(tenant_id, outlet_id, aggregate_type, aggregate_id, local_sequence);

COMMIT;
