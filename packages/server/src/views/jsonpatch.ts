// A small JSON Patch (RFC 6902) applier for a view's data document: add,
// replace, remove. The agent sends the full document once, then only changes.
// NO FALLBACK: a path that does not exist, a bad index or an unknown op throws,
// and the document is left as it was (the patch applies to a copy).

export interface PatchOp {
  op: 'add' | 'replace' | 'remove';
  path: string;
  value?: unknown;
}

export class PatchError extends Error {}

function tokens(path: string): string[] {
  if (path === '') return [];
  if (!path.startsWith('/')) throw new PatchError(`bad path "${path}": must start with /`);
  return path
    .slice(1)
    .split('/')
    .map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function index(token: string, len: number, allowEnd: boolean, path: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(token)) throw new PatchError(`bad array index at "${path}"`);
  const i = Number(token);
  if (i > len || (i === len && !allowEnd)) throw new PatchError(`index out of range at "${path}"`);
  return i;
}

export function applyPatch(doc: unknown, ops: PatchOp[]): unknown {
  let out = structuredClone(doc);
  for (const o of ops) {
    const t = tokens(o.path);
    if (t.length === 0) {
      if (o.op === 'remove') throw new PatchError('cannot remove the whole document');
      out = structuredClone(o.value);
      continue;
    }
    let parent: any = out;
    for (const tok of t.slice(0, -1)) {
      if (Array.isArray(parent)) parent = parent[index(tok, parent.length, false, o.path)];
      else if (parent && typeof parent === 'object' && tok in parent) parent = parent[tok];
      else throw new PatchError(`no such path "${o.path}"`);
      if (parent === null || typeof parent !== 'object')
        throw new PatchError(`no such path "${o.path}"`);
    }
    const last = t[t.length - 1]!;
    if (o.op !== 'remove' && !('value' in o))
      throw new PatchError(`${o.op} at "${o.path}" needs a value`);
    if (Array.isArray(parent)) {
      if (o.op === 'add') {
        const i = last === '-' ? parent.length : index(last, parent.length, true, o.path);
        parent.splice(i, 0, structuredClone(o.value));
      } else {
        const i = index(last, parent.length, false, o.path);
        if (o.op === 'replace') parent[i] = structuredClone(o.value);
        else parent.splice(i, 1);
      }
    } else {
      if (o.op !== 'add' && !(last in parent)) throw new PatchError(`no such path "${o.path}"`);
      if (o.op === 'remove') delete parent[last];
      else parent[last] = structuredClone(o.value);
    }
  }
  return out;
}
