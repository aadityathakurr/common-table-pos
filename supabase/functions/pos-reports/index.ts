import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { aggregateCloudProjectionReport } from "./_shared/cloud-report.mjs";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const publishableKey = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY")!;
const allowedOrigins = new Set([
  "https://common-table-pos.vercel.app",
  "http://localhost:5173",
  "http://localhost:5176",
]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const pageSize = 1000;
const maxRows = 20000;

function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin || !allowedOrigins.has(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-max-age": "86400",
    "vary": "Origin",
  };
}

function json(status: number, body: Record<string, unknown>, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...corsHeaders(origin) },
  });
}

function strictDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year = 0, month = 0, day = 0] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day;
}

function dateParts(at: Date, timeZone: string): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(at).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

function localMidnightUtc(year: number, month: number, day: number, timeZone: string): Date {
  const target = Date.UTC(year, month - 1, day);
  let candidate = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = dateParts(new Date(candidate), timeZone);
    const observed = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    const correction = target - observed;
    candidate += correction;
    if (correction === 0) break;
  }
  return new Date(candidate);
}

function localBusinessDate(timeZone: string): string {
  const parts = dateParts(new Date(), timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function reportRange(date: string, timeZone: string): { startAt: string; endAt: string } {
  const [year = 0, month = 0, day = 0] = date.split("-").map(Number);
  const nextDate = new Date(Date.UTC(year, month - 1, day + 1));
  return {
    startAt: localMidnightUtc(year, month, day, timeZone).toISOString(),
    endAt: localMidnightUtc(nextDate.getUTCFullYear(), nextDate.getUTCMonth() + 1, nextDate.getUTCDate(), timeZone).toISOString(),
  };
}

async function fetchAll(query: any): Promise<any[]> {
  const rows: any[] = [];
  for (let offset = 0; offset <= maxRows; offset += pageSize) {
    const { data, error } = await query.range(offset, offset + pageSize - 1);
    if (error) throw new Error(`Cloud report query failed (${error.code ?? "unknown"}).`);
    const page = data ?? [];
    rows.push(...page);
    if (rows.length > maxRows) throw new Error("This report exceeds the event limit. Narrow the report date and retry.");
    if (page.length < pageSize) return rows;
  }
  return rows;
}

Deno.serve(async (request: Request): Promise<Response> => {
  const origin = request.headers.get("origin");
  if (request.method === "OPTIONS") {
    const headers = corsHeaders(origin);
    if (!headers["access-control-allow-origin"]) return json(403, { error: "This browser origin is not allowed." }, origin);
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== "POST") return json(405, { error: "Method not allowed." }, origin);
  if (origin && !allowedOrigins.has(origin)) return json(403, { error: "This browser origin is not allowed." }, origin);

  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return json(401, { error: "Sign in to view cloud reports." }, origin);
  let body: { tenantId?: unknown; outletId?: unknown; date?: unknown };
  try { body = await request.json() as typeof body; }
  catch { return json(400, { error: "Send valid report request JSON." }, origin); }
  if (typeof body.tenantId !== "string" || !uuidPattern.test(body.tenantId)
    || typeof body.outletId !== "string" || !uuidPattern.test(body.outletId)
    || (body.date !== undefined && !strictDate(body.date))) {
    return json(400, { error: "Choose a valid outlet and business date." }, origin);
  }

  const client = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: authorization } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: auth, error: authError } = await client.auth.getUser();
  if (authError || !auth.user) return json(401, { error: "Your sign-in expired. Sign in again." }, origin);
  const { data: outlet, error: outletError } = await client.from("outlets")
    .select("name,timezone,currency")
    .eq("tenant_id", body.tenantId).eq("outlet_id", body.outletId).maybeSingle();
  if (outletError || !outlet) return json(403, { error: "You cannot view reports for this outlet." }, origin);

  const date = body.date === undefined ? localBusinessDate(outlet.timezone) : body.date as string;
  const range = reportRange(date, outlet.timezone);
  try {
    const tenantId = body.tenantId;
    const outletId = body.outletId;
    const payments = await fetchAll(client.from("pos_payments")
      .select("order_id,entry_type,method,amount_minor,status,occurred_at")
      .eq("tenant_id", tenantId).eq("outlet_id", outletId).eq("status", "succeeded")
      .gte("occurred_at", range.startAt).lt("occurred_at", range.endAt)
      .order("occurred_at").order("payment_id"));
    const orderIds = [...new Set(payments.map((payment) => payment.order_id).filter((id) => typeof id === "string"))];
    const orders: any[] = [];
    const orderItems: any[] = [];
    for (let index = 0; index < orderIds.length; index += 100) {
      const batch = orderIds.slice(index, index + 100);
      const [orderRows, itemRows] = await Promise.all([
        fetchAll(client.from("pos_orders")
          .select("order_id,subtotal_minor,tax_total_minor,total_minor")
          .eq("tenant_id", tenantId).eq("outlet_id", outletId).in("order_id", batch)),
        fetchAll(client.from("pos_order_items")
          .select("order_id,line_id,menu_item_id,name,quantity,line_total_minor,voided_at,tax_code,tax_rate_bps")
          .eq("tenant_id", tenantId).eq("outlet_id", outletId).in("order_id", batch)),
      ]);
      orders.push(...orderRows);
      orderItems.push(...itemRows);
    }
    const [voidedItems, shifts] = await Promise.all([
      fetchAll(client.from("pos_order_items")
        .select("order_id,line_id,quantity,line_total_minor,voided_at")
        .eq("tenant_id", tenantId).eq("outlet_id", outletId)
        .gte("voided_at", range.startAt).lt("voided_at", range.endAt)
        .order("voided_at").order("order_id").order("line_id")),
      fetchAll(client.from("pos_shifts")
        .select("shift_id,status,closed_at,expected_cash_minor,counted_cash_minor,variance_minor")
        .eq("tenant_id", tenantId).eq("outlet_id", outletId).eq("status", "closed")
        .gte("closed_at", range.startAt).lt("closed_at", range.endAt)
        .order("closed_at").order("shift_id")),
    ]);
    const report = aggregateCloudProjectionReport({
      date, timeZone: outlet.timezone, outletName: outlet.name, currency: outlet.currency,
      ...range, payments, orders, orderItems, voidedItems, shifts,
    });
    return json(200, report, origin);
  } catch (error) {
    console.error(JSON.stringify({ event: "pos_reports.query_failed", code: error instanceof Error ? error.message : "unknown" }));
    return json(503, { error: error instanceof Error ? error.message : "The cloud report is temporarily unavailable." }, origin);
  }
});
