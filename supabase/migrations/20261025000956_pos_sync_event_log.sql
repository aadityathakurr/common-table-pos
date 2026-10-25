BEGIN;

CREATE TABLE public.pos_sync_events (
  tenant_id uuid NOT NULL,
  outlet_id uuid NOT NULL,
  terminal_id uuid NOT NULL,
  event_id uuid NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('order','payment','shift','cash_movement','audit')),
  entity_id text NOT NULL CHECK (length(trim(entity_id)) BETWEEN 1 AND 120),
  action text NOT NULL CHECK (length(trim(action)) BETWEEN 1 AND 80),
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, outlet_id, terminal_id, event_id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES public.outlets(tenant_id, outlet_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, outlet_id, terminal_id)
    REFERENCES public.terminals(tenant_id, outlet_id, terminal_id) ON DELETE RESTRICT
);

CREATE INDEX pos_sync_events_outlet_history
  ON public.pos_sync_events(tenant_id, outlet_id, occurred_at DESC);
CREATE INDEX pos_sync_events_outlet_type
  ON public.pos_sync_events(tenant_id, outlet_id, entity_type, occurred_at DESC);

ALTER TABLE public.pos_sync_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pos_sync_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.pos_sync_events TO authenticated;
GRANT INSERT ON public.pos_sync_events TO service_role;

CREATE POLICY pos_sync_events_read_manager ON public.pos_sync_events
  FOR SELECT TO authenticated USING (private.can_manage_outlet(tenant_id, outlet_id));

GRANT SELECT, UPDATE (last_seen_at) ON public.terminals TO service_role;

COMMIT;
