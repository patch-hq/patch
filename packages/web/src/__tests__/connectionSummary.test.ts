import { describe, expect, it } from 'vitest';
import { connectionSummary } from '../lib/connectionSummary.js';
import type { HostPresence } from '../stores/presenceStore.js';

const host = (hostId: string, name: string, online: boolean): HostPresence => ({
  hostId,
  online,
  lastSeenAt: null,
  host: null,
  registeredName: name,
  accounts: {},
  claudeSettings: null,
  folders: null,
});

describe('connectionSummary', () => {
  it('names the surface, the server and each host with its state', () => {
    const text = connectionSummary('connected', {
      b: host('b', 'Mac', false),
      a: host('a', 'Box', true),
    });
    expect(text.split('\n')).toEqual([
      'This surface (web): connected',
      'Server: reachable',
      'Host Box: online',
      'Host Mac: offline',
    ]);
  });

  it('reports a dropped link on both surface and server lines', () => {
    const text = connectionSummary('reconnecting', {});
    expect(text).toContain('This surface (web): reconnecting');
    expect(text).toContain('Server: reconnecting');
    expect(text).toContain('Hosts: none registered');
  });
});
