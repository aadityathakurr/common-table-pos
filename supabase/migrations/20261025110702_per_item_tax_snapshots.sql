BEGIN;

ALTER TABLE public.menu_items
  ADD COLUMN tax_code text CHECK (tax_code IS NULL OR (length(trim(tax_code)) BETWEEN 1 AND 30 AND tax_code !~ '[[:cntrl:]]')),
  ADD COLUMN tax_rate_bps integer CHECK (tax_rate_bps IS NULL OR tax_rate_bps BETWEEN 0 AND 10000);

ALTER TABLE public.pos_order_items
  ADD COLUMN tax_code text CHECK (tax_code IS NULL OR (length(trim(tax_code)) BETWEEN 1 AND 30 AND tax_code !~ '[[:cntrl:]]')),
  ADD COLUMN tax_rate_bps integer CHECK (tax_rate_bps IS NULL OR tax_rate_bps BETWEEN 0 AND 10000);

-- Existing order lines inherit the rate that was saved on their parent order.
UPDATE public.pos_order_items AS line
SET tax_rate_bps = order_row.tax_rate_bps
FROM public.pos_orders AS order_row
WHERE order_row.tenant_id = line.tenant_id
  AND order_row.outlet_id = line.outlet_id
  AND order_row.order_id = line.order_id;

ALTER TABLE public.pos_order_items
  ALTER COLUMN tax_rate_bps SET DEFAULT 0,
  ALTER COLUMN tax_rate_bps SET NOT NULL;

COMMIT;
