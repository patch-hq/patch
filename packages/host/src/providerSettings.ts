// Writing the user's choice of a provider's OWN settings into the provider's
// own configuration (spec/10 § Provider settings; decision 9).
//
// Patch writes only what the user chose. A setting nobody chose is never
// written, so the provider's own value (or its default) stands; and a value the
// user chose is written only when the file does not already hold it, so a file
// that already agrees is left byte-for-byte alone.
//
// One writer serves every provider: a setting says where it goes (its dotted
// `key` is the path in the file) and how its number is written (`write`), and
// the provider says whether its file is JSON or TOML. Each host adapter says
// where its files are. No provider is named here.
//
// NO FALLBACK: a file that cannot be edited safely (not a JSON object; a TOML
// table defined in a way this writer does not edit) is reported and left as it
// is. It is never replaced to make the write succeed.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ownSettingValue, type OwnSetting } from '@patch/wire';

/** A provider's own configuration file this host writes into. */
export interface OwnConfigFile {
  /** Where it is, for a report that it could not be written. */
  label: string;
  /** Its text; empty when it does not exist yet. */
  read(): string;
  write(text: string): void;
}

export class OwnConfigError extends Error {
  override readonly name = 'OwnConfigError';
}

/** A plain file on disk, written atomically and private to the user. */
export function ownConfigFile(path: string): OwnConfigFile {
  return {
    label: path,
    read: () => (existsSync(path) ? readFileSync(path, 'utf8') : ''),
    write: (text) => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = `${path}.patch-${process.pid}.tmp`;
      writeFileSync(tmp, text, { mode: 0o600 });
      renameSync(tmp, path);
    },
  };
}

/** The chosen values for one provider's declared settings, in declaration order. */
function chosenOf(
  settings: readonly OwnSetting[],
  chosen: Record<string, number> | undefined,
): Array<{ setting: OwnSetting; value: number | string | boolean }> {
  const out: Array<{ setting: OwnSetting; value: number | string | boolean }> = [];
  for (const setting of settings) {
    const n = chosen?.[setting.key];
    if (n !== undefined) out.push({ setting, value: ownSettingValue(setting, n) });
  }
  return out;
}

/** Set dotted-path values in a JSON object's text. Returns the new text and the keys changed. */
export function editJsonOwnSettings(
  text: string,
  values: Array<{ setting: OwnSetting; value: number | string | boolean }>,
): { text: string; written: string[] } {
  let doc: Record<string, unknown> = {};
  if (text.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new OwnConfigError(`it is not valid JSON (${(e as Error).message})`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new OwnConfigError('it must be a JSON object');
    }
    doc = parsed as Record<string, unknown>;
  }
  const written: string[] = [];
  for (const { setting, value } of values) {
    const path = setting.key.split('.');
    let at: Record<string, unknown> = doc;
    for (const part of path.slice(0, -1)) {
      const next = at[part];
      if (next === undefined) at[part] = {};
      else if (next === null || typeof next !== 'object' || Array.isArray(next)) {
        throw new OwnConfigError(
          `${path.slice(0, path.indexOf(part) + 1).join('.')} is not an object`,
        );
      }
      at = at[part] as Record<string, unknown>;
    }
    const leaf = path.at(-1)!;
    if (at[leaf] === value) continue;
    at[leaf] = value;
    written.push(setting.key);
  }
  return { text: written.length > 0 ? `${JSON.stringify(doc, null, 2)}\n` : text, written };
}

function tomlValue(v: number | string | boolean): string {
  return typeof v === 'string' ? JSON.stringify(v) : String(v);
}

/** A TOML line's value, without a trailing comment. */
function tomlLineValue(line: string): string {
  const eq = line.indexOf('=');
  let rest = line.slice(eq + 1).trim();
  if (!rest.startsWith('"')) rest = rest.replace(/\s+#.*$/, '');
  return rest.trim();
}

/**
 * Set `table.key` values in a TOML file's text, editing only that table's
 * `key = …` lines. A table defined any other way (inline, dotted keys outside
 * it, an array of tables) is refused rather than guessed at.
 */
export function editTomlOwnSettings(
  text: string,
  values: Array<{ setting: OwnSetting; value: number | string | boolean }>,
): { text: string; written: string[] } {
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  const written: string[] = [];
  for (const { setting, value } of values) {
    const parts = setting.key.split('.');
    if (parts.length !== 2) {
      throw new OwnConfigError(`${setting.key} is not a table.key this writer edits`);
    }
    const [table, key] = parts as [string, string];
    const header = new RegExp(`^\\s*\\[\\s*${table}\\s*\\]\\s*(#.*)?$`);
    const otherForms = [
      new RegExp(`^\\s*\\[\\[\\s*${table}\\s*\\]\\]`),
      new RegExp(`^\\s*${table}\\s*=`),
      new RegExp(`^\\s*${table}\\.`),
    ];
    // Top-level lines are those before the first table header.
    const firstHeader = lines.findIndex((l) => /^\s*\[/.test(l));
    const topLevel = firstHeader === -1 ? lines : lines.slice(0, firstHeader);
    if (
      lines.some((l) => otherForms[0]!.test(l)) ||
      topLevel.some((l) => otherForms[1]!.test(l) || otherForms[2]!.test(l))
    ) {
      throw new OwnConfigError(`[${table}] is defined in a form this writer does not edit`);
    }
    const formatted = tomlValue(value);
    const start = lines.findIndex((l) => header.test(l));
    if (start === -1) {
      if (lines.length > 0 && lines.at(-1)!.trim() !== '') lines.push('');
      lines.push(`[${table}]`, `${key} = ${formatted}`);
      written.push(setting.key);
      continue;
    }
    let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
    if (end === -1) end = lines.length;
    const keyLine = new RegExp(`^\\s*${key}\\s*=`);
    const at = lines.findIndex((l, i) => i > start && i < end && keyLine.test(l));
    if (at === -1) {
      // After the table's last key, so its blank separator stays where it was.
      let insert = end;
      while (insert - 1 > start && lines[insert - 1]!.trim() === '') insert--;
      lines.splice(insert, 0, `${key} = ${formatted}`);
      written.push(setting.key);
      continue;
    }
    if (tomlLineValue(lines[at]!) === formatted) continue;
    lines[at] = `${key} = ${formatted}`;
    written.push(setting.key);
  }
  return { text: written.length > 0 ? `${lines.join('\n')}\n` : text, written };
}

/**
 * Write one provider's chosen settings into each of its own files. Returns the
 * keys written per file; throws `OwnConfigError` naming every file that could
 * not be written, after writing the rest.
 */
export function applyOwnSettings(
  files: readonly OwnConfigFile[],
  format: 'json' | 'toml',
  settings: readonly OwnSetting[],
  chosen: Record<string, number> | undefined,
): Array<{ file: string; written: string[] }> {
  const values = chosenOf(settings, chosen);
  if (values.length === 0) return [];
  const out: Array<{ file: string; written: string[] }> = [];
  const failed: string[] = [];
  for (const file of files) {
    try {
      const before = file.read();
      const edit = format === 'json' ? editJsonOwnSettings : editTomlOwnSettings;
      const { text, written } = edit(before, values);
      if (written.length > 0) file.write(text);
      out.push({ file: file.label, written });
    } catch (e) {
      failed.push(`${file.label}: ${(e as Error).message}`);
    }
  }
  if (failed.length > 0) throw new OwnConfigError(failed.join('; '));
  return out;
}

/** The value a provider's own JSON configuration holds for a setting, or undefined when it holds none. */
export function readProviderSetting(settingsJson: string, key: string): number | undefined {
  if (settingsJson.trim() === '') return undefined;
  let at: unknown = JSON.parse(settingsJson);
  for (const part of key.split('.')) {
    if (at === null || typeof at !== 'object') return undefined;
    at = (at as Record<string, unknown>)[part];
  }
  return typeof at === 'number' ? at : undefined;
}
