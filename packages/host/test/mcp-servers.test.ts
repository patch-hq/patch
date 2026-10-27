// Settings → MCP (mcpServers.ts): the per-host MCP server list, the seed a host
// that predates it gets, and the legacy Browser tools toggle's reading of it.

import { describe, expect, it } from 'vitest';
import { McpServerList } from '@patch/wire';
import {
  browserToolsEnabledOf,
  enabledMcpServers,
  seedMcpServers,
  withBrowserToolsEnabled,
} from '../src/mcpServers.js';
import { codexMcpServers } from '../src/codexBackend.js';
import { buildSdkEnv } from '../src/sdkBackend.js';

describe('seedMcpServers', () => {
  it('is the pair the retired toggle wired, enabled as the toggle was, and a valid list', () => {
    for (const enabled of [true, false]) {
      const seed = seedMcpServers(enabled);
      expect(seed.map((s) => [s.name, s.command, s.args, s.enabled])).toEqual([
        ['playwright', 'npx', ['@playwright/mcp@0.0.83', '--headless'], enabled],
        ['chrome-devtools', 'npx', ['-y', 'chrome-devtools-mcp@1.10.1', '--headless'], enabled],
      ]);
      expect(McpServerList.safeParse(seed).success).toBe(true);
    }
  });
});

describe('the legacy Browser tools toggle over the list', () => {
  const other = { name: 'mine', command: 'x', args: [], env: {}, enabled: true };

  it('reads true only when both browser servers are present and enabled', () => {
    expect(browserToolsEnabledOf(seedMcpServers(true))).toBe(true);
    expect(browserToolsEnabledOf(seedMcpServers(false))).toBe(false);
    const [playwright] = seedMcpServers(true);
    expect(browserToolsEnabledOf([playwright!, other])).toBe(false);
    expect(browserToolsEnabledOf([])).toBe(false);
  });

  it('flips only the browser servers still in the list, and brings back none the user removed', () => {
    const [playwright] = seedMcpServers(false);
    const flipped = withBrowserToolsEnabled([other, playwright!], true);
    expect(flipped.map((s) => [s.name, s.enabled])).toEqual([
      ['mine', true],
      ['playwright', true],
    ]);
    expect(withBrowserToolsEnabled(flipped, false).map((s) => [s.name, s.enabled])).toEqual([
      ['mine', true],
      ['playwright', false],
    ]);
  });

  it('a chat gets only the enabled entries, in list order', () => {
    const list = [
      { ...other, name: 'a' },
      { ...other, name: 'b', enabled: false },
      { ...other, name: 'c' },
    ];
    expect(enabledMcpServers(list).map((s) => s.name)).toEqual(['a', 'c']);
  });
});

describe('codexMcpServers', () => {
  const patch = { command: 'node', args: ['tools.js'], env: { A: '1' } };

  it('gives a Codex chat patch first, then the same enabled servers a Claude chat gets', () => {
    const servers = codexMcpServers({
      mcpServer: patch,
      extraMcpServers: [
        { name: 'playwright', command: 'npx', args: ['@playwright/mcp@0.0.83'], env: {} },
        { name: 'mine', command: '/opt/m', args: [], env: { K: 'v' } },
      ],
    });
    expect(Object.keys(servers!)).toEqual(['patch', 'playwright', 'mine']);
    expect(servers).toEqual({
      patch: { ...patch, enabled: true },
      playwright: { command: 'npx', args: ['@playwright/mcp@0.0.83'], env: {}, enabled: true },
      mine: { command: '/opt/m', args: [], env: { K: 'v' }, enabled: true },
    });
  });

  it('is patch alone with no extras, and nothing without a patch tools server', () => {
    expect(codexMcpServers({ mcpServer: patch })).toEqual({ patch: { ...patch, enabled: true } });
    expect(
      codexMcpServers({ extraMcpServers: [{ name: 'mine', command: 'm', args: [], env: {} }] }),
    ).toBeUndefined();
  });
});

describe('Patch tools server switched off (patchMcpOff)', () => {
  const patch = { command: 'node', args: ['tools.js'], env: {} };
  const extra = [{ name: 'mine', command: '/opt/m', args: [], env: { K: 'v' } }];
  const base = { prompt: 'x', cwd: '/tmp', abortController: new AbortController() };

  it('a Claude chat keeps the host list but loses patch', () => {
    const on = buildSdkEnv({ ...base, mcpServer: patch, extraMcpServers: extra });
    expect(Object.keys(on.mcpServers!)).toEqual(['patch', 'mine']);
    const off = buildSdkEnv({
      ...base,
      mcpServer: patch,
      extraMcpServers: extra,
      patchMcpOff: true,
    });
    expect(Object.keys(off.mcpServers!)).toEqual(['mine']);
  });

  it('a Codex chat keeps the host list but loses patch', () => {
    const off = codexMcpServers({ mcpServer: patch, extraMcpServers: extra, patchMcpOff: true });
    expect(Object.keys(off!)).toEqual(['mine']);
  });
});
