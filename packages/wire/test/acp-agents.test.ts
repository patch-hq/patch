// ACP agents as configuration (spec/02 § Provider adapters).

import { describe, expect, it } from 'vitest';
import {
  AcpAgentConfig,
  acpBackendStatus,
  acpModelId,
  compactModelLabel,
  isAcpBackendRow,
  parseAcpModel,
  resolveAcpAgents,
  SharedSettings,
} from '../src/index.js';

describe('ACP agent configuration', () => {
  it('accepts an agent as command, args, label and key mapping, and refuses an unsafe id', () => {
    const ok = { id: 'goose', label: 'Goose', command: 'goose', args: ['acp'] };
    expect(AcpAgentConfig.parse(ok)).toEqual(ok);
    expect(() => AcpAgentConfig.parse({ ...ok, id: 'Goose-1' })).toThrow();
    expect(() => AcpAgentConfig.parse({ ...ok, keys: { GEMINI_API_KEY: 'nope' } })).toThrow();
    expect(
      SharedSettings.shape.acpAgents.parse([{ ...ok, keys: { GEMINI_API_KEY: 'gemini' } }]),
    ).toHaveLength(1);
  });

  it('keeps Gemini CLI built in, replaced or joined by the account’s entries', () => {
    expect(resolveAcpAgents(undefined).map((a) => a.id)).toEqual(['gemini']);
    expect(resolveAcpAgents([{ id: 'gemini', label: 'G', command: 'g', args: [] }])[0]?.label).toBe(
      'G',
    );
  });

  it('names models acp/<agent>/<model> and reads them back', () => {
    expect(acpModelId('gemini', 'gemini-2.5-pro')).toBe('acp/gemini/gemini-2.5-pro');
    expect(parseAcpModel('acp/gemini/gemini-2.5-pro')).toEqual({
      agentId: 'gemini',
      modelId: 'gemini-2.5-pro',
    });
    expect(compactModelLabel('acp/gemini/gemini-2.5-pro')).toBe('gemini-2.5-pro');
    expect(compactModelLabel('acp/gemini/x', 'Gemini CLI · Pro')).toBe('Gemini CLI · Pro');
  });

  it('reads an agent’s Settings row from the host’s report, with no sign-in button', () => {
    expect(isAcpBackendRow('acp:gemini')).toBe(true);
    expect(isAcpBackendRow('codex')).toBe(false);
    expect(acpBackendStatus({ state: 'present' })).toEqual({ text: 'Ready', needsSignIn: false });
    expect(acpBackendStatus({ state: 'logged-out' }).text).toMatch(/Settings → Providers/);
    expect(acpBackendStatus({ state: 'failed', error: 'boom' })).toEqual({
      text: 'Not working on this machine',
      needsSignIn: false,
      details: 'boom',
    });
  });
});
