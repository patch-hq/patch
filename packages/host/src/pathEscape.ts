import { isAbsolute, sep } from 'node:path';

/**
 * True when `rel` (from `path.relative(folder, target)`) leaves the folder.
 * Only a `..` path SEGMENT escapes — `..report.html` is an ordinary name.
 */
export function escapesFolder(rel: string): boolean {
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}
