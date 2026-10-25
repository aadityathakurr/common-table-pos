BEGIN;

CREATE TABLE public.inventory_recipe_components (
  tenant_id uuid NOT NULL,
  outlet_id uuid NOT NULL,
  menu_item_id text NOT NULL,
  inventory_item_id uuid NOT NULL,
  quantity_per_sale numeric(14,3) NOT NULL CHECK (quantity_per_sale > 0 AND quantity_per_sale <= 1000000000),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, outlet_id, menu_item_id, inventory_item_id),
  FOREIGN KEY (tenant_id, outlet_id, menu_item_id)
    REFERENCES public.menu_items(tenant_id, outlet_id, item_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, outlet_id, inventory_item_id)
    REFERENCES public.inventory_items(tenant_id, outlet_id, inventory_item_id) ON DELETE RESTRICT
);
CREATE INDEX inventory_recipe_components_by_stock_item
  ON public.inventory_recipe_components(tenant_id, outlet_id, inventory_item_id, menu_item_id);

ALTER TABLE public.inventory_recipe_components ENABLE ROW LEVEL SECURITY;
CREATE POLICY inventory_recipe_components_read_outlet ON public.inventory_recipe_components
  FOR SELECT TO authenticated USING (private.can_access_outlet(tenant_id, outlet_id));
CREATE POLICY inventory_recipe_components_create_manager ON public.inventory_recipe_components
  FOR INSERT TO authenticated WITH CHECK (
    created_by = (SELECT auth.uid()) AND private.can_manage_outlet(tenant_id, outlet_id)
  );
CREATE POLICY inventory_recipe_components_update_manager ON public.inventory_recipe_components
  FOR UPDATE TO authenticated USING (private.can_manage_outlet(tenant_id, outlet_id))
  WITH CHECK (private.can_manage_outlet(tenant_id, outlet_id));
CREATE POLICY inventory_recipe_components_delete_manager ON public.inventory_recipe_components
  FOR DELETE TO authenticated USING (private.can_manage_outlet(tenant_id, outlet_id));
REVOKE ALL ON public.inventory_recipe_components FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inventory_recipe_components TO authenticated;

ALTER TABLE public.pos_sync_events DROP CONSTRAINT pos_sync_events_entity_type_check;
ALTER TABLE public.pos_sync_events ADD CONSTRAINT pos_sync_events_entity_type_check
  CHECK (entity_type IN ('order','payment','shift','cash_movement','audit','inventory'));

ALTER TABLE public.inventory_movements DROP CONSTRAINT inventory_movements_movement_type_check;
ALTER TABLE public.inventory_movements ADD CONSTRAINT inventory_movements_movement_type_check
  CHECK (movement_type IN ('receipt','waste','count_adjustment','transfer_in','transfer_out','sale_consumption'));
ALTER TABLE public.inventory_movements DROP CONSTRAINT inventory_movements_check;
ALTER TABLE public.inventory_movements ADD CONSTRAINT inventory_movements_check CHECK (
  (movement_type = 'receipt' AND request_quantity > 0 AND expected_balance IS NULL AND quantity_delta = request_quantity)
  OR (movement_type = 'waste' AND request_quantity > 0 AND expected_balance IS NULL AND quantity_delta = -request_quantity)
  OR (movement_type IN ('transfer_in','transfer_out') AND request_quantity > 0 AND expected_balance IS NULL
    AND quantity_delta = CASE WHEN movement_type = 'transfer_in' THEN request_quantity ELSE -request_quantity END)
  OR (movement_type = 'sale_consumption' AND request_quantity > 0 AND expected_balance IS NULL AND quantity_delta = -request_quantity)
  OR (movement_type = 'count_adjustment' AND expected_balance IS NOT NULL
    AND quantity_delta = request_quantity - expected_balance)
);

CREATE FUNCTION private.project_inventory_sync_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_item_id uuid;
  v_actor_id uuid;
  v_quantity numeric(14,3);
  v_movement_id uuid;
  v_command_id text;
  v_reason text;
  v_occurred_at timestamptz;
  v_existing public.inventory_movements%ROWTYPE;
BEGIN
  IF NEW.entity_type <> 'inventory' OR NEW.action <> 'inventory.sale_consumed' THEN
    RETURN NEW;
  END IF;

  BEGIN
    v_item_id := (NEW.payload->>'inventoryItemId')::uuid;
    v_actor_id := (NEW.payload->>'actorId')::uuid;
    v_movement_id := (NEW.payload->>'movementId')::uuid;
    v_quantity := (NEW.payload->>'quantity')::numeric(14,3);
    v_command_id := NEW.payload->>'commandId';
    v_reason := NEW.payload->>'reason';
    v_occurred_at := coalesce(nullif(NEW.payload->>'occurredAt','')::timestamptz, NEW.occurred_at);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Invalid inventory event payload.' USING ERRCODE = '22023';
  END;
  IF v_quantity IS NULL OR v_quantity <= 0 OR v_quantity > 1000000000
     OR v_command_id IS NULL OR length(trim(v_command_id)) NOT BETWEEN 8 AND 160
     OR v_reason IS NULL OR length(trim(v_reason)) NOT BETWEEN 3 AND 120
     OR v_actor_id IS NULL OR v_movement_id IS NULL THEN
    RAISE EXCEPTION 'Invalid inventory event details.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing FROM public.inventory_movements
  WHERE tenant_id = NEW.tenant_id AND outlet_id = NEW.outlet_id AND command_id = v_command_id;
  IF FOUND THEN
    IF v_existing.movement_id <> v_movement_id OR v_existing.inventory_item_id <> v_item_id
       OR v_existing.movement_type <> 'sale_consumption' OR v_existing.request_quantity <> v_quantity
       OR v_existing.actor_id <> v_actor_id OR v_existing.reason <> trim(v_reason) THEN
      RAISE EXCEPTION 'Inventory command ID was reused with different details.' USING ERRCODE = '23505';
    END IF;
    RETURN NEW;
  END IF;

  INSERT INTO public.inventory_movements (
    movement_id, tenant_id, outlet_id, inventory_item_id, command_id, movement_type,
    request_quantity, expected_balance, quantity_delta, reason, actor_id, occurred_at
  ) VALUES (
    v_movement_id, NEW.tenant_id, NEW.outlet_id, v_item_id, v_command_id, 'sale_consumption',
    v_quantity, NULL, -v_quantity, trim(v_reason), v_actor_id, v_occurred_at
  );
  INSERT INTO public.outlet_audit_events (
    tenant_id, outlet_id, actor_id, entity_type, entity_id, action, reason, payload, occurred_at
  ) VALUES (
    NEW.tenant_id, NEW.outlet_id, v_actor_id, 'inventory_item', v_item_id::text,
    'inventory.sale_consumed', trim(v_reason),
    jsonb_build_object('movementId', v_movement_id, 'quantity', v_quantity, 'orderId', NEW.payload->>'orderId'), v_occurred_at
  );
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.project_inventory_sync_event() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER pos_sync_events_project_inventory_after_insert
  AFTER INSERT ON public.pos_sync_events
  FOR EACH ROW WHEN (NEW.entity_type = 'inventory')
  EXECUTE FUNCTION private.project_inventory_sync_event();

COMMIT;
