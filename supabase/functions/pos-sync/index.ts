import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

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

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function hashTerminalKey(key: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))));
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });
  if (request.headers.has("origin")) return json(403, { error: "Browser requests are not accepted by terminal sync." });

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

  const { error: seenError } = await client.from("terminals")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("tenant_id", terminal.tenant_id)
    .eq("outlet_id", terminal.outlet_id)
    .eq("terminal_id", terminal.terminal_id);
  if (seenError) console.error(JSON.stringify({ event: "pos_sync.last_seen_failed", code: seenError.code }));
  return json(200, { acceptedEventIds: events.map((event) => event.eventId) });
});
