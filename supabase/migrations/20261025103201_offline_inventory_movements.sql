BEGIN;

CREATE OR REPLACE FUNCTION private.project_inventory_sync_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_item_id uuid;
  v_actor_id uuid;
  v_quantity numeric(14,3);
  v_expected numeric(14,3);
  v_delta numeric(14,3);
  v_movement_id uuid;
  v_command_id text;
  v_reason text;
  v_movement_type text;
  v_occurred_at timestamptz;
  v_existing public.inventory_movements%ROWTYPE;
  v_current_balance numeric(14,3);
BEGIN
  IF NEW.entity_type <> 'inventory' THEN RETURN NEW; END IF;
  IF NEW.action NOT IN ('inventory.sale_consumed','inventory.receipt','inventory.waste','inventory.count_adjustment') THEN
    RAISE EXCEPTION 'Unsupported inventory event action.' USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_item_id := (NEW.payload->>'inventoryItemId')::uuid;
    v_actor_id := (NEW.payload->>'actorId')::uuid;
    v_movement_id := (NEW.payload->>'movementId')::uuid;
    v_quantity := (NEW.payload->>'quantity')::numeric(14,3);
    v_expected := nullif(NEW.payload->>'expectedBalance','null')::numeric(14,3);
    v_command_id := NEW.payload->>'commandId';
    v_reason := NEW.payload->>'reason';
    v_occurred_at := coalesce(nullif(NEW.payload->>'occurredAt','')::timestamptz, NEW.occurred_at);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Invalid inventory event payload.' USING ERRCODE = '22023';
  END;

  v_movement_type := CASE NEW.action
    WHEN 'inventory.sale_consumed' THEN 'sale_consumption'
    ELSE split_part(NEW.action,'.',2) END;
  IF (v_movement_type='sale_consumption' AND NEW.payload ? 'movementType')
     OR (v_movement_type<>'sale_consumption' AND NEW.payload->>'movementType' IS DISTINCT FROM v_movement_type)
     OR v_quantity IS NULL OR v_quantity < 0 OR v_quantity > 1000000000
     OR (v_movement_type <> 'count_adjustment' AND v_quantity = 0)
     OR v_command_id IS NULL OR length(trim(v_command_id)) NOT BETWEEN 8 AND 160
     OR v_reason IS NULL OR length(trim(v_reason)) NOT BETWEEN 3 AND 120
     OR v_actor_id IS NULL OR v_movement_id IS NULL THEN
    RAISE EXCEPTION 'Invalid inventory event details.' USING ERRCODE = '22023';
  END IF;
  IF (v_movement_type='count_adjustment' AND v_expected IS NULL)
     OR (v_movement_type<>'count_adjustment' AND v_expected IS NOT NULL) THEN
    RAISE EXCEPTION 'Invalid inventory count baseline.' USING ERRCODE = '22023';
  END IF;
  IF v_movement_type <> 'sale_consumption' AND NOT (
    EXISTS (SELECT 1 FROM public.tenant_memberships m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=v_actor_id
      AND m.status='active' AND m.role IN ('owner','manager'))
    OR EXISTS (SELECT 1 FROM public.outlet_memberships m WHERE m.tenant_id=NEW.tenant_id AND m.outlet_id=NEW.outlet_id
      AND m.user_id=v_actor_id AND m.status='active' AND m.role IN ('owner','manager'))
  ) THEN
    RAISE EXCEPTION 'Inventory movement actor is not an active outlet manager.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_existing FROM public.inventory_movements
  WHERE tenant_id=NEW.tenant_id AND outlet_id=NEW.outlet_id AND command_id=v_command_id;
  IF FOUND THEN
    IF v_existing.movement_id<>v_movement_id OR v_existing.inventory_item_id<>v_item_id
       OR v_existing.movement_type<>v_movement_type OR v_existing.request_quantity<>v_quantity
       OR v_existing.expected_balance IS DISTINCT FROM v_expected OR v_existing.actor_id<>v_actor_id
       OR v_existing.reason<>trim(v_reason) THEN
      RAISE EXCEPTION 'Inventory command ID was reused with different details.' USING ERRCODE = '23505';
    END IF;
    RETURN NEW;
  END IF;

  PERFORM 1 FROM public.inventory_items
    WHERE tenant_id=NEW.tenant_id AND outlet_id=NEW.outlet_id AND inventory_item_id=v_item_id AND active
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active inventory item not found for this outlet.' USING ERRCODE = '23503'; END IF;

  IF v_movement_type='count_adjustment' THEN
    SELECT COALESCE(SUM(quantity_delta),0)::numeric(14,3) INTO v_current_balance
      FROM public.inventory_movements WHERE tenant_id=NEW.tenant_id AND outlet_id=NEW.outlet_id AND inventory_item_id=v_item_id;
    IF v_current_balance<>v_expected THEN
      RAISE EXCEPTION 'Stock changed after this count began. Refresh inventory and count again.' USING ERRCODE = '40001';
    END IF;
    v_delta:=v_quantity-v_current_balance;
  ELSE
    v_delta:=CASE v_movement_type WHEN 'waste' THEN -v_quantity WHEN 'sale_consumption' THEN -v_quantity ELSE v_quantity END;
  END IF;

  INSERT INTO public.inventory_movements (
    movement_id,tenant_id,outlet_id,inventory_item_id,command_id,movement_type,
    request_quantity,expected_balance,quantity_delta,reason,actor_id,occurred_at
  ) VALUES (v_movement_id,NEW.tenant_id,NEW.outlet_id,v_item_id,v_command_id,v_movement_type,
    v_quantity,v_expected,v_delta,trim(v_reason),v_actor_id,v_occurred_at);
  INSERT INTO public.outlet_audit_events (
    tenant_id,outlet_id,actor_id,entity_type,entity_id,action,reason,payload,occurred_at
  ) VALUES (NEW.tenant_id,NEW.outlet_id,v_actor_id,'inventory_item',v_item_id::text,
    NEW.action,trim(v_reason),jsonb_build_object('movementId',v_movement_id,'quantityDelta',v_delta,
      'quantity',v_quantity,'orderId',NEW.payload->>'orderId'),v_occurred_at);
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.project_inventory_sync_event() FROM PUBLIC, anon, authenticated;

COMMIT;
