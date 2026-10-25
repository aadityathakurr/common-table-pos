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
  tenantName: setting('POS_TENANT_NAME', 'Indore Mithai House Demo'),
  outletId: setting('POS_OUTLET_ID', 'outlet-vijay-nagar-demo'),
  outletName: setting('POS_OUTLET_NAME', 'Vijay Nagar Demo Outlet'),
  terminalId: setting('POS_TERMINAL_ID', 'terminal-counter-01'),
  terminalName: setting('POS_TERMINAL_NAME', 'Counter 01'),
  locationLabel: setting('POS_LOCATION_LABEL', 'Vijay Nagar, Indore · Demo'),
  actorId: setting('POS_ACTOR_ID', 'demo-owner'),
  timezone: setting('POS_TIMEZONE', 'Asia/Kolkata'),
  currency: setting('POS_CURRENCY', 'INR'),
  taxRateBps: integerSetting('POS_TAX_RATE_BPS', Number(process.env.DEMO_TAX_RATE_BPS ?? 500)),
  sessionSecret: setting('POS_SESSION_SECRET', 'common-table-development-session-secret'),
  supabaseUrl: process.env.VITE_SUPABASE_URL?.trim() ?? '',
  supabasePublishableKey: process.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? '',
  secureSessionCookie: process.env.POS_COOKIE_SECURE?.trim() === 'true' || (process.env.NODE_ENV === 'production' && process.env.POS_COOKIE_SECURE?.trim() !== 'false'),
});

const configuredSupabaseUrl = (process.env.POS_SYNC_URL?.trim()
  ?? `${(process.env.VITE_SUPABASE_URL ?? '').trim().replace(/\/$/, '')}/functions/v1/pos-sync`).trim();
export const SYNC_CONFIG = Object.freeze({
  url: configuredSupabaseUrl === '/functions/v1/pos-sync' ? '' : configuredSupabaseUrl,
  terminalKey: process.env.POS_TERMINAL_KEY?.trim() ?? '',
});

export function checkEdgeConfiguration(): void {
  const required: Array<keyof typeof EDGE_CONFIG> = [
    'tenantId', 'tenantName', 'outletId', 'outletName', 'terminalId', 'terminalName', 'actorId', 'timezone', 'currency',
  ];
  if (required.some((key) => !EDGE_CONFIG[key])) throw new Error('Outlet configuration is incomplete.');
  if (!/^[A-Z]{3}$/.test(EDGE_CONFIG.currency)) throw new Error('POS_CURRENCY must be a three-letter ISO currency code.');
  if (EDGE_CONFIG.sessionSecret.length < 32) throw new Error('POS_SESSION_SECRET must contain at least 32 characters.');
  const hasSupabaseUrl=Boolean(EDGE_CONFIG.supabaseUrl);
  const hasSupabaseKey=Boolean(EDGE_CONFIG.supabasePublishableKey);
  if (hasSupabaseUrl!==hasSupabaseKey) throw new Error('Configure both the Supabase Auth URL and publishable key.');
  if (process.env.NODE_ENV==='production'&&(!hasSupabaseUrl||!hasSupabaseKey))
    throw new Error('Supabase Auth URL and publishable key are required in production.');
}
