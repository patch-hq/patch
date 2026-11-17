// Writing the user's choice of a provider's OWN settings into the provider's
// own configuration (spec/10 § Provider settings).
//
// Patch writes only what the user chose. A setting nobody chose is never
// written, so the provider's own value (or its default) stands; and a value the
// user chose is written only when the file does not already hold it, so a file
// that already agrees is left byte-for-byte alone.
//
// NO FALLBACK: a settings.json that is not a JSON object is reported and left
// as it is. It is never replaced to make the write succeed.

import { providerDescriptor, providerSettingDescriptor, type SharedSettings } from '@patch/wire';
import {
  InvalidSettingsJsonError,
  readClaudeSettingsJson,
  writeClaudeSettingsJson,
} from './claudeSettings.js';

/**
 * Apply the chosen Claude Code settings to `<claudeHome>/settings.json`.
 * Returns the keys written (empty when the file already agreed). Throws
 * `InvalidSettingsJsonError` when the file cannot be edited safely.
 */
export function applyClaudeProviderSettings(
  claudeHome: string,
  chosen: SharedSettings['providerSettings'],
): string[] {
  const mine = chosen['claude'] ?? {};
  const keys = Object.keys(mine);
  if (keys.length === 0) return [];
  for (const key of keys) providerSettingDescriptor('claude', key);
  const text = readClaudeSettingsJson(claudeHome);
  let doc: Record<string, unknown> = {};
  if (text.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new InvalidSettingsJsonError((e as Error).message);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new InvalidSettingsJsonError('settings.json must be a JSON object');
    }
    doc = parsed as Record<string, unknown>;
  }
  const written: string[] = [];
  for (const key of keys) {
    if (doc[key] === mine[key]) continue;
    doc[key] = mine[key];
    written.push(key);
  }
  if (written.length > 0) writeClaudeSettingsJson(claudeHome, `${JSON.stringify(doc, null, 2)}\n`);
  return written;
}

/** The value a provider's own configuration holds for a setting, or undefined when it holds none. */
export function readProviderSetting(
  providerId: string,
  settingsJson: string,
  key: string,
): number | undefined {
  providerDescriptor(providerId);
  if (settingsJson.trim() === '') return undefined;
  const parsed = JSON.parse(settingsJson) as Record<string, unknown>;
  const v = parsed[key];
  return typeof v === 'number' ? v : undefined;
}
