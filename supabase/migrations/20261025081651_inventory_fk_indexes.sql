BEGIN;

CREATE INDEX inventory_items_by_creator ON public.inventory_items(created_by);
CREATE INDEX inventory_movements_by_actor ON public.inventory_movements(actor_id);

COMMIT;
