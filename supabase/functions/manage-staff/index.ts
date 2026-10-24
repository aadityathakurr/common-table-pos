import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const publishableKey = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY")!;
const secretKey = Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const allowedOrigins = new Set(["https://common-table-pos.vercel.app", "http://localhost:5173"]);
const allowedRoles = new Set(["manager", "cashier", "kitchen", "viewer"]);

function response(status: number, body: Record<string, unknown>, origin: string | null): Response {
  const headers = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  });
  if (origin && allowedOrigins.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Headers", "authorization, apikey, content-type, x-client-info");
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (request: Request): Promise<Response> => {
  const origin = request.headers.get("origin");
  if (request.method === "OPTIONS") {
    const headers = new Headers({ "Vary": "Origin" });
    if (origin && allowedOrigins.has(origin)) {
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Access-Control-Allow-Headers", "authorization, apikey, content-type, x-client-info");
      headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    }
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== "POST") return response(405, { error: "Method not allowed." }, origin);
  if (origin && !allowedOrigins.has(origin)) return response(403, { error: "Origin is not allowed." }, origin);
  if (Number(request.headers.get("content-length") ?? "0") > 16_384) return response(413, { error: "Request is too large." }, origin);

  const authorization = request.headers.get("authorization");
  const accessToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!accessToken) return response(401, { error: "Sign in to continue." }, origin);

  const userClient = createClient(supabaseUrl, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const { data: authData, error: authError } = await userClient.auth.getUser(accessToken);
  if (authError || !authData.user?.email) return response(401, { error: "Your session is invalid. Sign in again." }, origin);
  const user = authData.user;
  const adminClient = createClient(supabaseUrl, secretKey, { auth: { autoRefreshToken: false, persistSession: false } });

  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch { return response(400, { error: "Send a valid JSON request." }, origin); }

  if (body.action === "create_invite") {
    const tenantId = typeof body.tenantId === "string" ? body.tenantId : "";
    const outletId = typeof body.outletId === "string" ? body.outletId : "";
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const role = typeof body.role === "string" ? body.role : "";
    if (!tenantId || !outletId || !/^\S+@\S+\.\S+$/.test(email) || !allowedRoles.has(role)) {
      return response(400, { error: "Provide a valid tenant, outlet, email, and staff role." }, origin);
    }
    const { data: tenantRole, error: tenantRoleError } = await userClient.from("tenant_memberships")
      .select("role").eq("tenant_id", tenantId).eq("user_id", user.id).eq("status", "active").maybeSingle();
    if (tenantRoleError) return response(403, { error: "Could not verify your business role." }, origin);
    let authorized = tenantRole?.role === "owner" || tenantRole?.role === "manager";
    if (!authorized) {
      const { data: outletRole, error: outletRoleError } = await userClient.from("outlet_memberships")
        .select("role").eq("tenant_id", tenantId).eq("outlet_id", outletId).eq("user_id", user.id).eq("status", "active").maybeSingle();
      if (outletRoleError) return response(403, { error: "Could not verify your outlet role." }, origin);
      authorized = outletRole?.role === "manager";
    }
    if (!authorized) return response(403, { error: "Only a business or outlet manager can invite staff." }, origin);

    const { data: outlet, error: outletError } = await adminClient.from("outlets")
      .select("name").eq("tenant_id", tenantId).eq("outlet_id", outletId).eq("status", "active").maybeSingle();
    if (outletError || !outlet) return response(404, { error: "Outlet not found or inactive." }, origin);
    const token = newToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const { error: inviteError } = await adminClient.from("staff_invitations").insert({
      tenant_id: tenantId,
      outlet_id: outletId,
      email,
      role,
      token_hash: await hashToken(token),
      invited_by: user.id,
      expires_at: expiresAt,
    });
    if (inviteError) return response(400, { error: "The invitation could not be created." }, origin);
    return response(201, { token, expiresAt, outletName: outlet.name }, origin);
  }

  if (body.action === "accept_invite") {
    const token = typeof body.token === "string" ? body.token : "";
    if (token.length < 32 || token.length > 128) return response(400, { error: "This invitation link is invalid." }, origin);
    if (!user.email_confirmed_at) return response(403, { error: "Confirm your email before accepting this staff invitation." }, origin);
    const { data: invitation, error: inviteError } = await adminClient.from("staff_invitations")
      .select("invitation_id,tenant_id,outlet_id,email,role,expires_at,accepted_at")
      .eq("token_hash", await hashToken(token)).is("accepted_at", null).gt("expires_at", new Date().toISOString()).maybeSingle();
    if (inviteError || !invitation || invitation.email.toLowerCase() !== user.email.toLowerCase()) {
      return response(400, { error: "This invitation is expired, already used, or belongs to another email address." }, origin);
    }
    const { data: currentMembership, error: currentMembershipError } = await adminClient.from("tenant_memberships")
      .select("role").eq("tenant_id", invitation.tenant_id).eq("user_id", user.id).maybeSingle();
    if (currentMembershipError) return response(500, { error: "Your existing business membership could not be checked." }, origin);
    const tenantRole = currentMembership?.role === "owner" || currentMembership?.role === "manager"
      ? currentMembership.role
      : invitation.outlet_id ? "cashier" : invitation.role;
    const { error: membershipError } = await adminClient.from("tenant_memberships").upsert({
      tenant_id: invitation.tenant_id, user_id: user.id, role: tenantRole, status: "active",
    }, { onConflict: "tenant_id,user_id" });
    if (membershipError) return response(500, { error: "Your business membership could not be activated." }, origin);
    if (invitation.outlet_id) {
      const { error: outletMembershipError } = await adminClient.from("outlet_memberships").upsert({
        tenant_id: invitation.tenant_id, outlet_id: invitation.outlet_id, user_id: user.id,
        role: invitation.role, status: "active",
      }, { onConflict: "tenant_id,outlet_id,user_id" });
      if (outletMembershipError) return response(500, { error: "Your outlet membership could not be activated." }, origin);
    }
    const { error: acceptedError } = await adminClient.from("staff_invitations")
      .update({ accepted_at: new Date().toISOString() }).eq("invitation_id", invitation.invitation_id).is("accepted_at", null);
    if (acceptedError) return response(500, { error: "Your membership is active, but the invitation status could not be updated." }, origin);
    const { data: tenant } = await adminClient.from("tenants").select("name").eq("tenant_id", invitation.tenant_id).maybeSingle();
    return response(200, { accepted: true, tenantName: tenant?.name, outletName: invitation.outlet_id ? "your assigned outlet" : undefined }, origin);
  }

  return response(400, { error: "Unknown staff invitation action." }, origin);
});
