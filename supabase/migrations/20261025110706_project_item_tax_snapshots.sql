BEGIN;

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
          tax_code, tax_rate_bps, last_event_at, last_event_id
        ) VALUES (
          p_event.tenant_id, p_event.outlet_id, p_event.payload->>'id', line->>'id',
          coalesce(line->>'menuItemId', ''), line->>'name', coalesce(line->>'category', ''),
          (line->>'quantity')::integer, (line->>'unitPriceMinor')::bigint,
          (line->>'lineTotalMinor')::bigint, coalesce(line->>'kitchenStation', 'Main kitchen'),
          line->>'note', coalesce(line->'modifiers', '[]'::jsonb),
          nullif(line->>'voidedAt', '')::timestamptz, line->>'voidReason', line->>'taxCode',
          coalesce(nullif(line->>'taxRateBps', '')::integer, nullif(p_event.payload->>'taxRateBps', '')::integer, 0),
          p_event.occurred_at, p_event.event_id
        )
        ON CONFLICT (tenant_id, outlet_id, order_id, line_id) DO UPDATE SET
          menu_item_id = EXCLUDED.menu_item_id, name = EXCLUDED.name, category = EXCLUDED.category,
          quantity = EXCLUDED.quantity, unit_price_minor = EXCLUDED.unit_price_minor,
          line_total_minor = EXCLUDED.line_total_minor, kitchen_station = EXCLUDED.kitchen_station,
          note = EXCLUDED.note, modifiers = EXCLUDED.modifiers, voided_at = EXCLUDED.voided_at,
          void_reason = EXCLUDED.void_reason, tax_code = EXCLUDED.tax_code, tax_rate_bps = EXCLUDED.tax_rate_bps,
          last_event_at = EXCLUDED.last_event_at,
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

COMMIT;
