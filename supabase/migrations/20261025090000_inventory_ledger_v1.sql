BEGIN;

CREATE TABLE public.inventory_items (
  tenant_id uuid NOT NULL,
  outlet_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  sku text CHECK (sku IS NULL OR length(trim(sku)) BETWEEN 1 AND 80),
  unit text NOT NULL CHECK (unit IN ('each','g','kg','ml','l','portion','pack')),
  reorder_level numeric(14,3) NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, outlet_id, inventory_item_id),
  UNIQUE (tenant_id, outlet_id, name),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES public.outlets(tenant_id, outlet_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX inventory_items_by_sku
  ON public.inventory_items(tenant_id, outlet_id, lower(sku)) WHERE sku IS NOT NULL;
CREATE INDEX inventory_items_by_outlet_active
  ON public.inventory_items(tenant_id, outlet_id, active, name);

CREATE TABLE public.inventory_movements (
  movement_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  outlet_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  command_id text NOT NULL CHECK (length(trim(command_id)) BETWEEN 8 AND 160),
  movement_type text NOT NULL CHECK (movement_type IN ('receipt','waste','count_adjustment','transfer_in','transfer_out')),
  request_quantity numeric(14,3) NOT NULL CHECK (request_quantity >= 0),
  expected_balance numeric(14,3),
  quantity_delta numeric(14,3) NOT NULL,
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 120),
  actor_id uuid NOT NULL REFERENCES auth.users(id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, outlet_id, command_id),
  FOREIGN KEY (tenant_id, outlet_id, inventory_item_id)
    REFERENCES public.inventory_items(tenant_id, outlet_id, inventory_item_id) ON DELETE RESTRICT,
  CHECK (
    (movement_type = 'receipt' AND request_quantity > 0 AND expected_balance IS NULL AND quantity_delta = request_quantity)
    OR (movement_type = 'waste' AND request_quantity > 0 AND expected_balance IS NULL AND quantity_delta = -request_quantity)
    OR (movement_type IN ('transfer_in','transfer_out') AND request_quantity > 0 AND expected_balance IS NULL
      AND quantity_delta = CASE WHEN movement_type = 'transfer_in' THEN request_quantity ELSE -request_quantity END)
    OR (movement_type = 'count_adjustment' AND expected_balance IS NOT NULL
      AND quantity_delta = request_quantity - expected_balance)
  )
);
CREATE INDEX inventory_movements_by_item_history
  ON public.inventory_movements(tenant_id, outlet_id, inventory_item_id, occurred_at DESC, movement_id DESC);
CREATE INDEX inventory_movements_by_outlet_history
  ON public.inventory_movements(tenant_id, outlet_id, occurred_at DESC, movement_id DESC);

ALTER TABLE public.inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_movements ENABLE ROW LEVEL SECURITY;

CREATE POLICY inventory_items_read_outlet ON public.inventory_items FOR SELECT TO authenticated
  USING (private.can_access_outlet(tenant_id, outlet_id));
CREATE POLICY inventory_items_create_manager ON public.inventory_items FOR INSERT TO authenticated
  WITH CHECK (created_by = (SELECT auth.uid()) AND private.can_manage_outlet(tenant_id, outlet_id));
CREATE POLICY inventory_items_update_manager ON public.inventory_items FOR UPDATE TO authenticated
  USING (private.can_manage_outlet(tenant_id, outlet_id))
  WITH CHECK (private.can_manage_outlet(tenant_id, outlet_id));
CREATE POLICY inventory_movements_read_outlet ON public.inventory_movements FOR SELECT TO authenticated
  USING (private.can_access_outlet(tenant_id, outlet_id));

REVOKE ALL ON public.inventory_items, public.inventory_movements FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.inventory_items TO authenticated;
GRANT SELECT ON public.inventory_movements TO authenticated;

CREATE VIEW public.inventory_stock_balances WITH (security_invoker = true) AS
SELECT i.tenant_id, i.outlet_id, i.inventory_item_id, i.name, i.sku, i.unit,
  i.reorder_level, i.active,
  COALESCE(SUM(m.quantity_delta), 0)::numeric(14,3) AS on_hand,
  COALESCE(SUM(m.quantity_delta), 0) <= i.reorder_level AS low_stock
FROM public.inventory_items i
LEFT JOIN public.inventory_movements m
  ON m.tenant_id = i.tenant_id AND m.outlet_id = i.outlet_id
  AND m.inventory_item_id = i.inventory_item_id
GROUP BY i.tenant_id, i.outlet_id, i.inventory_item_id;
REVOKE ALL ON public.inventory_stock_balances FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.inventory_stock_balances TO authenticated;

CREATE FUNCTION public.record_inventory_movement(
  p_tenant_id uuid,
  p_outlet_id uuid,
  p_inventory_item_id uuid,
  p_command_id text,
  p_movement_type text,
  p_quantity numeric,
  p_reason text,
  p_expected_balance numeric DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := (SELECT auth.uid());
  v_existing public.inventory_movements%ROWTYPE;
  v_current_balance numeric(14,3);
  v_delta numeric(14,3);
  v_movement_id uuid;
  v_occurred_at timestamptz := now();
BEGIN
  IF v_actor_id IS NULL OR NOT private.can_manage_outlet(p_tenant_id, p_outlet_id) THEN
    RAISE EXCEPTION 'Manager access to this outlet is required.' USING ERRCODE = '42501';
  END IF;
  IF p_command_id IS NULL OR length(trim(p_command_id)) NOT BETWEEN 8 AND 160
     OR p_movement_type NOT IN ('receipt','waste','count_adjustment')
     OR p_quantity IS NULL OR p_quantity < 0 OR p_quantity > 1000000000
     OR p_quantity::numeric(14,3) <> p_quantity
     OR length(trim(coalesce(p_reason,''))) NOT BETWEEN 3 AND 120 THEN
    RAISE EXCEPTION 'Invalid stock movement details.' USING ERRCODE = '22023';
  END IF;
  IF p_movement_type <> 'count_adjustment' AND (p_quantity = 0 OR p_expected_balance IS NOT NULL) THEN
    RAISE EXCEPTION 'Receipt and waste quantities must be positive.' USING ERRCODE = '22023';
  END IF;
  IF p_movement_type = 'count_adjustment' AND (p_expected_balance IS NULL OR p_expected_balance::numeric(14,3) <> p_expected_balance) THEN
    RAISE EXCEPTION 'Refresh the item balance before saving this stock count.' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text || ':' || p_outlet_id::text || ':' || p_command_id, 0
  ));
  SELECT * INTO v_existing FROM public.inventory_movements
  WHERE tenant_id = p_tenant_id AND outlet_id = p_outlet_id AND command_id = p_command_id;
  IF FOUND THEN
    IF v_existing.inventory_item_id <> p_inventory_item_id
      OR v_existing.movement_type <> p_movement_type
      OR v_existing.request_quantity <> p_quantity
      OR v_existing.reason <> trim(p_reason)
      OR v_existing.expected_balance IS DISTINCT FROM p_expected_balance THEN
      RAISE EXCEPTION 'This command ID was already used for different stock details.' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.movement_id;
  END IF;

  PERFORM 1 FROM public.inventory_items
  WHERE tenant_id = p_tenant_id AND outlet_id = p_outlet_id
    AND inventory_item_id = p_inventory_item_id AND active
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active inventory item not found for this outlet.' USING ERRCODE = '23503';
  END IF;

  IF p_movement_type = 'count_adjustment' THEN
    SELECT COALESCE(SUM(quantity_delta), 0)::numeric(14,3) INTO v_current_balance
    FROM public.inventory_movements
    WHERE tenant_id = p_tenant_id AND outlet_id = p_outlet_id AND inventory_item_id = p_inventory_item_id;
    IF v_current_balance <> p_expected_balance THEN
      RAISE EXCEPTION 'Stock changed after this count began. Refresh and count again.' USING ERRCODE = '40001';
    END IF;
    v_delta := p_quantity - v_current_balance;
  ELSE
    v_delta := CASE WHEN p_movement_type = 'waste' THEN -p_quantity ELSE p_quantity END;
  END IF;

  INSERT INTO public.inventory_movements (
    tenant_id, outlet_id, inventory_item_id, command_id, movement_type,
    request_quantity, expected_balance, quantity_delta, reason, actor_id, occurred_at
  ) VALUES (
    p_tenant_id, p_outlet_id, p_inventory_item_id, trim(p_command_id), p_movement_type,
    p_quantity, p_expected_balance, v_delta, trim(p_reason), v_actor_id, v_occurred_at
  ) RETURNING movement_id INTO v_movement_id;

  INSERT INTO public.outlet_audit_events (
    tenant_id, outlet_id, actor_id, entity_type, entity_id, action, reason, payload, occurred_at
  ) VALUES (
    p_tenant_id, p_outlet_id, v_actor_id, 'inventory_item', p_inventory_item_id::text,
    'inventory.' || p_movement_type, trim(p_reason),
    jsonb_build_object('movementId', v_movement_id, 'quantityDelta', v_delta, 'quantity', p_quantity), v_occurred_at
  );
  RETURN v_movement_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_inventory_movement(uuid, uuid, uuid, text, text, numeric, text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_inventory_movement(uuid, uuid, uuid, text, text, numeric, text, numeric) TO authenticated;

COMMIT;
