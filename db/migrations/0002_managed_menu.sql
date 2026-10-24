BEGIN;

CREATE TABLE public.menu_categories (
    tenant_id uuid NOT NULL,
    outlet_id uuid NOT NULL,
    category_id uuid NOT NULL DEFAULT gen_random_uuid(),
    name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
    sort_order integer NOT NULL DEFAULT 0,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, outlet_id, category_id),
    UNIQUE (tenant_id, outlet_id, name),
    FOREIGN KEY (tenant_id, outlet_id) REFERENCES public.outlets(tenant_id, outlet_id) ON DELETE CASCADE
);

CREATE TABLE public.menu_items (
    tenant_id uuid NOT NULL,
    outlet_id uuid NOT NULL,
    item_id text NOT NULL CHECK (length(trim(item_id)) BETWEEN 1 AND 100),
    category_id uuid NOT NULL,
    name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
    price_minor bigint NOT NULL CHECK (price_minor BETWEEN 0 AND 100000000),
    emoji text NOT NULL DEFAULT '',
    color text NOT NULL DEFAULT '#f3f4f6' CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
    tag text CHECK (tag IS NULL OR length(tag) <= 40),
    vegetarian boolean NOT NULL DEFAULT true,
    available boolean NOT NULL DEFAULT true,
    kitchen_station text NOT NULL DEFAULT 'Main kitchen' CHECK (length(trim(kitchen_station)) BETWEEN 1 AND 80),
    modifiers jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(modifiers) = 'array'),
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, outlet_id, item_id),
    FOREIGN KEY (tenant_id, outlet_id) REFERENCES public.outlets(tenant_id, outlet_id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, outlet_id, category_id)
      REFERENCES public.menu_categories(tenant_id, outlet_id, category_id) ON DELETE RESTRICT
);

CREATE INDEX menu_items_by_category ON public.menu_items(tenant_id, outlet_id, category_id, sort_order);
CREATE INDEX menu_items_available ON public.menu_items(tenant_id, outlet_id, available, sort_order);

ALTER TABLE public.menu_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.menu_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY menu_categories_read_outlet ON public.menu_categories FOR SELECT TO authenticated
  USING (private.can_access_outlet(tenant_id, outlet_id));
CREATE POLICY menu_categories_create_manager ON public.menu_categories FOR INSERT TO authenticated
  WITH CHECK (private.can_manage_outlet(tenant_id, outlet_id));
CREATE POLICY menu_categories_update_manager ON public.menu_categories FOR UPDATE TO authenticated
  USING (private.can_manage_outlet(tenant_id, outlet_id))
  WITH CHECK (private.can_manage_outlet(tenant_id, outlet_id));
CREATE POLICY menu_categories_delete_manager ON public.menu_categories FOR DELETE TO authenticated
  USING (private.can_manage_outlet(tenant_id, outlet_id));

CREATE POLICY menu_items_read_outlet ON public.menu_items FOR SELECT TO authenticated
  USING (private.can_access_outlet(tenant_id, outlet_id));
CREATE POLICY menu_items_create_manager ON public.menu_items FOR INSERT TO authenticated
  WITH CHECK (private.can_manage_outlet(tenant_id, outlet_id));
CREATE POLICY menu_items_update_manager ON public.menu_items FOR UPDATE TO authenticated
  USING (private.can_manage_outlet(tenant_id, outlet_id))
  WITH CHECK (private.can_manage_outlet(tenant_id, outlet_id));
CREATE POLICY menu_items_delete_manager ON public.menu_items FOR DELETE TO authenticated
  USING (private.can_manage_outlet(tenant_id, outlet_id));

REVOKE ALL ON public.menu_categories, public.menu_items FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.menu_categories, public.menu_items TO authenticated;

COMMIT;
