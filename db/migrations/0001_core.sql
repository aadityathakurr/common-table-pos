-- Common Table POS cloud foundation for Supabase/PostgreSQL 17.
-- Identity is owned by Supabase Auth; no application password hashes are stored.
-- Every public table has RLS enabled and explicit authenticated grants.

BEGIN;

CREATE SCHEMA private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA private TO authenticated;

CREATE TABLE public.profiles (
    user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email text NOT NULL,
    display_name text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.tenants (
    tenant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
    created_by uuid NOT NULL REFERENCES auth.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenants_by_creator ON public.tenants(created_by);

CREATE TABLE public.tenant_memberships (
    tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('owner','manager','cashier','kitchen','viewer')),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','disabled')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX tenant_memberships_by_user ON public.tenant_memberships(user_id, status, tenant_id);

CREATE TABLE public.brands (
    tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
    brand_id uuid NOT NULL DEFAULT gen_random_uuid(),
    name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, brand_id)
);

CREATE TABLE public.outlets (
    tenant_id uuid NOT NULL,
    outlet_id uuid NOT NULL DEFAULT gen_random_uuid(),
    brand_id uuid NOT NULL,
    name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
    timezone text NOT NULL DEFAULT 'Asia/Kolkata',
    currency char(3) NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
    tax_rate_bps integer NOT NULL DEFAULT 0 CHECK (tax_rate_bps BETWEEN 0 AND 10000),
    receipt_name text,
    receipt_address text,
    receipt_phone text,
    gstin text CHECK (gstin IS NULL OR gstin ~ '^[0-9A-Z]{15}$'),
    receipt_footer text,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','closed')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, outlet_id),
    FOREIGN KEY (tenant_id, brand_id) REFERENCES public.brands(tenant_id, brand_id)
);
CREATE INDEX outlets_by_brand ON public.outlets(tenant_id, brand_id, status);

CREATE TABLE public.outlet_memberships (
    tenant_id uuid NOT NULL,
    outlet_id uuid NOT NULL,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('manager','cashier','kitchen','viewer')),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','disabled')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, outlet_id, user_id),
    FOREIGN KEY (tenant_id, outlet_id) REFERENCES public.outlets(tenant_id, outlet_id) ON DELETE CASCADE
);
CREATE INDEX outlet_memberships_by_user ON public.outlet_memberships(user_id, status, tenant_id, outlet_id);

CREATE TABLE public.staff_invitations (
    invitation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
    outlet_id uuid,
    email text NOT NULL CHECK (length(trim(email)) BETWEEN 3 AND 320),
    role text NOT NULL CHECK (role IN ('manager','cashier','kitchen','viewer')),
    token_hash text NOT NULL UNIQUE,
    invited_by uuid NOT NULL REFERENCES auth.users(id),
    expires_at timestamptz NOT NULL,
    accepted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, outlet_id) REFERENCES public.outlets(tenant_id, outlet_id) ON DELETE CASCADE
);
CREATE INDEX staff_invitations_pending ON public.staff_invitations(tenant_id, expires_at) WHERE accepted_at IS NULL;
CREATE INDEX staff_invitations_by_inviter ON public.staff_invitations(invited_by);
CREATE INDEX staff_invitations_by_outlet ON public.staff_invitations(tenant_id, outlet_id);

CREATE TABLE public.terminals (
    tenant_id uuid NOT NULL,
    outlet_id uuid NOT NULL,
    terminal_id uuid NOT NULL DEFAULT gen_random_uuid(),
    name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
    device_key_hash text NOT NULL,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
    enrolled_by uuid NOT NULL REFERENCES auth.users(id),
    enrolled_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz,
    PRIMARY KEY (tenant_id, outlet_id, terminal_id),
    UNIQUE (tenant_id, device_key_hash),
    FOREIGN KEY (tenant_id, outlet_id) REFERENCES public.outlets(tenant_id, outlet_id) ON DELETE CASCADE
);
CREATE INDEX terminals_by_outlet_status ON public.terminals(tenant_id, outlet_id, status);
CREATE INDEX terminals_by_enroller ON public.terminals(enrolled_by);

CREATE TABLE public.dining_areas (
    tenant_id uuid NOT NULL,
    outlet_id uuid NOT NULL,
    area_id uuid NOT NULL DEFAULT gen_random_uuid(),
    name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
    sort_order integer NOT NULL DEFAULT 0,
    active boolean NOT NULL DEFAULT true,
    PRIMARY KEY (tenant_id, outlet_id, area_id),
    UNIQUE (tenant_id, outlet_id, name),
    FOREIGN KEY (tenant_id, outlet_id) REFERENCES public.outlets(tenant_id, outlet_id) ON DELETE CASCADE
);

CREATE TABLE public.dining_tables (
    tenant_id uuid NOT NULL,
    outlet_id uuid NOT NULL,
    table_id uuid NOT NULL DEFAULT gen_random_uuid(),
    area_id uuid NOT NULL,
    name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 40),
    capacity integer NOT NULL DEFAULT 2 CHECK (capacity BETWEEN 1 AND 50),
    sort_order integer NOT NULL DEFAULT 0,
    active boolean NOT NULL DEFAULT true,
    PRIMARY KEY (tenant_id, outlet_id, table_id),
    UNIQUE (tenant_id, outlet_id, name),
    FOREIGN KEY (tenant_id, outlet_id, area_id) REFERENCES public.dining_areas(tenant_id, outlet_id, area_id) ON DELETE CASCADE
);
CREATE INDEX dining_tables_by_area ON public.dining_tables(tenant_id, outlet_id, area_id);

CREATE TABLE public.kitchen_stations (
    tenant_id uuid NOT NULL,
    outlet_id uuid NOT NULL,
    station_id uuid NOT NULL DEFAULT gen_random_uuid(),
    name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
    sort_order integer NOT NULL DEFAULT 0,
    active boolean NOT NULL DEFAULT true,
    PRIMARY KEY (tenant_id, outlet_id, station_id),
    UNIQUE (tenant_id, outlet_id, name),
    FOREIGN KEY (tenant_id, outlet_id) REFERENCES public.outlets(tenant_id, outlet_id) ON DELETE CASCADE
);

CREATE TABLE public.outlet_audit_events (
    event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    outlet_id uuid NOT NULL,
    actor_id uuid NOT NULL REFERENCES auth.users(id),
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    action text NOT NULL,
    reason text,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, outlet_id) REFERENCES public.outlets(tenant_id, outlet_id) ON DELETE CASCADE
);
CREATE INDEX outlet_audit_events_history ON public.outlet_audit_events(tenant_id, outlet_id, occurred_at DESC);
CREATE INDEX outlet_audit_events_by_actor ON public.outlet_audit_events(actor_id);

CREATE FUNCTION private.is_tenant_member(p_tenant_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.tenant_memberships m
    WHERE m.tenant_id = p_tenant_id AND m.user_id = (SELECT auth.uid()) AND m.status = 'active'
  );
$$;

CREATE FUNCTION private.is_tenant_admin(p_tenant_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.tenant_memberships m
    WHERE m.tenant_id = p_tenant_id AND m.user_id = (SELECT auth.uid())
      AND m.status = 'active' AND m.role IN ('owner','manager')
  );
$$;

CREATE FUNCTION private.is_tenant_owner(p_tenant_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.tenant_memberships m
    WHERE m.tenant_id = p_tenant_id AND m.user_id = (SELECT auth.uid())
      AND m.status = 'active' AND m.role = 'owner'
  );
$$;

CREATE FUNCTION private.can_access_outlet(p_tenant_id uuid, p_outlet_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.is_tenant_admin(p_tenant_id) OR EXISTS (
    SELECT 1 FROM public.outlet_memberships m
    WHERE m.tenant_id = p_tenant_id AND m.outlet_id = p_outlet_id
      AND m.user_id = (SELECT auth.uid()) AND m.status = 'active'
  );
$$;

CREATE FUNCTION private.can_manage_outlet(p_tenant_id uuid, p_outlet_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.is_tenant_admin(p_tenant_id) OR EXISTS (
    SELECT 1 FROM public.outlet_memberships m
    WHERE m.tenant_id = p_tenant_id AND m.outlet_id = p_outlet_id
      AND m.user_id = (SELECT auth.uid()) AND m.status = 'active' AND m.role = 'manager'
  );
$$;

REVOKE ALL ON FUNCTION private.is_tenant_member(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.is_tenant_admin(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.is_tenant_owner(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.can_access_outlet(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.can_manage_outlet(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.is_tenant_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.is_tenant_admin(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.is_tenant_owner(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.can_access_outlet(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.can_manage_outlet(uuid, uuid) TO authenticated;

CREATE FUNCTION private.handle_auth_user_created()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.profiles(user_id, email, display_name)
  VALUES (NEW.id, COALESCE(NEW.email, ''), COALESCE(NEW.raw_user_meta_data ->> 'display_name', ''))
  ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.handle_auth_user_created() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION private.handle_auth_user_created();

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outlets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outlet_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.terminals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dining_areas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dining_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kitchen_stations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outlet_audit_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY profiles_read_self ON public.profiles FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));
CREATE POLICY profiles_update_self ON public.profiles FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY tenants_read_member ON public.tenants FOR SELECT TO authenticated
  USING (created_by = (SELECT auth.uid()) OR private.is_tenant_member(tenant_id));
CREATE POLICY tenants_create_self ON public.tenants FOR INSERT TO authenticated
  WITH CHECK (created_by = (SELECT auth.uid()));
CREATE POLICY tenants_update_admin ON public.tenants FOR UPDATE TO authenticated
  USING (private.is_tenant_admin(tenant_id)) WITH CHECK (private.is_tenant_admin(tenant_id));
CREATE POLICY tenants_delete_owner ON public.tenants FOR DELETE TO authenticated
  USING (private.is_tenant_owner(tenant_id));

CREATE POLICY tenant_memberships_read_self_or_admin ON public.tenant_memberships FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR private.is_tenant_admin(tenant_id));
CREATE POLICY tenant_memberships_create_owner_or_admin ON public.tenant_memberships FOR INSERT TO authenticated
  WITH CHECK (
    (user_id = (SELECT auth.uid()) AND role = 'owner' AND status = 'active' AND EXISTS (
      SELECT 1 FROM public.tenants t WHERE t.tenant_id = tenant_memberships.tenant_id AND t.created_by = (SELECT auth.uid())
    ))
    OR (private.is_tenant_admin(tenant_id) AND (role <> 'owner' OR private.is_tenant_owner(tenant_id)))
  );
CREATE POLICY tenant_memberships_update_admin ON public.tenant_memberships FOR UPDATE TO authenticated
  USING (private.is_tenant_admin(tenant_id))
  WITH CHECK (private.is_tenant_admin(tenant_id) AND (role <> 'owner' OR private.is_tenant_owner(tenant_id)));
CREATE POLICY tenant_memberships_delete_admin ON public.tenant_memberships FOR DELETE TO authenticated
  USING (private.is_tenant_admin(tenant_id) AND (role <> 'owner' OR private.is_tenant_owner(tenant_id)));

CREATE POLICY brands_read_member ON public.brands FOR SELECT TO authenticated
  USING (private.is_tenant_member(tenant_id));
CREATE POLICY brands_create_admin ON public.brands FOR INSERT TO authenticated
  WITH CHECK (private.is_tenant_admin(tenant_id));
CREATE POLICY brands_update_admin ON public.brands FOR UPDATE TO authenticated
  USING (private.is_tenant_admin(tenant_id)) WITH CHECK (private.is_tenant_admin(tenant_id));
CREATE POLICY brands_delete_admin ON public.brands FOR DELETE TO authenticated
  USING (private.is_tenant_admin(tenant_id));

CREATE POLICY outlets_read_assigned ON public.outlets FOR SELECT TO authenticated
  USING (private.can_access_outlet(tenant_id, outlet_id));
CREATE POLICY outlets_create_admin ON public.outlets FOR INSERT TO authenticated
  WITH CHECK (private.is_tenant_admin(tenant_id));
CREATE POLICY outlets_update_manager ON public.outlets FOR UPDATE TO authenticated
  USING (private.can_manage_outlet(tenant_id, outlet_id))
  WITH CHECK (private.can_manage_outlet(tenant_id, outlet_id));
CREATE POLICY outlets_delete_admin ON public.outlets FOR DELETE TO authenticated
  USING (private.is_tenant_admin(tenant_id));

CREATE POLICY outlet_memberships_read_self_or_manager ON public.outlet_memberships FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR private.can_manage_outlet(tenant_id, outlet_id));
CREATE POLICY outlet_memberships_create_manager ON public.outlet_memberships FOR INSERT TO authenticated
  WITH CHECK (private.can_manage_outlet(tenant_id, outlet_id));
CREATE POLICY outlet_memberships_update_manager ON public.outlet_memberships FOR UPDATE TO authenticated
  USING (private.can_manage_outlet(tenant_id, outlet_id))
  WITH CHECK (private.can_manage_outlet(tenant_id, outlet_id));
CREATE POLICY outlet_memberships_delete_manager ON public.outlet_memberships FOR DELETE TO authenticated
  USING (private.can_manage_outlet(tenant_id, outlet_id));

CREATE POLICY staff_invitations_read_manager ON public.staff_invitations FOR SELECT TO authenticated
  USING (private.is_tenant_admin(tenant_id) AND (outlet_id IS NULL OR private.can_manage_outlet(tenant_id, outlet_id)));
CREATE POLICY staff_invitations_create_manager ON public.staff_invitations FOR INSERT TO authenticated
  WITH CHECK (invited_by = (SELECT auth.uid()) AND private.is_tenant_admin(tenant_id)
    AND (outlet_id IS NULL OR private.can_manage_outlet(tenant_id, outlet_id)));
CREATE POLICY staff_invitations_update_manager ON public.staff_invitations FOR UPDATE TO authenticated
  USING (private.is_tenant_admin(tenant_id) AND (outlet_id IS NULL OR private.can_manage_outlet(tenant_id, outlet_id)))
  WITH CHECK (private.is_tenant_admin(tenant_id) AND (outlet_id IS NULL OR private.can_manage_outlet(tenant_id, outlet_id)));
CREATE POLICY staff_invitations_delete_manager ON public.staff_invitations FOR DELETE TO authenticated
  USING (private.is_tenant_admin(tenant_id) AND (outlet_id IS NULL OR private.can_manage_outlet(tenant_id, outlet_id)));

CREATE POLICY terminals_read_manager ON public.terminals FOR SELECT TO authenticated
  USING (private.can_manage_outlet(tenant_id, outlet_id));
CREATE POLICY terminals_create_manager ON public.terminals FOR INSERT TO authenticated
  WITH CHECK (enrolled_by = (SELECT auth.uid()) AND private.can_manage_outlet(tenant_id, outlet_id));
CREATE POLICY terminals_update_manager ON public.terminals FOR UPDATE TO authenticated
  USING (private.can_manage_outlet(tenant_id, outlet_id))
  WITH CHECK (private.can_manage_outlet(tenant_id, outlet_id));
CREATE POLICY terminals_delete_manager ON public.terminals FOR DELETE TO authenticated
  USING (private.can_manage_outlet(tenant_id, outlet_id));

CREATE POLICY dining_areas_read_outlet ON public.dining_areas FOR SELECT TO authenticated
  USING (private.can_access_outlet(tenant_id, outlet_id));
CREATE POLICY dining_areas_create_manager ON public.dining_areas FOR INSERT TO authenticated
  WITH CHECK (private.can_manage_outlet(tenant_id, outlet_id));
CREATE POLICY dining_areas_update_manager ON public.dining_areas FOR UPDATE TO authenticated
  USING (private.can_manage_outlet(tenant_id, outlet_id)) WITH CHECK (private.can_manage_outlet(tenant_id, outlet_id));
CREATE POLICY dining_areas_delete_manager ON public.dining_areas FOR DELETE TO authenticated
  USING (private.can_manage_outlet(tenant_id, outlet_id));

CREATE POLICY dining_tables_read_outlet ON public.dining_tables FOR SELECT TO authenticated
  USING (private.can_access_outlet(tenant_id, outlet_id));
CREATE POLICY dining_tables_create_manager ON public.dining_tables FOR INSERT TO authenticated
  WITH CHECK (private.can_manage_outlet(tenant_id, outlet_id));
CREATE POLICY dining_tables_update_manager ON public.dining_tables FOR UPDATE TO authenticated
  USING (private.can_manage_outlet(tenant_id, outlet_id)) WITH CHECK (private.can_manage_outlet(tenant_id, outlet_id));
CREATE POLICY dining_tables_delete_manager ON public.dining_tables FOR DELETE TO authenticated
  USING (private.can_manage_outlet(tenant_id, outlet_id));

CREATE POLICY kitchen_stations_read_outlet ON public.kitchen_stations FOR SELECT TO authenticated
  USING (private.can_access_outlet(tenant_id, outlet_id));
CREATE POLICY kitchen_stations_create_manager ON public.kitchen_stations FOR INSERT TO authenticated
  WITH CHECK (private.can_manage_outlet(tenant_id, outlet_id));
CREATE POLICY kitchen_stations_update_manager ON public.kitchen_stations FOR UPDATE TO authenticated
  USING (private.can_manage_outlet(tenant_id, outlet_id)) WITH CHECK (private.can_manage_outlet(tenant_id, outlet_id));
CREATE POLICY kitchen_stations_delete_manager ON public.kitchen_stations FOR DELETE TO authenticated
  USING (private.can_manage_outlet(tenant_id, outlet_id));

CREATE POLICY outlet_audit_events_read_manager ON public.outlet_audit_events FOR SELECT TO authenticated
  USING (private.can_manage_outlet(tenant_id, outlet_id));

REVOKE ALL ON public.profiles, public.tenants, public.tenant_memberships, public.brands,
  public.outlets, public.outlet_memberships, public.staff_invitations, public.terminals,
  public.dining_areas, public.dining_tables, public.kitchen_stations, public.outlet_audit_events
  FROM PUBLIC, anon, authenticated;

GRANT SELECT ON public.profiles TO authenticated;
GRANT UPDATE (display_name, updated_at) ON public.profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenants, public.tenant_memberships,
  public.brands, public.outlets, public.outlet_memberships, public.staff_invitations,
  public.terminals, public.dining_areas, public.dining_tables, public.kitchen_stations
  TO authenticated;
GRANT SELECT ON public.outlet_audit_events TO authenticated;

COMMIT;
