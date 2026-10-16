// JobBar — chat-detail bar linking a job-created chat to its job (spec/15 §
// Chat detail → Status bars).

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { flush, renderRN, findHost, queryHost, byTestId } from './testUtils/render';
import { routerMock } from './stubs/expo-router';
import type { ChatRow } from '../src/stores/types';
import { api } from '../src/api/rest';
import { JobBar } from '../src/components/chatBars/JobBar';

const row = (jobId: string | null): ChatRow => ({ chatId: 'c1', jobId }) as ChatRow;

beforeEach(() => {
  vi.spyOn(api, 'getJob').mockResolvedValue({ id: 'j_bus', name: 'bus check' });
  routerMock.push.mockClear();
});

describe('JobBar', () => {
  it('renders nothing for a chat no job created', () => {
    const r = renderRN(<JobBar row={row(null)} />);
    expect(queryHost(r.root, byTestId('job-bar'))).toBeNull();
  });

  it('opens the job when tapped', () => {
    const r = renderRN(<JobBar row={row('j_bus')} />);
    findHost(r.root, byTestId('job-bar')).props.onPress();
    expect(routerMock.push).toHaveBeenCalledWith('/settings/job-editor?id=j_bus');
  });

  it('names the job', async () => {
    const r = renderRN(<JobBar row={row('j_bus')} />);
    await flush();
    expect(JSON.stringify(r.toJSON())).toContain('Run by \\"bus check\\" job');
  });
});
