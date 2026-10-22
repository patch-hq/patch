// The agent browser bridge's translations between Electron and the DevTools
// protocol (agent-browser-cdp.ts) — spec/02 § Browser — In the Patch app.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cookieFromCdp,
  cookieToCdp,
  cookieUrl,
  downloadState,
  electronPermission,
  permissionGranted,
} from './agent-browser-cdp';

test('an Electron cookie reads as a DevTools one', () => {
  assert.deepEqual(
    cookieToCdp({
      name: 'sid',
      value: 'abc',
      domain: '.gwr.com',
      path: '/',
      secure: true,
      httpOnly: true,
      session: false,
      expirationDate: 1_900_000_000,
      sameSite: 'lax',
    }),
    {
      name: 'sid',
      value: 'abc',
      domain: '.gwr.com',
      path: '/',
      expires: 1_900_000_000,
      size: 6,
      httpOnly: true,
      secure: true,
      session: false,
      sameSite: 'Lax',
    },
  );
  // A session cookie has no expiry, and an unspecified same-site is left out.
  const session = cookieToCdp({ name: 'a', value: 'b', domain: 'x.com', sameSite: 'unspecified' });
  assert.equal(session.expires, -1);
  assert.equal(session.session, true);
  assert.equal('sameSite' in session, false);
});

test('a DevTools cookie is set against a URL Electron can take', () => {
  assert.deepEqual(
    cookieFromCdp({
      name: 'n',
      value: 'v',
      domain: '.gwr.com',
      path: '/a',
      secure: true,
      sameSite: 'None',
      expires: 5,
    }),
    {
      url: 'https://gwr.com/a',
      name: 'n',
      value: 'v',
      domain: '.gwr.com',
      path: '/a',
      secure: true,
      expirationDate: 5,
      sameSite: 'no_restriction',
    },
  );
  // A host-only cookie keeps no domain of its own; an expiry of -1 is a session cookie.
  assert.deepEqual(cookieFromCdp({ name: 'n', value: 'v', domain: 'gwr.com', expires: -1 }), {
    url: 'http://gwr.com/',
    name: 'n',
    value: 'v',
  });
  assert.equal(
    cookieFromCdp({ name: 'n', value: 'v', url: 'https://x.com/p' }).url,
    'https://x.com/p',
  );
  assert.throws(() => cookieFromCdp({ name: 'n', value: 'v' }), /neither a url nor a domain/);
  assert.equal(cookieUrl({ domain: '.gwr.com', path: '/', secure: true }), 'https://gwr.com/');
});

test('permissions are granted per origin, by their Electron names', () => {
  assert.equal(electronPermission('clipboardReadWrite'), 'clipboard-read');
  const grants = [
    { origin: 'https://a.com', permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] },
    { origin: undefined, permissions: ['geolocation'] },
  ];
  assert.equal(permissionGranted(grants, 'https://a.com', 'clipboard-read'), true);
  assert.equal(permissionGranted(grants, 'https://b.com', 'clipboard-read'), false);
  assert.equal(permissionGranted(grants, 'https://b.com', 'geolocation'), true);
  assert.equal(permissionGranted([], 'https://a.com', 'notifications'), false);
});

test('a download’s state reads as DevTools says it', () => {
  assert.equal(downloadState('progressing'), 'inProgress');
  assert.equal(downloadState('completed'), 'completed');
  assert.equal(downloadState('cancelled'), 'canceled');
  assert.equal(downloadState('interrupted'), 'canceled');
});
