BEGIN;

CREATE INDEX pos_orders_outlet_terminal ON public.pos_orders(tenant_id, outlet_id, terminal_id);
CREATE INDEX pos_payments_outlet_terminal ON public.pos_payments(tenant_id, outlet_id, terminal_id);
CREATE INDEX pos_shifts_outlet_terminal ON public.pos_shifts(tenant_id, outlet_id, terminal_id);
CREATE INDEX pos_cash_movements_outlet_terminal ON public.pos_cash_movements(tenant_id, outlet_id, terminal_id);
CREATE INDEX pos_audit_log_outlet_terminal ON public.pos_audit_log(tenant_id, outlet_id, terminal_id);

ALTER TABLE public.pos_payments
  ADD CONSTRAINT pos_payments_outlet_shift_fkey
  FOREIGN KEY (tenant_id, outlet_id, shift_id)
  REFERENCES public.pos_shifts(tenant_id, outlet_id, shift_id)
  ON DELETE RESTRICT;

COMMIT;
