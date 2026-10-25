import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response, RequestHandler } from 'express';
import { EDGE_CONFIG } from './config.js';

export type StaffRole = 'owner' | 'manager' | 'cashier' | 'kitchen' | 'viewer';
export interface EdgeStaffSession {
  userId: string;
  email: string;
  displayName: string;
  role: StaffRole;
  tenantId: string;
  outletId: string;
  expiresAt: number;
}

const COOKIE_NAME = 'ct_pos_session';
// A persistent local session survives restarts and WAN loss. Activity on the
// outlet edge renews it locally, so an actively used cashier terminal does not
// need Supabase to refresh its session. Explicit sign-out still clears it.
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const SESSION_RENEWAL_THRESHOLD_SECONDS = SESSION_TTL_SECONDS / 2;
const SESSION_SECRET = EDGE_CONFIG.sessionSecret;
const supabaseUrl = EDGE_CONFIG.supabaseUrl.replace(/\/$/, '');
const publishableKey = EDGE_CONFIG.supabasePublishableKey;

export class StaffAuthError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function sign(value: string): Buffer {
  if (!SESSION_SECRET) throw new StaffAuthError('Outlet staff authentication is not configured.', 503);
  return createHmac('sha256', SESSION_SECRET).update(value).digest();
}

function membershipUrl(table: string, userId: string): string {
  const query = new URLSearchParams({
    select: 'role,status', tenant_id: `eq.${EDGE_CONFIG.tenantId}`, user_id: `eq.${userId}`, status: 'eq.active',
  });
  if (table === 'outlet_memberships') query.set('outlet_id', `eq.${EDGE_CONFIG.outletId}`);
  return `${supabaseUrl}/rest/v1/${table}?${query.toString()}`;
}

async function membership(table: string, accessToken: string, userId: string): Promise<StaffRole | null> {
  const response = await fetch(membershipUrl(table, userId), {
    headers: { apikey: publishableKey, authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    signal: AbortSignal.timeout(6000),
  });
  if (response.status === 401 || response.status === 403) throw new StaffAuthError('Your outlet membership could not be verified.', 403);
  if (!response.ok) throw new StaffAuthError('The outlet membership service is unavailable.', 503);
  const rows = await response.json() as Array<{ role?: unknown; status?: unknown }>;
  const row = rows.find(value => value.status === 'active');
  if (!row || typeof row.role !== 'string') return null;
  return ['owner', 'manager', 'cashier', 'kitchen', 'viewer'].includes(row.role) ? row.role as StaffRole : null;
}

export async function createStaffSession(accessToken: string): Promise<EdgeStaffSession> {
  if (!supabaseUrl || !publishableKey) throw new StaffAuthError('Supabase sign-in is not configured on this outlet edge.', 503);
  const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: publishableKey, authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    signal: AbortSignal.timeout(6000),
  });
  if (userResponse.status === 401 || userResponse.status === 403) throw new StaffAuthError('Your sign-in expired. Sign in again to this outlet.', 401);
  if (!userResponse.ok) throw new StaffAuthError('Supabase Auth is unavailable. Try again when the network returns.', 503);
  const user = await userResponse.json() as { id?: unknown; email?: unknown; user_metadata?: Record<string, unknown> };
  if (typeof user.id !== 'string' || typeof user.email !== 'string') throw new StaffAuthError('Supabase returned an invalid user session.', 401);

  const [tenantRole, outletRole] = await Promise.all([
    membership('tenant_memberships', accessToken, user.id),
    membership('outlet_memberships', accessToken, user.id),
  ]);
  const role = tenantRole === 'owner' || tenantRole === 'manager' ? tenantRole : outletRole;
  if (!role) throw new StaffAuthError('This account does not have an active role at this outlet.', 403);

  const metadataName = user.user_metadata?.display_name;
  return {
    userId: user.id, email: user.email,
    displayName: typeof metadataName === 'string' && metadataName.trim() ? metadataName.trim().slice(0, 120) : user.email,
    role, tenantId: EDGE_CONFIG.tenantId, outletId: EDGE_CONFIG.outletId,
    expiresAt: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
}

export function sessionCookie(session: EdgeStaffSession, secure: boolean): string {
  const encoded = Buffer.from(JSON.stringify(session)).toString('base64url');
  const signature = sign(encoded).toString('base64url');
  return `${COOKIE_NAME}=${encoded}.${signature}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}${secure ? '; Secure' : ''}`;
}

export function refreshStaffSession(session: EdgeStaffSession, now = Math.floor(Date.now() / 1000)): EdgeStaffSession {
  if (session.expiresAt - now > SESSION_RENEWAL_THRESHOLD_SECONDS) return session;
  return { ...session, expiresAt: now + SESSION_TTL_SECONDS };
}

export function clearedSessionCookie(secure: boolean): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

function cookieValue(cookieHeader?: string): string | undefined {
  return cookieHeader?.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);
}

export function readStaffSessionCookie(cookieHeader?: string): EdgeStaffSession | undefined {
  const value = cookieValue(cookieHeader);
  if (!value) return undefined;
  const [encoded, signatureText, ...extra] = value.split('.');
  if (!encoded || !signatureText || extra.length) return undefined;
  let supplied: Buffer;
  try { supplied = Buffer.from(signatureText, 'base64url'); } catch { return undefined; }
  const expected = sign(encoded);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return undefined;
  try {
    const session = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as EdgeStaffSession;
    if (!session.userId || !session.email || !session.role || !session.expiresAt || session.expiresAt <= Math.floor(Date.now() / 1000)) return undefined;
    if (session.tenantId !== EDGE_CONFIG.tenantId || session.outletId !== EDGE_CONFIG.outletId) return undefined;
    if (!['owner', 'manager', 'cashier', 'kitchen', 'viewer'].includes(session.role)) return undefined;
    return session;
  } catch { return undefined; }
}

export function readStaffSession(request: Request): EdgeStaffSession | undefined {
  return readStaffSessionCookie(request.header('cookie'));
}

export function currentStaff(response: Response): EdgeStaffSession {
  const session = response.locals.staff as EdgeStaffSession | undefined;
  if (session) return session;
  if (process.env.NODE_ENV !== 'production') {
    return { userId: EDGE_CONFIG.actorId, email: 'local-development', displayName: 'Local development', role: 'owner',
      tenantId: EDGE_CONFIG.tenantId, outletId: EDGE_CONFIG.outletId, expiresAt: Number.MAX_SAFE_INTEGER };
  }
  throw new StaffAuthError('A verified outlet staff session is required.', 401);
}

export function requireRoles(...roles: StaffRole[]): RequestHandler {
  return (_request, response, next) => {
    try {
      if (!roles.includes(currentStaff(response).role)) {
        response.status(403).json({ error: 'Your outlet role does not allow this action.' });
        return;
      }
      next();
    } catch (error) {
      const authError = error instanceof StaffAuthError ? error : new StaffAuthError('A verified outlet staff session is required.', 401);
      response.status(authError.status).json({ error: authError.message });
    }
  };
}

export function sessionMiddleware(): RequestHandler {
  return (request, response, next) => {
    const session = readStaffSession(request);
    if (session) {
      const refreshed = refreshStaffSession(session);
      response.locals.staff = refreshed;
      if (refreshed !== session) response.setHeader('Set-Cookie', sessionCookie(refreshed, EDGE_CONFIG.secureSessionCookie));
      next(); return;
    }
    if (process.env.NODE_ENV !== 'production') { next(); return; }
    response.status(401).json({ error: 'Sign in to this outlet before continuing.' });
  };
}

export const staffSessionTtlSeconds = SESSION_TTL_SECONDS;
