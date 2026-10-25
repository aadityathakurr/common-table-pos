import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { ifNoneMatchMatches } from "./etag.mjs";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const secretKey = Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const allowedEntityTypes = new Set(["order", "payment", "shift", "cash_movement", "audit", "inventory"]);
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
    const [outletResult, categoryResult, itemResult, areaResult, tableResult, stationResult, inventoryResult, recipeResult] = await Promise.all([
      client.from("outlets").select("name,timezone,currency,tax_rate_bps,receipt_name,receipt_address,receipt_phone,gstin,receipt_footer")
        .eq("tenant_id", terminal.tenant_id).eq("outlet_id", terminal.outlet_id).maybeSingle(),
      client.from("menu_categories").select("category_id,name,sort_order,active")
        .eq("tenant_id", terminal.tenant_id).eq("outlet_id", terminal.outlet_id)
        .order("sort_order").order("category_id"),
      client.from("menu_items").select("item_id,category_id,name,price_minor,emoji,color,tag,vegetarian,available,kitchen_station,modifiers,sort_order,tax_code,tax_rate_bps")
        .eq("tenant_id", terminal.tenant_id).eq("outlet_id", terminal.outlet_id)
        .order("sort_order").order("item_id"),
      client.from("dining_areas").select("area_id,name,sort_order,active")
        .eq("tenant_id", terminal.tenant_id).eq("outlet_id", terminal.outlet_id).eq("active", true)
        .order("sort_order").order("area_id"),
      client.from("dining_tables").select("table_id,area_id,name,capacity,sort_order,active")
        .eq("tenant_id", terminal.tenant_id).eq("outlet_id", terminal.outlet_id).eq("active", true)
        .order("sort_order").order("table_id"),
      client.from("kitchen_stations").select("station_id,name,sort_order,active")
        .eq("tenant_id", terminal.tenant_id).eq("outlet_id", terminal.outlet_id).eq("active", true)
        .order("sort_order").order("station_id"),
      client.from("inventory_stock_balances").select("inventory_item_id,name,unit,reorder_level,active,on_hand")
        .eq("tenant_id", terminal.tenant_id).eq("outlet_id", terminal.outlet_id)
        .order("inventory_item_id"),
      client.from("inventory_recipe_components").select("menu_item_id,inventory_item_id,quantity_per_sale")
        .eq("tenant_id", terminal.tenant_id).eq("outlet_id", terminal.outlet_id)
        .order("menu_item_id").order("inventory_item_id"),
    ]);
    if (outletResult.error || !outletResult.data || categoryResult.error || itemResult.error || areaResult.error || tableResult.error || stationResult.error || inventoryResult.error || recipeResult.error) {
      console.error(JSON.stringify({ event: "pos_sync.snapshot_read_failed", code: outletResult.error?.code ?? categoryResult.error?.code ?? itemResult.error?.code ?? areaResult.error?.code ?? tableResult.error?.code ?? stationResult.error?.code ?? inventoryResult.error?.code ?? recipeResult.error?.code }));
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
        taxCode: item.tax_code, taxRateBps: item.tax_rate_bps === null ? null : Number(item.tax_rate_bps),
        modifiers: item.modifiers.map((modifier) => ({ ...modifier, priceDeltaMinor: Number(modifier.priceDeltaMinor) })),
      });
    }
    if ((inventoryResult.data?.length ?? 0) > 20_000 || (recipeResult.data?.length ?? 0) > 50_000) {
      return json(503, { error: "The outlet inventory recipe snapshot exceeds its supported size." });
    }
    const inventoryItems = (inventoryResult.data ?? []).map((item) => ({
      id: item.inventory_item_id, name: item.name.trim(), unit: item.unit,
      reorderLevel: Number(item.reorder_level), active: item.active, onHand: Number(item.on_hand),
    }));
    if (inventoryItems.some((item) => !item.id || !item.name || item.name.length > 120
      || !["each", "g", "kg", "ml", "l", "portion", "pack"].includes(item.unit)
      || !Number.isFinite(item.reorderLevel) || item.reorderLevel < 0 || item.reorderLevel > 1_000_000_000
      || !Number.isFinite(item.onHand) || Math.abs(item.onHand) > 1_000_000_000)) {
      return json(503, { error: "The outlet inventory contains invalid configuration." });
    }
    const inventoryIds = new Set(inventoryItems.map((item) => item.id));
    const menuIds = new Set(items.map((item) => item.id));
    const recipePairs = new Set<string>();
    const recipes = (recipeResult.data ?? []).map((recipe) => ({
      menuItemId: recipe.menu_item_id, inventoryItemId: recipe.inventory_item_id,
      quantityPerSale: Number(recipe.quantity_per_sale),
    }));
    if (recipes.some((recipe) => {
      const pair = `${recipe.menuItemId}:${recipe.inventoryItemId}`;
      const invalid = !menuIds.has(recipe.menuItemId) || !inventoryIds.has(recipe.inventoryItemId)
        || recipePairs.has(pair) || !Number.isFinite(recipe.quantityPerSale) || recipe.quantityPerSale <= 0
        || recipe.quantityPerSale > 1_000_000_000 || Math.round(recipe.quantityPerSale * 1000) !== recipe.quantityPerSale * 1000;
      recipePairs.add(pair);
      return invalid;
    })) return json(503, { error: "The outlet inventory recipes are invalid." });
    if ((areaResult.data?.length ?? 0) > 100 || (tableResult.data?.length ?? 0) > 500 || (stationResult.data?.length ?? 0) > 100) {
      return json(503, { error: "The outlet floor plan exceeds its supported size." });
    }
    const tablesByArea = new Map<string, Array<{ id: string; name: string; capacity: number; sortOrder: number }>>();
    for (const table of tableResult.data ?? []) {
      if (!Number.isSafeInteger(table.capacity) || table.capacity < 1 || table.capacity > 50
        || !Number.isSafeInteger(table.sort_order) || table.sort_order < 0 || typeof table.name !== "string"
        || !table.name.trim() || table.name.length > 40 || /[\u0000-\u001f\u007f]/.test(table.name)) return json(503, { error: "The outlet floor plan is invalid." });
      const rows = tablesByArea.get(table.area_id) ?? [];
      rows.push({ id: table.table_id, name: table.name.trim(), capacity: table.capacity, sortOrder: table.sort_order });
      tablesByArea.set(table.area_id, rows);
    }
    const layout = {
      areas: (areaResult.data ?? []).map((area) => ({
        id: area.area_id, name: area.name.trim(), sortOrder: area.sort_order,
        tables: tablesByArea.get(area.area_id) ?? [],
      })),
      stations: (stationResult.data ?? []).map((station) => ({ id: station.station_id, name: station.name.trim(), sortOrder: station.sort_order })),
    };
    if (layout.areas.some((area) => !area.name || area.name.length > 80 || /[\u0000-\u001f\u007f]/.test(area.name) || !Number.isSafeInteger(area.sortOrder) || area.sortOrder < 0)
      || layout.stations.some((station) => !station.name || station.name.length > 80 || /[\u0000-\u001f\u007f]/.test(station.name) || !Number.isSafeInteger(station.sortOrder) || station.sortOrder < 0)
      || (tableResult.data ?? []).some((table) => !(areaResult.data ?? []).some((area) => area.area_id === table.area_id))) {
      return json(503, { error: "The outlet floor plan is invalid." });
    }
    const versionBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ outletConfig, items, layout, inventoryItems, recipes }))));
    const version = [...versionBytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const etag = `"${version}"`;
    const headers = { etag, "x-pos-menu-version": version };
    if (ifNoneMatchMatches(request.headers.get("if-none-match"), etag)) return noContent(304, headers);
    return json(200, { tenantId: terminal.tenant_id, outletId: terminal.outlet_id, version, outletConfig, items, inventoryItems, recipes, layout }, headers);
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
    if (event.entityType === "inventory") {
      const payload = event.payload as Record<string, unknown>;
      const quantity = Number(payload.quantity);
      const movementType=payload.movementType;
      const sale=event.action==='inventory.sale_consumed';
      const validAction=sale||(['receipt','waste','count_adjustment'].includes(String(movementType))&&event.action===`inventory.${String(movementType)}`);
      if (!validAction || !uuidPattern.test(String(payload.movementId ?? ""))
        || event.entityId !== payload.movementId || !uuidPattern.test(String(payload.inventoryItemId ?? ""))
        || !uuidPattern.test(String(payload.actorId ?? "")) || (sale&&!uuidPattern.test(String(payload.orderId ?? "")))
        || typeof payload.commandId !== "string" || payload.commandId.length < 8 || payload.commandId.length > 160
        || !Number.isFinite(quantity) || quantity < (event.action==='inventory.count_adjustment'?0:Number.MIN_VALUE)
        || quantity > 1_000_000_000 || Math.round(quantity * 1000) !== quantity * 1000
        || (event.action==='inventory.count_adjustment'&&(!Number.isFinite(Number(payload.expectedBalance))||Math.abs(Number(payload.expectedBalance))>1_000_000_000))
        || (event.action!=='inventory.count_adjustment'&&payload.expectedBalance!==null)
        || typeof payload.reason !== "string" || payload.reason.trim().length < 3 || payload.reason.length > 120
        || /[\u0000-\u001f\u007f]/.test(payload.reason)) {
        return json(400, { error: "The sync batch contains an invalid inventory movement." });
      }
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
  const acceptedEventIds: string[] = [];
  const rejectedEvents: Array<{ eventId: string; code: string | null }> = [];
  for (const row of rows) {
    const { error: insertError } = await client.from("pos_sync_events")
      .upsert([row], { onConflict: "tenant_id,outlet_id,terminal_id,event_id", ignoreDuplicates: true });
    if (insertError) {
      // Keep a bad event retryable without letting it roll back unrelated sales in this batch.
      console.error(JSON.stringify({ event: "pos_sync.event_rejected", eventId: row.event_id, code: insertError.code }));
      rejectedEvents.push({ eventId: row.event_id, code: insertError.code ?? null });
      continue;
    }
    acceptedEventIds.push(row.event_id);
  }

  return json(200, { acceptedEventIds, rejectedEvents });
});
