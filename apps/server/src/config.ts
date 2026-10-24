function setting(name: string, developmentFallback?: string): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (process.env.NODE_ENV !== 'production' && developmentFallback) return developmentFallback;
  throw new Error(`Missing required environment variable: ${name}`);
}

function integerSetting(name: string, developmentFallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined && process.env.NODE_ENV !== 'production' ? developmentFallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
  return value;
}

export const EDGE_CONFIG = Object.freeze({
  tenantId: setting('POS_TENANT_ID', 'tenant-common-table-demo'),
  tenantName: setting('POS_TENANT_NAME', 'Common Table Demo'),
  outletId: setting('POS_OUTLET_ID', 'outlet-juniper-cafe'),
  outletName: setting('POS_OUTLET_NAME', 'Juniper Café'),
  terminalId: setting('POS_TERMINAL_ID', 'terminal-counter-01'),
  terminalName: setting('POS_TERMINAL_NAME', 'Counter 01'),
  locationLabel: setting('POS_LOCATION_LABEL', 'Restaurant outlet'),
  actorId: setting('POS_ACTOR_ID', 'staff-alex-rivera'),
  timezone: setting('POS_TIMEZONE', 'Asia/Kolkata'),
  currency: setting('POS_CURRENCY', 'INR'),
  taxRateBps: integerSetting('POS_TAX_RATE_BPS', Number(process.env.DEMO_TAX_RATE_BPS ?? 500)),
});

export function checkEdgeConfiguration(): void {
  const required: Array<keyof typeof EDGE_CONFIG> = [
    'tenantId', 'tenantName', 'outletId', 'outletName', 'terminalId', 'terminalName', 'actorId', 'timezone', 'currency',
  ];
  if (required.some((key) => !EDGE_CONFIG[key])) throw new Error('Outlet configuration is incomplete.');
  if (!/^[A-Z]{3}$/.test(EDGE_CONFIG.currency)) throw new Error('POS_CURRENCY must be a three-letter ISO currency code.');
}
