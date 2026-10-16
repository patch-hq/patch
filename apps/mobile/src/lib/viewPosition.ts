// Handover between surfaces (spec/05 § Handover): the pure mapping between the
// app's routes and the surface-neutral page/position the wire carries.

import type { ViewPage } from '@patch/wire';

export interface ViewPositionTarget {
  page: ViewPage;
  id?: string;
  seq?: number;
}

/** The position a route stands for; null for screens with no cross-surface equivalent. */
export function positionFromRoute(
  pathname: string,
  params: { id?: string },
  scrollSeq: number | null,
): ViewPositionTarget | null {
  const parts = pathname
    .split('/')
    .filter((p) => p !== '' && !(p.startsWith('(') && p.endsWith(')')));
  const [head, second] = parts;
  if (head === 'chats' && second !== undefined) {
    return {
      page: 'chat',
      id: decodeURIComponent(second),
      ...(scrollSeq !== null ? { seq: scrollSeq } : {}),
    };
  }
  if (head === 'jobs') return { page: 'jobs' };
  if (head === 'settings' && second === 'job-editor' && params.id && params.id !== 'new') {
    return { page: 'job', id: params.id };
  }
  if (head === 'pads') {
    return second === undefined || second === 'new'
      ? { page: 'pads' }
      : { page: 'pad', id: decodeURIComponent(second) };
  }
  if (head === 'settings') return { page: 'settings' };
  return null;
}

/** The route that opens a position. */
export function routeFromPosition(pos: ViewPositionTarget): string {
  const id = pos.id === undefined ? '' : encodeURIComponent(pos.id);
  switch (pos.page) {
    case 'chat':
      return `/chats/${id}${pos.seq !== undefined ? `?seq=${String(pos.seq)}` : ''}`;
    case 'jobs':
      return '/jobs';
    case 'job':
      return `/settings/job-editor?id=${id}`;
    case 'pads':
      return '/pads';
    case 'pad':
      return `/pads/${id}`;
    case 'settings':
      return '/settings';
  }
}

/**
 * The path a focused route stands for, rebuilt from its file-based name
 * (`chats/[chatId]`) and params, so handover never has to ask expo-router's
 * store hooks for it. A dynamic segment without its param is a bug in the
 * caller, so it throws rather than inventing a path.
 */
export function pathFromRoute(name: string, params: Record<string, unknown> | undefined): string {
  const parts = name.split('/').map((part) => {
    const dynamic = /^\[(\.\.\.)?(.+)\]$/.exec(part);
    if (dynamic === null) return part;
    const value = params?.[dynamic[2] as string];
    if (value === undefined || value === null) {
      throw new Error(`route ${name} is missing its ${dynamic[2]} param`);
    }
    return (Array.isArray(value) ? value.map(String) : [String(value)])
      .map(encodeURIComponent)
      .join('/');
  });
  if (parts[parts.length - 1] === 'index') parts.pop();
  return `/${parts.join('/')}`;
}
