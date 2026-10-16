import { describe, expect, it } from 'vitest';
import { editorOptionsFor } from '../components/EditorRail.js';

describe('editorOptionsFor', () => {
  it.each(['markdown', 'typescript', 'plaintext'])(
    "suppresses Monaco's IDE context menu for %s",
    (language) => {
      expect(editorOptionsFor(language).contextmenu).toBe(false);
    },
  );
});
