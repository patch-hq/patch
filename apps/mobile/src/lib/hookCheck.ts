// Message hooks on the phone (spec/20-hooks.md § On the user's message, spec/15
// § Composer): every send into an existing chat is checked with
// `POST /api/hooks/check` before it is handed to delivery. Own fetch rather
// than `api` so the call has the bounded timeout the composer's "Checking…"
// state relies on.

import type { HookCheckResponse, HookRunResult } from '@patch/wire/hooks';
import * as FileSystem from 'expo-file-system';
import { HOOK_IMAGES_MAX, HOOK_IMAGE_MAX_BASE64, type HookImage } from '@patch/wire/hooks';
import { apiUrl } from '../config';
import type { PendingAttachment } from '../stores/composerAttachmentStore';
import { downscaleImage } from './imageResize';
import { loadCredential } from './credential';

export const HOOK_CHECK_TIMEOUT_MS = 20_000;

/** A check that could not be completed never stops a send (spec/20): it rides on the message as a failed-hook note. */
function unchecked(error: string): HookCheckResponse {
  return {
    decision: 'advise',
    results: [
      { hookId: 'hook-check', hookName: 'Hook check', status: 'failed', error, durationMs: 0 },
    ],
  };
}

const HOOK_IMAGE_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

/**
 * The composer's image attachments as hook images (spec/20 § Hook context):
 * downscaled, base64. Non-image files are not sent. An image that can't be
 * sent is named in `problems` — never silently dropped.
 */
async function hookImages(
  attachments: readonly PendingAttachment[],
): Promise<{ images: HookImage[]; problems: string[] }> {
  const images: HookImage[] = [];
  const problems: string[] = [];
  for (const a of attachments) {
    if (a.kind !== 'image') continue;
    if (images.length >= HOOK_IMAGES_MAX) {
      problems.push(`too many images for hooks (max ${HOOK_IMAGES_MAX}): ${a.name} not checked`);
      continue;
    }
    try {
      const up = await downscaleImage(a);
      if (!HOOK_IMAGE_TYPES.includes(up.mimeType)) {
        problems.push(`${up.name} (${up.mimeType}) is not an image type hooks can check`);
        continue;
      }
      const data = await FileSystem.readAsStringAsync(up.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      if (data.length > HOOK_IMAGE_MAX_BASE64) {
        problems.push(`${up.name} is too large for hooks to check`);
        continue;
      }
      images.push({ mediaType: up.mimeType as HookImage['mediaType'], data });
    } catch (err) {
      problems.push(`${a.name} could not be read for hooks: ${(err as Error).message}`);
    }
  }
  return { images, problems };
}

export async function checkHooks(
  chatId: string,
  message: string,
  attachments: readonly PendingAttachment[] = [],
): Promise<HookCheckResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HOOK_CHECK_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const cred = loadCredential();
    if (cred) headers['authorization'] = `Bearer ${cred}`;
    // Nothing enabled to check against: skip the image downscale/read and the
    // check round trip entirely (spec/20-hooks.md: no hooks pays no latency).
    const list = await fetch(apiUrl('/api/hooks'), { headers, signal: ctrl.signal });
    if (!list.ok) return unchecked(`HTTP ${list.status}`);
    const { hooks } = (await list.json()) as { hooks: { enabled: boolean; when: string }[] };
    if (!hooks.some((h) => h.enabled && h.when === 'user_message')) {
      return { decision: 'pass', results: [] };
    }
    const { images, problems } = await hookImages(attachments);
    const res = await fetch(apiUrl('/api/hooks/check'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ chatId, message, ...(images.length > 0 ? { images } : {}) }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      if ([502, 503, 504].includes(res.status)) {
        return unchecked(`Patch server unreachable (HTTP ${res.status}) — it may be restarting`);
      }
      return unchecked(`HTTP ${res.status}`);
    }
    const body = (await res.json()) as HookCheckResponse;
    if (problems.length === 0) return body;
    // Say so rather than let a hook that looks at images appear to have
    // passed an image it never saw.
    return {
      decision: body.decision === 'block' ? 'block' : 'advise',
      results: [...body.results, ...problems.flatMap((p) => unchecked(p).results)],
    };
  } catch (err) {
    if (ctrl.signal.aborted) return unchecked('timed out waiting for hooks');
    return unchecked((err as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

/** The results that annotate the sent message: failures and advice (not passes). */
export function adviseNotes(
  results: readonly HookRunResult[],
): { hookId: string; hookName: string; analysis?: string }[] {
  return results
    .filter((r) => r.status !== 'ok' || r.decision === 'advise')
    .map((r) => ({
      hookId: r.hookId,
      hookName: r.hookName,
      ...(r.status !== 'ok'
        ? { analysis: `Hook failed: ${r.error ?? r.status}` }
        : r.analysis !== undefined
          ? { analysis: r.analysis }
          : {}),
    }));
}
