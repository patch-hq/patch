import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notificationClickPath } from './notificationTarget';

test('batch and sign-in toasts never open a chat, whatever chatId they carry', () => {
  assert.equal(notificationClickPath('batch', 'batch_ready'), '/batch');
  assert.equal(notificationClickPath('sign-in', 'account-sign-in'), '/settings/usage');
});

test('a host-health toast opens the hosts settings, not a chat', () => {
  assert.equal(notificationClickPath('host-health', 'host-health'), '/settings/hosts');
});

test('an ordinary toast opens its chat, and one with no chat opens nothing', () => {
  assert.equal(notificationClickPath('message', 'c1'), '/chats/c1');
  assert.equal(notificationClickPath(undefined, 'c1'), '/chats/c1');
  assert.equal(notificationClickPath(undefined, undefined), null);
});
