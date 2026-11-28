// The Manager folder is checked on the Manager's home host before it is saved
// (spec/06 § Manager prompt and folder), whoever saves it: web, phone or
// `patch settings set manager-folder`. A refusal names the host as the user
// named it.

import type { HostFilesClient } from './host-files-routes.js';

export interface ManagerFolderCheckDeps {
  managerHostId: () => string | null;
  hostName: (hostId: string) => string | undefined;
  isOnline: (hostId: string) => boolean;
  hostFiles: HostFilesClient;
}

export interface ManagerFolderProblem {
  status: number;
  message: string;
}

/** Null when `path` is a folder on the Manager's home host; otherwise why it is refused. */
export async function managerFolderProblem(
  deps: ManagerFolderCheckDeps,
  path: string,
): Promise<ManagerFolderProblem | null> {
  const hostId = deps.managerHostId();
  if (hostId === null) return { status: 409, message: 'The Manager has no home host yet' };
  const name = deps.hostName(hostId) ?? hostId;
  if (!deps.isOnline(hostId)) {
    return { status: 503, message: `Cannot check the folder: ${name} is offline` };
  }
  const res = await deps.hostFiles.request(hostId, 'manager-folder', {
    op: 'list',
    path,
    maxEntries: 1,
  });
  if (res === 'timeout') {
    return { status: 504, message: `Cannot check the folder: ${name} did not answer` };
  }
  if (res.ok) return null;
  const code = res.error?.code;
  if (code === 'not_found' || code === 'not_a_directory' || code === 'path_invalid') {
    return { status: 400, message: `${path} is not a folder on ${name}` };
  }
  return {
    status: 502,
    message: `Cannot check the folder on ${name}: ${res.error?.message ?? code ?? 'no reason given'}`,
  };
}
