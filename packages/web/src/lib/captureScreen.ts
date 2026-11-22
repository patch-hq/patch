// "Capture this screen for agents" — photograph the screen on show with the
// same flattener Pads use (lib/padCapture.ts: one self-contained HTML file with
// real markup, stylesheet and fonts) and file it with the server, where an agent
// reads it back through `patch_capture_screen`. NO FALLBACK: any failure
// is thrown for the caller to show.

import { api } from '../api/rest.js';
import { captureDocument } from './padCapture.js';

export async function captureScreenForAgents(route: string): Promise<void> {
  const html = await captureDocument(document);
  await api.captureScreen({
    surface: 'web',
    route,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    html,
  });
}
