export const TERMINAL_ONLINE_TIMEOUT_MS = 90_000;

/** @param {'active'|'revoked'} status @param {string|null} lastSeenAt @param {number} [now] */
export function terminalConnectionState(status, lastSeenAt, now = Date.now()) {
  if (status === 'revoked') return 'revoked';
  if (!lastSeenAt) return 'never';
  const lastSeen = Date.parse(lastSeenAt);
  if (!Number.isFinite(lastSeen)) return 'offline';
  return now - lastSeen <= TERMINAL_ONLINE_TIMEOUT_MS ? 'online' : 'offline';
}
