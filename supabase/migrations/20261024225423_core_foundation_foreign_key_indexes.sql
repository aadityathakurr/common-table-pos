CREATE INDEX tenants_by_creator ON public.tenants(created_by);
CREATE INDEX dining_tables_by_area ON public.dining_tables(tenant_id, outlet_id, area_id);
CREATE INDEX staff_invitations_by_inviter ON public.staff_invitations(invited_by);
CREATE INDEX staff_invitations_by_outlet ON public.staff_invitations(tenant_id, outlet_id);
CREATE INDEX terminals_by_enroller ON public.terminals(enrolled_by);
CREATE INDEX outlet_audit_events_by_actor ON public.outlet_audit_events(actor_id);
