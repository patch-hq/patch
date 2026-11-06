// Render coverage for the Files tab (app/(tabs)/files.tsx): one row per
// registered host, each opening that host's Files browser.

import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { renderRN, byTestId, findHost, queryHost, actSync } from './testUtils/render';
import FilesTab from '../app/(tabs)/files';
import { usePresenceStore } from '../src/stores/presenceStore';
import { reportHost, resetHosts } from './testUtils/settingsFixtures';
import { routerMock, __resetRouterMock } from './stubs/expo-router';

beforeEach(() => {
  resetHosts();
  __resetRouterMock();
});

describe('FilesTab', () => {
  it('says so when there are no hosts', () => {
    const r = renderRN(<FilesTab />);
    expect(queryHost(r.root, byTestId('files-no-hosts'))).not.toBeNull();
  });

  it('lists each host and opens its Files browser on tap', () => {
    reportHost('h1', { hostName: 'netcup' });
    expect(Object.keys(usePresenceStore.getState().hosts)).toContain('h1');
    const r = renderRN(<FilesTab />);
    const row = findHost(r.root, byTestId('files-host-h1'));
    actSync(() => {
      (row.props as { onPress: () => void }).onPress();
    });
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/hosts/[hostId]/files',
      params: { hostId: 'h1' },
    });
  });
});
