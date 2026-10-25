export type TerminalConnectionState = 'online' | 'offline' | 'never' | 'revoked';
export declare const TERMINAL_ONLINE_TIMEOUT_MS: number;
export declare function terminalConnectionState(
  status: 'active' | 'revoked',
  lastSeenAt: string | null,
  now?: number,
): TerminalConnectionState;
