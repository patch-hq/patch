// Appending to a JSONL file that a crash may have cut short.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/**
 * What to write before the next line: a newline when the file exists, holds
 * something and ends on anything but one (a crash mid-append), else nothing.
 * Gluing the next entry onto a torn line would turn BOTH into one line no
 * reader can parse.
 */
export function newlineIfTorn(path: string): '' | '\n' {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return '';
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return '';
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] === 0x0a ? '' : '\n';
  } finally {
    closeSync(fd);
  }
}
