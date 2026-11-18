import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { providerForModel, providerForSessionId, providerCapabilities } from '@patch/wire';
import { AcpBackend } from '../src/acpBackend.js';
import { GEMINI_MISSING, findGemini, geminiCommand, isGeminiModel } from '../src/geminiAgent.js';
import type { SdkEnvelope } from '../src/sdkBackend.js';

describe('Gemini as an ACP provider', () => {
  it('routes gemini/ models and gemini- sessions to the provider', () => {
    expect(providerForModel('gemini/gemini-2.5-pro')).toBe('gemini');
    expect(providerForSessionId('gemini-abc')).toBe('gemini');
    expect(isGeminiModel('gemini/x')).toBe(true);
    expect(isGeminiModel('openai/x')).toBe(false);
    expect(providerCapabilities('gemini/x')).toMatchObject({
      resume: true,
      interrupt: true,
      steer: false,
    });
  });

  it('finds gemini on PATH and starts it in ACP mode with the chosen model', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gem-'));
    try {
      expect(findGemini(dir)).toBeUndefined();
      const bin = join(dir, 'gemini');
      writeFileSync(bin, '#!/bin/sh\n');
      chmodSync(bin, 0o755);
      expect(findGemini(dir)).toBe(bin);
      expect(geminiCommand('gemini/gemini-2.5-pro', bin)).toEqual({
        command: bin,
        args: ['--acp', '--model', 'gemini-2.5-pro'],
      });
      expect(geminiCommand(undefined, bin).args).toEqual(['--acp']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a host without gemini says so', () => {
    expect(() => geminiCommand('gemini/x', undefined)).toThrow(GEMINI_MISSING);
  });

  it('runs a turn against a real agent process over stdio', async () => {
    const backend = new AcpBackend({
      sessionPrefix: 'gemini-',
      resolveAgent: () => ({
        command: process.execPath,
        args: [new URL('./fixtures/acp-echo-agent.mjs', import.meta.url).pathname],
      }),
    });
    const events: SdkEnvelope[] = [];
    for await (const e of backend.run({
      prompt: 'ping',
      cwd: process.cwd(),
      abortController: new AbortController(),
      oauthAccessToken: '',
      permissionMode: 'default',
    }))
      events.push(e);
    expect(events.find((e) => e.type === 'assistant')?.content).toBe('echo:ping');
    expect(events.at(-1)).toEqual({ type: 'result', sessionId: 'gemini-echo-1' });
  });
});
