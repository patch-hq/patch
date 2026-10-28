import { describe, it, expect, vi } from 'vitest';
import { handleUncaught } from '../src/crashGuard.js';

const epipe = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE', syscall: 'write' });

describe('handleUncaught', () => {
  it('logs and survives a write EPIPE to a dead child process', () => {
    const logger = { error: vi.fn(), fatal: vi.fn() };
    const exit = vi.fn();
    handleUncaught(epipe(), logger, exit);
    expect(logger.error).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
  });

  it('logs fatally and exits 1 on anything else', () => {
    const logger = { error: vi.fn(), fatal: vi.fn() };
    const exit = vi.fn();
    handleUncaught(new Error('boom'), logger, exit);
    expect(logger.fatal).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('does not treat a read ECONNRESET as survivable', () => {
    const logger = { error: vi.fn(), fatal: vi.fn() };
    const exit = vi.fn();
    handleUncaught(
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      logger,
      exit,
    );
    expect(exit).toHaveBeenCalledWith(1);
  });
});
