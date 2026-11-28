import { describe, expect, it } from 'vitest';
import {
  McpServerConfig,
  mcpServerSummary,
  voiceToolCount,
  voiceToolGroupOf,
  withVoiceToolSwitch,
  type McpServerTools,
} from '../src/index.js';

const server = McpServerConfig.parse({
  name: 'home',
  url: 'http://ha.local/api/mcp',
  tokenSecret: 'HA_TOKEN',
  enabled: true,
});
const read: McpServerTools = {
  tools: [
    { name: 'GetState', description: '' },
    { name: 'TurnOff', description: '' },
    { name: 'TurnOn', description: '' },
  ],
};

describe('MCP server config', () => {
  it('everything is on for the voice until switched off', () => {
    expect(server).toMatchObject({ voice: true, voiceOff: [] });
  });
  it('is a command or a URL, not both', () => {
    expect(
      McpServerConfig.safeParse({ name: 'x', command: 'a', args: [], env: {}, enabled: true })
        .success,
    ).toBe(true);
    expect(
      McpServerConfig.safeParse({
        name: 'x',
        command: 'a',
        args: [],
        env: {},
        url: 'http://h/mcp',
        enabled: true,
      }).success,
    ).toBe(false);
  });
});

describe('voice tool switches', () => {
  it('stores only the turned-off names; a new tool is simply on', () => {
    const off = withVoiceToolSwitch(server, 'TurnOff', false);
    expect(off.voiceOff).toEqual(['TurnOff']);
    expect(mcpServerSummary(off, read)).toBe('3 tools · 1 turned off for the voice');
    expect(withVoiceToolSwitch(off, 'TurnOff', true).voiceOff).toEqual([]);
    const grown: McpServerTools = {
      tools: [...read.tools, { name: 'Brightness', description: '' }],
    };
    expect(mcpServerSummary(off, grown)).toBe('4 tools · 1 turned off for the voice');
  });
  it('says why a server has no tools', () => {
    expect(mcpServerSummary({ ...server, voice: false }, read)).toBe('Voice off');
    expect(mcpServerSummary(server, { error: 'refused' })).toBe('Not reachable: refused');
  });
  it('counts what the voice has', () => {
    const base = voiceToolCount([], [], {});
    expect(voiceToolCount([server], [], { home: read })).toBe(base + 3);
    expect(voiceToolCount([{ ...server, voiceOff: ['TurnOff'] }], [], { home: read })).toBe(
      base + 2,
    );
    expect(voiceToolCount([], ['chats'], {})).toBe(base - 3);
  });
  it('groups the built-in tools', () => {
    expect(voiceToolGroupOf('set_timer')).toBe('timers');
    expect(voiceToolGroupOf('end_call')).toBeUndefined();
  });
});
