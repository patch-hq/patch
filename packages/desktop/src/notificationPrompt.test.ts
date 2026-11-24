import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askNotificationPermissionOnce } from './notificationPrompt';

const fresh = (): string => join(mkdtempSync(join(tmpdir(), 'notif-prompt-')), 'asked.json');

describe('askNotificationPermissionOnce', () => {
  it('posts once on macOS and remembers it', () => {
    const file = fresh();
    let shown = 0;
    const show = (): void => void shown++;
    assert.equal(askNotificationPermissionOnce({ platform: 'darwin', file, show }), true);
    assert.equal(askNotificationPermissionOnce({ platform: 'darwin', file, show }), false);
    assert.equal(shown, 1);
  });
  it('does nothing off macOS', () => {
    const file = fresh();
    let shown = 0;
    assert.equal(
      askNotificationPermissionOnce({ platform: 'linux', file, show: () => void shown++ }),
      false,
    );
    assert.equal(shown, 0);
    assert.equal(existsSync(file), false);
  });
});
