import assert from 'node:assert/strict';
import test from 'node:test';
import { TERMINAL_ONLINE_TIMEOUT_MS, terminalConnectionState } from '../src/terminalStatus.mjs';

const now = Date.parse('2026-10-25T10:00:00.000Z');

test('terminal status distinguishes never-connected and revoked devices', () => {
  assert.equal(terminalConnectionState('active', null, now), 'never');
  assert.equal(terminalConnectionState('revoked', '2026-10-25T10:00:00.000Z', now), 'revoked');
});

test('terminal is online for its polling window and offline when its heartbeat goes stale', () => {
  assert.equal(terminalConnectionState('active', new Date(now - TERMINAL_ONLINE_TIMEOUT_MS).toISOString(), now), 'online');
  assert.equal(terminalConnectionState('active', new Date(now - TERMINAL_ONLINE_TIMEOUT_MS - 1).toISOString(), now), 'offline');
});

test('invalid heartbeat timestamps fail closed as offline', () => {
  assert.equal(terminalConnectionState('active', 'not-a-time', now), 'offline');
});
