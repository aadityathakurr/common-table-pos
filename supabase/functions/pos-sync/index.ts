import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { ifNoneMatchMatches } from "./etag.mjs";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const secretKey = Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const allowedEntityTypes = new Set(["order", "payment", "shift", "cash_movement", "audit"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type SyncEvent = {
  eventId: string;
  entityType: string;
  entityId: string;
  action: string;
  occurredAt: string;
  payload: Record<string, unknown>;
};

function json(status: number, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extraHeaders },
  });
}

function noContent(status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { "cache-control": "no-store", ...extraHeaders } });
}

function validModifier(value: unknown): value is { id: string; group: string; name: string; priceDeltaMinor: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const modifier = value as Record<string, unknown>;
  return typeof modifier.id === "string" && modifier.id.length > 0 && modifier.id.length <= 120
    && typeof modifier.group === "string" && modifier.group.length > 0 && modifier.group.length <= 80
    && typeof modifier.name === "string" && modifier.name.length > 0 && modifier.name.length <= 120
    && Number.isSafeInteger(Number(modifier.priceDeltaMinor)) && Number(modifier.priceDeltaMinor) >= 0;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function hashTerminalKey(key: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))));
}

async function recordTerminalSeen(
  client: ReturnType<typeof createClient>,
  terminal: { tenant_id: string; outlet_id: string; terminal_id: string },
): Promise<void> {
  const { error } = await client.from("terminals")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("tenant_id", terminal.tenant_id)
    .eq("outlet_id", terminal.outlet_id)
    .eq("terminal_id", terminal.terminal_id);
  if (error) {
    // Connectivity status is advisory; a last-seen write must not block offline-first order sync.
    console.error(JSON.stringify({ event: "pos_sync.last_seen_failed", code: error.code }));
  }
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.headers.has("origin")) return json(403, { error: "Browser requests are not accepted by terminal sync." });
  if (request.method !== "POST" && request.method !== "GET") return json(405, { error: "Method not allowed." });

  const terminalKey = request.headers.get("x-pos-terminal-key") ?? "";
  if (terminalKey.length < 40 || terminalKey.length > 128) return json(401, { error: "Terminal authentication failed." });
  const client = createClient(supabaseUrl, secretKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const keyHash = await hashTerminalKey(terminalKey);
  const { data: terminal, error: terminalError } = await client.from("terminals")
    .select("tenant_id,outlet_id,terminal_id,status")
    .eq("device_key_hash", keyHash)
    .eq("status", "active")
    .maybeSingle();
  if (terminalError || !terminal) return json(401, { error: "Terminal authentication failed." });
  await recordTerminalSeen(client, terminal);

  if (request.method === "GET") {
    const [outletResult, categoryResult, itemResult] = await Promise.all([
      client.from("outlets").select("name,timezone,currency,tax_rate_bps,receipt_name,receipt_address,receipt_phone,gstin,receipt_footer")
        .eq("tenant_id", terminal.tenant_id).eq("outlet_id", terminal.outlet_id).maybeSingle(),
      client.from("menu_categories").select("category_id,name,sort_order,active")
        .eq("tenant_id", terminal.tenant_id).eq("outlet_id", terminal.outlet_id)
        .order("sort_order").order("category_id"),
      client.from("menu_items").select("item_id,category_id,name,price_minor,emoji,color,tag,vegetarian,available,kitchen_station,modifiers,sort_order")
        .eq("tenant_id", terminal.tenant_id).eq("outlet_id", terminal.outlet_id)
        .order("sort_order").order("item_id"),
    ]);
    if (outletResult.error || !outletResult.data || categoryResult.error || itemResult.error) {
      console.error(JSON.stringify({ event: "pos_sync.snapshot_read_failed", code: outletResult.error?.code ?? categoryResult.error?.code ?? itemResult.error?.code }));
      return json(503, { error: "The outlet configuration could not be read. Retry safely." });
    }
    const outletConfig = {
      name: outletResult.data.name.trim(),
      timezone: outletResult.data.timezone.trim(),
      currency: outletResult.data.currency.trim().toUpperCase(),
      taxRateBps: Number(outletResult.data.tax_rate_bps),
      receiptName: (outletResult.data.receipt_name ?? "").trim(),
      receiptAddress: (outletResult.data.receipt_address ?? "").trim(),
      receiptPhone: (outletResult.data.receipt_phone ?? "").trim(),
      gstin: (outletResult.data.gstin ?? "").trim().toUpperCase(),
      receiptFooter: (outletResult.data.receipt_footer ?? "").trim(),
    };
    try {
      if (!outletConfig.name.trim() || outletConfig.name.length > 120 || !outletConfig.timezone.trim()
        || outletConfig.timezone.length > 80 || !/^[A-Z]{3}$/.test(outletConfig.currency)
        || !Number.isSafeInteger(outletConfig.taxRateBps) || outletConfig.taxRateBps < 0 || outletConfig.taxRateBps > 10_000
        || outletConfig.receiptName.length > 120 || outletConfig.receiptAddress.length > 240
        || outletConfig.receiptPhone.length > 40 || (outletConfig.gstin && !/^[0-9A-Z]{15}$/.test(outletConfig.gstin))
        || outletConfig.receiptFooter.length > 240
        || [outletConfig.receiptName, outletConfig.receiptAddress, outletConfig.receiptPhone, outletConfig.gstin, outletConfig.receiptFooter]
          .some(value => /[\u0000-\u001f\u007f]/.test(value))) {
        throw new Error("invalid settings");
      }
      new Intl.DateTimeFormat("en-US", { timeZone: outletConfig.timezone });
    } catch {
      return json(503, { error: "The outlet settings are invalid. Correct them in the manager portal and retry." });
    }
    const categories = new Map((categoryResult.data ?? []).map((category) => [category.category_id, category]));
    const items = [];
    for (const item of itemResult.data ?? []) {
      const category = categories.get(item.category_id);
      if (!category || !Array.isArray(item.modifiers) || !item.modifiers.every(validModifier)) {
        return json(503, { error: "The outlet menu contains invalid configuration." });
      }
      items.push({
        id: item.item_id, name: item.name, category: category.name, priceMinor: Number(item.price_minor),
        emoji: item.emoji, color: item.color, tag: item.tag, vegetarian: item.vegetarian,
        available: item.available && category.active, kitchenStation: item.kitchen_station,
        modifiers: item.modifiers.map((modifier) => ({ ...modifier, priceDeltaMinor: Number(modifier.priceDeltaMinor) })),
      });
    }
    const versionBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ outletConfig, items }))));
    const version = [...versionBytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const etag = `"${version}"`;
    const headers = { etag, "x-pos-menu-version": version };
    if (ifNoneMatchMatches(request.headers.get("if-none-match"), etag)) return noContent(304, headers);
    return json(200, { tenantId: terminal.tenant_id, outletId: terminal.outlet_id, version, outletConfig, items }, headers);
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 300_000) return json(413, { error: "Sync batch is too large." });
  const reader = request.body?.getReader();
  if (!reader) return json(400, { error: "Send a valid sync batch." });
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > 300_000) {
      await reader.cancel();
      return json(413, { error: "Sync batch is too large." });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body: { events?: unknown };
  try { body = JSON.parse(new TextDecoder().decode(bytes)) as { events?: unknown }; }
  catch { return json(400, { error: "Send valid JSON." }); }
  if (!Array.isArray(body.events) || body.events.length < 1 || body.events.length > 50) {
    return json(400, { error: "A sync batch must contain between 1 and 50 events." });
  }

  const events = body.events as SyncEvent[];
  const seen = new Set<string>();
  const rows = [];
  for (const event of events) {
    if (!event || typeof event !== "object" || !uuidPattern.test(event.eventId) || seen.has(event.eventId)
      || typeof event.entityType !== "string" || !allowedEntityTypes.has(event.entityType)
      || typeof event.entityId !== "string" || event.entityId.trim().length < 1 || event.entityId.length > 120
      || typeof event.action !== "string" || event.action.trim().length < 1 || event.action.length > 80
      || typeof event.occurredAt !== "string" || !Number.isFinite(Date.parse(event.occurredAt))
      || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
      return json(400, { error: "The sync batch contains an invalid event." });
    }
    seen.add(event.eventId);
    rows.push({
      tenant_id: terminal.tenant_id,
      outlet_id: terminal.outlet_id,
      terminal_id: terminal.terminal_id,
      event_id: event.eventId,
      entity_type: event.entityType,
      entity_id: event.entityId,
      action: event.action,
      occurred_at: new Date(event.occurredAt).toISOString(),
      payload: event.payload,
    });
  }

  const serializedSize = new TextEncoder().encode(JSON.stringify(rows)).byteLength;
  if (serializedSize > 256_000) return json(413, { error: "Sync event payloads exceed the batch limit." });
  const { error: insertError } = await client.from("pos_sync_events")
    .upsert(rows, { onConflict: "tenant_id,outlet_id,terminal_id,event_id", ignoreDuplicates: true });
  if (insertError) {
    console.error(JSON.stringify({ event: "pos_sync.insert_failed", code: insertError.code }));
    return json(503, { error: "The sync batch was not acknowledged. It is safe to retry." });
  }

  return json(200, { acceptedEventIds: events.map((event) => event.eventId) });
});
