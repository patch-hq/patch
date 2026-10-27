import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripAppTokens } from './agent-user-agent';

test('removes the @patch/desktop token the app really sends', () => {
  const ua =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) @patch/desktop/1.1.594 Chrome/130.0.6723.191 Safari/537.36';
  assert.equal(
    stripAppTokens(ua),
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.191 Safari/537.36',
  );
});

test('removes Electron and bare patch tokens', () => {
  assert.equal(
    stripAppTokens('A Electron/33.0.0 Chrome/130 patch/1.0 Safari/537'),
    'A Chrome/130 Safari/537',
  );
});
