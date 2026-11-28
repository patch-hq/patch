// The Manager folder is checked on the Manager's home host before it is saved
// (spec/06 § Manager prompt and folder); a refusal names the host by name.

import { describe, it, expect } from 'vitest';
import type { WireEvent } from '@patch/wire';
import { managerFolderProblem, type ManagerFolderCheckDeps } from '../src/manager-folder-check.js';

type Response = Extract<WireEvent, { type: 'patch.host_files.response' }>;

function deps(
  answer: Response | 'timeout',
  over: Partial<ManagerFolderCheckDeps> = {},
): ManagerFolderCheckDeps & { asked: unknown[] } {
  const asked: unknown[] = [];
  return {
    asked,
    managerHostId: () => 'h1',
    hostName: (id) => (id === 'h1' ? 'Studio Mac' : undefined),
    isOnline: () => true,
    hostFiles: {
      request: async (hostId, _surface, body) => {
        asked.push({ hostId, ...body });
        return answer;
      },
    },
    ...over,
  };
}

const ok = {
  type: 'patch.host_files.response',
  requestId: 'r',
  hostId: 'h1',
  ok: true,
} as Response;
const refused = (code: string, message = 'nope'): Response =>
  ({
    type: 'patch.host_files.response',
    requestId: 'r',
    hostId: 'h1',
    ok: false,
    error: { code, message },
  }) as Response;

describe('managerFolderProblem', () => {
  it('a folder on the home host passes, asked of that host', async () => {
    const d = deps(ok);
    expect(await managerFolderProblem(d, '/srv/work')).toBeNull();
    expect(d.asked).toEqual([{ hostId: 'h1', op: 'list', path: '/srv/work', maxEntries: 1 }]);
  });

  it('a path that is not a folder there is refused, naming the host', async () => {
    for (const code of ['not_found', 'not_a_directory']) {
      expect(await managerFolderProblem(deps(refused(code)), '/srv/nope')).toEqual({
        status: 400,
        message: '/srv/nope is not a folder on Studio Mac',
      });
    }
  });

  it('an offline or silent home host is refused rather than saved unchecked', async () => {
    expect(await managerFolderProblem(deps(ok, { isOnline: () => false }), '/srv/work')).toEqual({
      status: 503,
      message: 'Cannot check the folder: Studio Mac is offline',
    });
    expect(await managerFolderProblem(deps('timeout'), '/srv/work')).toEqual({
      status: 504,
      message: 'Cannot check the folder: Studio Mac did not answer',
    });
  });

  it('any other refusal says what the host said', async () => {
    expect(
      await managerFolderProblem(deps(refused('permission_denied', 'EACCES')), '/root'),
    ).toEqual({ status: 502, message: 'Cannot check the folder on Studio Mac: EACCES' });
  });

  it('a host with no name is named by its id', async () => {
    expect(
      await managerFolderProblem(deps(refused('not_found'), { hostName: () => undefined }), '/x'),
    ).toEqual({ status: 400, message: '/x is not a folder on h1' });
  });
});
