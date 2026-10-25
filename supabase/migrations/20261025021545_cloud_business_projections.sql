BEGIN;

CREATE TABLE public.pos_orders (
  tenant_id uuid NOT NULL,
  outlet_id uuid NOT NULL,
  order_id text NOT NULL,
  terminal_id uuid NOT NULL,
  order_number text NOT NULL,
  order_type text NOT NULL CHECK (order_type IN ('dine_in', 'takeaway')),
  table_label text,
  guest_count integer NOT NULL CHECK (guest_count BETWEEN 1 AND 20),
  status text NOT NULL,
  note text,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
  tax_total_minor bigint NOT NULL CHECK (tax_total_minor >= 0),
  tax_rate_bps integer NOT NULL CHECK (tax_rate_bps BETWEEN 0 AND 10000),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  invoice_number text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  last_event_at timestamptz NOT NULL,
  last_event_id uuid NOT NULL,
  projected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, outlet_id, order_id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES public.outlets(tenant_id, outlet_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, outlet_id, terminal_id)
    REFERENCES public.terminals(tenant_id, outlet_id, terminal_id) ON DELETE RESTRICT
);

CREATE INDEX pos_orders_outlet_created ON public.pos_orders(tenant_id, outlet_id, created_at DESC, order_id);
CREATE INDEX pos_orders_outlet_status ON public.pos_orders(tenant_id, outlet_id, status, updated_at DESC);

CREATE TABLE public.pos_order_items (
  tenant_id uuid NOT NULL,
  outlet_id uuid NOT NULL,
  order_id text NOT NULL,
  line_id text NOT NULL,
  menu_item_id text NOT NULL,
  name text NOT NULL,
  category text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  line_total_minor bigint NOT NULL CHECK (line_total_minor >= 0),
  kitchen_station text NOT NULL,
  note text,
  modifiers jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(modifiers) = 'array'),
  voided_at timestamptz,
  void_reason text,
  last_event_at timestamptz NOT NULL,
  last_event_id uuid NOT NULL,
  projected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, outlet_id, order_id, line_id),
  FOREIGN KEY (tenant_id, outlet_id, order_id)
    REFERENCES public.pos_orders(tenant_id, outlet_id, order_id) ON DELETE CASCADE
);

CREATE INDEX pos_order_items_outlet_order ON public.pos_order_items(tenant_id, outlet_id, order_id);
CREATE INDEX pos_order_items_outlet_voided ON public.pos_order_items(tenant_id, outlet_id, voided_at)
  WHERE voided_at IS NOT NULL;

CREATE TABLE public.pos_payments (
  tenant_id uuid NOT NULL,
  outlet_id uuid NOT NULL,
  payment_id text NOT NULL,
  source_event_id uuid NOT NULL,
  order_id text NOT NULL,
  shift_id text,
  terminal_id uuid NOT NULL,
  entry_type text NOT NULL CHECK (entry_type IN ('tender', 'refund')),
  method text NOT NULL CHECK (method IN ('cash', 'upi', 'card')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  status text NOT NULL CHECK (status IN ('succeeded')),
  command_id text,
  refund_of text,
  reason text,
  invoice_number text,
  occurred_at timestamptz NOT NULL,
  projected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, outlet_id, payment_id),
  UNIQUE (tenant_id, outlet_id, source_event_id),
  FOREIGN KEY (tenant_id, outlet_id, order_id)
    REFERENCES public.pos_orders(tenant_id, outlet_id, order_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, outlet_id, terminal_id)
    REFERENCES public.terminals(tenant_id, outlet_id, terminal_id) ON DELETE RESTRICT
);

CREATE INDEX pos_payments_outlet_occurred ON public.pos_payments(tenant_id, outlet_id, occurred_at DESC, payment_id);
CREATE INDEX pos_payments_outlet_order ON public.pos_payments(tenant_id, outlet_id, order_id, occurred_at);
CREATE INDEX pos_payments_outlet_shift ON public.pos_payments(tenant_id, outlet_id, shift_id, occurred_at)
  WHERE shift_id IS NOT NULL;

CREATE TABLE public.pos_shifts (
  tenant_id uuid NOT NULL,
  outlet_id uuid NOT NULL,
  shift_id text NOT NULL,
  terminal_id uuid NOT NULL,
  shift_number text NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'closed')),
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  opening_float_minor bigint NOT NULL CHECK (opening_float_minor >= 0),
  expected_cash_minor bigint CHECK (expected_cash_minor >= 0),
  counted_cash_minor bigint CHECK (counted_cash_minor >= 0),
  variance_minor bigint,
  last_event_at timestamptz NOT NULL,
  last_event_id uuid NOT NULL,
  projected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, outlet_id, shift_id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES public.outlets(tenant_id, outlet_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, outlet_id, terminal_id)
    REFERENCES public.terminals(tenant_id, outlet_id, terminal_id) ON DELETE RESTRICT
);

CREATE INDEX pos_shifts_outlet_closed ON public.pos_shifts(tenant_id, outlet_id, closed_at DESC)
  WHERE status = 'closed';

CREATE TABLE public.pos_cash_movements (
  tenant_id uuid NOT NULL,
  outlet_id uuid NOT NULL,
  movement_id text NOT NULL,
  source_event_id uuid NOT NULL,
  shift_id text NOT NULL,
  terminal_id uuid NOT NULL,
  actor_id uuid,
  movement_type text NOT NULL CHECK (movement_type IN ('cash_in', 'cash_out')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  reason text NOT NULL,
  command_id text,
  occurred_at timestamptz NOT NULL,
  projected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, outlet_id, movement_id),
  UNIQUE (tenant_id, outlet_id, source_event_id),
  FOREIGN KEY (tenant_id, outlet_id, shift_id)
    REFERENCES public.pos_shifts(tenant_id, outlet_id, shift_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, outlet_id, terminal_id)
    REFERENCES public.terminals(tenant_id, outlet_id, terminal_id) ON DELETE RESTRICT
);

CREATE INDEX pos_cash_movements_outlet_shift ON public.pos_cash_movements(tenant_id, outlet_id, shift_id, occurred_at);

CREATE TABLE public.pos_audit_log (
  tenant_id uuid NOT NULL,
  outlet_id uuid NOT NULL,
  audit_id uuid NOT NULL,
  source_event_id uuid NOT NULL,
  terminal_id uuid NOT NULL,
  actor_id uuid,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  action text NOT NULL,
  reason text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz NOT NULL,
  projected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, outlet_id, audit_id),
  UNIQUE (tenant_id, outlet_id, source_event_id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES public.outlets(tenant_id, outlet_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, outlet_id, terminal_id)
    REFERENCES public.terminals(tenant_id, outlet_id, terminal_id) ON DELETE RESTRICT
);

CREATE INDEX pos_audit_log_outlet_history ON public.pos_audit_log(tenant_id, outlet_id, occurred_at DESC, audit_id);
CREATE INDEX pos_audit_log_outlet_entity ON public.pos_audit_log(tenant_id, outlet_id, entity_type, entity_id, occurred_at DESC);

ALTER TABLE public.pos_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_cash_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_audit_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.pos_orders, public.pos_order_items, public.pos_payments, public.pos_shifts,
  public.pos_cash_movements, public.pos_audit_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.pos_orders, public.pos_order_items, public.pos_payments, public.pos_shifts,
  public.pos_cash_movements, public.pos_audit_log TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.pos_orders, public.pos_order_items, public.pos_shifts TO service_role;
GRANT SELECT, INSERT ON public.pos_payments, public.pos_cash_movements, public.pos_audit_log TO service_role;

CREATE POLICY pos_orders_read_manager ON public.pos_orders
  FOR SELECT TO authenticated USING (private.can_manage_outlet(tenant_id, outlet_id));
CREATE POLICY pos_order_items_read_manager ON public.pos_order_items
  FOR SELECT TO authenticated USING (private.can_manage_outlet(tenant_id, outlet_id));
CREATE POLICY pos_payments_read_manager ON public.pos_payments
  FOR SELECT TO authenticated USING (private.can_manage_outlet(tenant_id, outlet_id));
CREATE POLICY pos_shifts_read_manager ON public.pos_shifts
  FOR SELECT TO authenticated USING (private.can_manage_outlet(tenant_id, outlet_id));
CREATE POLICY pos_cash_movements_read_manager ON public.pos_cash_movements
  FOR SELECT TO authenticated USING (private.can_manage_outlet(tenant_id, outlet_id));
CREATE POLICY pos_audit_log_read_manager ON public.pos_audit_log
  FOR SELECT TO authenticated USING (private.can_manage_outlet(tenant_id, outlet_id));

CREATE OR REPLACE FUNCTION private.project_pos_sync_event(p_event public.pos_sync_events)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  line jsonb;
BEGIN
  IF p_event.entity_type = 'order'
    AND jsonb_typeof(p_event.payload->'lines') = 'array'
    AND jsonb_typeof(p_event.payload) = 'object'
  THEN
    INSERT INTO public.pos_orders (
      tenant_id, outlet_id, order_id, terminal_id, order_number, order_type, table_label, guest_count,
      status, note, currency, subtotal_minor, tax_total_minor, tax_rate_bps, total_minor, invoice_number,
      created_at, updated_at, last_event_at, last_event_id
    ) VALUES (
      p_event.tenant_id, p_event.outlet_id, p_event.payload->>'id', p_event.terminal_id,
      p_event.payload->>'orderNumber', p_event.payload->>'orderType', p_event.payload->>'tableLabel',
      (p_event.payload->>'guestCount')::integer, p_event.payload->>'status', p_event.payload->>'note',
      coalesce(p_event.payload->>'currency', (
        SELECT o.currency FROM public.outlets o
        WHERE o.tenant_id = p_event.tenant_id AND o.outlet_id = p_event.outlet_id
      )), (p_event.payload->>'subtotalMinor')::bigint,
      (p_event.payload->>'taxTotalMinor')::bigint, (p_event.payload->>'taxRateBps')::integer,
      (p_event.payload->>'totalMinor')::bigint, p_event.payload->>'invoiceNumber',
      (p_event.payload->>'createdAt')::timestamptz,
      coalesce(nullif(p_event.payload->>'updatedAt', '')::timestamptz, p_event.occurred_at),
      p_event.occurred_at, p_event.event_id
    )
    ON CONFLICT (tenant_id, outlet_id, order_id) DO UPDATE SET
      terminal_id = EXCLUDED.terminal_id, order_number = EXCLUDED.order_number, order_type = EXCLUDED.order_type,
      table_label = EXCLUDED.table_label, guest_count = EXCLUDED.guest_count, status = EXCLUDED.status,
      note = EXCLUDED.note, currency = EXCLUDED.currency, subtotal_minor = EXCLUDED.subtotal_minor,
      tax_total_minor = EXCLUDED.tax_total_minor, tax_rate_bps = EXCLUDED.tax_rate_bps,
      total_minor = EXCLUDED.total_minor, invoice_number = EXCLUDED.invoice_number,
      created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at,
      last_event_at = EXCLUDED.last_event_at, last_event_id = EXCLUDED.last_event_id, projected_at = now()
    WHERE (public.pos_orders.last_event_at, public.pos_orders.last_event_id)
      <= (EXCLUDED.last_event_at, EXCLUDED.last_event_id);

    IF EXISTS (
      SELECT 1 FROM public.pos_orders o
      WHERE o.tenant_id = p_event.tenant_id AND o.outlet_id = p_event.outlet_id
        AND o.order_id = p_event.payload->>'id' AND o.last_event_id = p_event.event_id
    ) THEN
      FOR line IN SELECT value FROM jsonb_array_elements(p_event.payload->'lines') AS item(value)
      LOOP
        INSERT INTO public.pos_order_items (
          tenant_id, outlet_id, order_id, line_id, menu_item_id, name, category, quantity,
          unit_price_minor, line_total_minor, kitchen_station, note, modifiers, voided_at, void_reason,
          last_event_at, last_event_id
        ) VALUES (
          p_event.tenant_id, p_event.outlet_id, p_event.payload->>'id', line->>'id',
          coalesce(line->>'menuItemId', ''), line->>'name', coalesce(line->>'category', ''),
          (line->>'quantity')::integer, (line->>'unitPriceMinor')::bigint,
          (line->>'lineTotalMinor')::bigint, coalesce(line->>'kitchenStation', 'Main kitchen'),
          line->>'note', coalesce(line->'modifiers', '[]'::jsonb),
          nullif(line->>'voidedAt', '')::timestamptz, line->>'voidReason', p_event.occurred_at, p_event.event_id
        )
        ON CONFLICT (tenant_id, outlet_id, order_id, line_id) DO UPDATE SET
          menu_item_id = EXCLUDED.menu_item_id, name = EXCLUDED.name, category = EXCLUDED.category,
          quantity = EXCLUDED.quantity, unit_price_minor = EXCLUDED.unit_price_minor,
          line_total_minor = EXCLUDED.line_total_minor, kitchen_station = EXCLUDED.kitchen_station,
          note = EXCLUDED.note, modifiers = EXCLUDED.modifiers, voided_at = EXCLUDED.voided_at,
          void_reason = EXCLUDED.void_reason, last_event_at = EXCLUDED.last_event_at,
          last_event_id = EXCLUDED.last_event_id, projected_at = now()
        WHERE (public.pos_order_items.last_event_at, public.pos_order_items.last_event_id)
          <= (EXCLUDED.last_event_at, EXCLUDED.last_event_id);
      END LOOP;
    END IF;
  ELSIF p_event.entity_type = 'payment' AND p_event.action IN ('payment.recorded', 'payment.refunded') THEN
    INSERT INTO public.pos_payments (
      tenant_id, outlet_id, payment_id, source_event_id, order_id, shift_id, terminal_id, entry_type,
      method, amount_minor, status, command_id, refund_of, reason, invoice_number, occurred_at
    ) VALUES (
      p_event.tenant_id, p_event.outlet_id, p_event.entity_id, p_event.event_id,
      p_event.payload->>'orderId', nullif(p_event.payload->>'shiftId', ''), p_event.terminal_id,
      CASE WHEN p_event.action = 'payment.refunded' THEN 'refund' ELSE 'tender' END,
      p_event.payload->>'method', (p_event.payload->>'amountMinor')::bigint,
      coalesce(p_event.payload->>'status', 'succeeded'), p_event.payload->>'commandId',
      p_event.payload->>'paymentId', p_event.payload->>'reason', p_event.payload->>'invoiceNumber',
      coalesce(nullif(p_event.payload->>'createdAt', '')::timestamptz, p_event.occurred_at)
    ) ON CONFLICT (tenant_id, outlet_id, payment_id) DO NOTHING;
    IF p_event.action = 'payment.recorded' THEN
      UPDATE public.pos_orders SET status = 'paid', invoice_number = p_event.payload->>'invoiceNumber',
        updated_at = coalesce(nullif(p_event.payload->>'createdAt', '')::timestamptz, p_event.occurred_at),
        last_event_at = p_event.occurred_at, last_event_id = p_event.event_id, projected_at = now()
      WHERE tenant_id = p_event.tenant_id AND outlet_id = p_event.outlet_id
        AND order_id = p_event.payload->>'orderId'
        AND (last_event_at, last_event_id) <= (p_event.occurred_at, p_event.event_id);
    END IF;
  ELSIF p_event.entity_type = 'shift' AND p_event.action IN ('shift.opened', 'shift.closed') THEN
    INSERT INTO public.pos_shifts (
      tenant_id, outlet_id, shift_id, terminal_id, shift_number, status, opened_at, closed_at,
      opening_float_minor, expected_cash_minor, counted_cash_minor, variance_minor, last_event_at, last_event_id
    ) VALUES (
      p_event.tenant_id, p_event.outlet_id, p_event.entity_id, p_event.terminal_id,
      p_event.payload->>'shiftNumber', p_event.payload->>'status',
      (p_event.payload->>'openedAt')::timestamptz,
      nullif(p_event.payload->>'closedAt', '')::timestamptz,
      (p_event.payload->>'openingFloatMinor')::bigint,
      nullif(p_event.payload->>'expectedCashMinor', '')::bigint,
      nullif(p_event.payload->>'countedCashMinor', '')::bigint,
      nullif(p_event.payload->>'varianceMinor', '')::bigint, p_event.occurred_at, p_event.event_id
    )
    ON CONFLICT (tenant_id, outlet_id, shift_id) DO UPDATE SET
      shift_number = EXCLUDED.shift_number, status = EXCLUDED.status, opened_at = EXCLUDED.opened_at,
      closed_at = EXCLUDED.closed_at, opening_float_minor = EXCLUDED.opening_float_minor,
      expected_cash_minor = EXCLUDED.expected_cash_minor, counted_cash_minor = EXCLUDED.counted_cash_minor,
      variance_minor = EXCLUDED.variance_minor, last_event_at = EXCLUDED.last_event_at,
      last_event_id = EXCLUDED.last_event_id, projected_at = now()
    WHERE (public.pos_shifts.last_event_at, public.pos_shifts.last_event_id)
      <= (EXCLUDED.last_event_at, EXCLUDED.last_event_id);
  ELSIF p_event.entity_type = 'cash_movement' AND p_event.action IN ('shift.cash_in', 'shift.cash_out') THEN
    INSERT INTO public.pos_cash_movements (
      tenant_id, outlet_id, movement_id, source_event_id, shift_id, terminal_id, actor_id,
      movement_type, amount_minor, reason, command_id, occurred_at
    ) VALUES (
      p_event.tenant_id, p_event.outlet_id, p_event.entity_id, p_event.event_id,
      p_event.payload->>'shiftId', p_event.terminal_id, nullif(p_event.payload->>'actorId', '')::uuid,
      p_event.payload->>'movementType', (p_event.payload->>'amountMinor')::bigint,
      p_event.payload->>'reason', p_event.payload->>'commandId', p_event.occurred_at
    ) ON CONFLICT (tenant_id, outlet_id, movement_id) DO NOTHING;
  ELSIF p_event.entity_type = 'audit' THEN
    INSERT INTO public.pos_audit_log (
      tenant_id, outlet_id, audit_id, source_event_id, terminal_id, actor_id,
      entity_type, entity_id, action, reason, payload, occurred_at
    ) VALUES (
      p_event.tenant_id, p_event.outlet_id, p_event.event_id, p_event.event_id, p_event.terminal_id,
      nullif(p_event.payload->>'actorId', '')::uuid, coalesce(p_event.payload->>'entityType', 'unknown'),
      coalesce(p_event.payload->>'entityId', p_event.entity_id), p_event.action,
      p_event.payload->>'reason', coalesce(p_event.payload->'payload', '{}'::jsonb), p_event.occurred_at
    ) ON CONFLICT (tenant_id, outlet_id, audit_id) DO NOTHING;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION private.on_pos_sync_event_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  PERFORM private.project_pos_sync_event(NEW);
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.project_pos_sync_event(public.pos_sync_events) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.on_pos_sync_event_insert() FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA private TO service_role;
GRANT EXECUTE ON FUNCTION private.project_pos_sync_event(public.pos_sync_events) TO service_role;
GRANT EXECUTE ON FUNCTION private.on_pos_sync_event_insert() TO service_role;

CREATE TRIGGER pos_sync_events_project_after_insert
  AFTER INSERT ON public.pos_sync_events
  FOR EACH ROW EXECUTE FUNCTION private.on_pos_sync_event_insert();

DO $backfill$
DECLARE
  event_row public.pos_sync_events%ROWTYPE;
BEGIN
  FOR event_row IN SELECT * FROM public.pos_sync_events ORDER BY occurred_at, event_id LOOP
    PERFORM private.project_pos_sync_event(event_row);
  END LOOP;
END;
$backfill$;

COMMIT;
