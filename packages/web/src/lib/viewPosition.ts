// Handover between surfaces (spec/05 § Handover): the pure mapping between the
// web app's URLs and the surface-neutral page/position the wire carries.

import type { ViewPage } from '@patch/wire';

export interface ViewPositionTarget {
  page: ViewPage;
  id?: string;
  seq?: number;
}

/** The position a URL stands for; null for pages with no cross-surface equivalent. */
export function positionFromPath(
  pathname: string,
  scrollSeq: number | null,
): ViewPositionTarget | null {
  const parts = pathname.split('/').filter(Boolean);
  const [head, second] = parts;
  if (head === 'chats' && second !== undefined && second !== 'new') {
    return {
      page: 'chat',
      id: decodeURIComponent(second),
      ...(scrollSeq !== null ? { seq: scrollSeq } : {}),
    };
  }
  if (head === 'jobs') {
    return second === undefined || second === 'new'
      ? { page: 'jobs' }
      : { page: 'job', id: decodeURIComponent(second) };
  }
  if (head === 'pads') {
    return second === undefined || second === 'new'
      ? { page: 'pads' }
      : { page: 'pad', id: decodeURIComponent(second) };
  }
  if (head === 'settings') return { page: 'settings' };
  return null;
}

/** The URL that opens a position. */
export function pathFromPosition(pos: ViewPositionTarget): string {
  const id = pos.id === undefined ? '' : encodeURIComponent(pos.id);
  switch (pos.page) {
    case 'chat':
      return `/chats/${id}${pos.seq !== undefined ? `?seq=${String(pos.seq)}` : ''}`;
    case 'jobs':
      return '/jobs';
    case 'job':
      return `/jobs/${id}`;
    case 'pads':
      return '/pads';
    case 'pad':
      return `/pads/${id}`;
    case 'settings':
      return '/settings';
  }
}
