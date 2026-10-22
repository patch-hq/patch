// The browser-level DevTools shapes the agent browser bridge (agent-browser.ts)
// answers with, translated from Electron's own APIs. Free of any electron
// RUNTIME import so it is unit-tested under plain node
// (agent-browser-cdp.test.ts); the types are imported only.

import type { Cookie, CookiesSetDetails } from 'electron';

/** A cookie as `Storage.getCookies` / `Network.Cookie` describes one. */
export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  size: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/** What `Storage.setCookies` / `Network.CookieParam` carries. */
export interface CdpCookieParam {
  name: string;
  value: string;
  url?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  expires?: number;
}

const SAME_SITE_TO_CDP: Record<string, CdpCookie['sameSite'] | undefined> = {
  no_restriction: 'None',
  lax: 'Lax',
  strict: 'Strict',
};

export function cookieToCdp(c: Cookie): CdpCookie {
  const sameSite = SAME_SITE_TO_CDP[c.sameSite ?? ''];
  return {
    name: c.name,
    value: c.value,
    domain: c.domain ?? '',
    path: c.path ?? '/',
    expires: c.expirationDate ?? -1,
    size: c.name.length + c.value.length,
    httpOnly: c.httpOnly ?? false,
    secure: c.secure ?? false,
    session: c.session ?? c.expirationDate === undefined,
    ...(sameSite ? { sameSite } : {}),
  };
}

/**
 * Electron sets a cookie against a URL. A DevTools cookie may name only a
 * domain: the URL is built from it (a leading dot is a domain cookie).
 */
export function cookieFromCdp(p: CdpCookieParam): CookiesSetDetails {
  const host = (p.domain ?? '').replace(/^\./, '');
  const url = p.url ?? `${p.secure ? 'https' : 'http'}://${host}${p.path ?? '/'}`;
  if (!p.url && host === '') throw new Error(`cookie "${p.name}" names neither a url nor a domain`);
  const sameSite =
    p.sameSite === 'None'
      ? 'no_restriction'
      : p.sameSite === 'Lax'
        ? 'lax'
        : p.sameSite === 'Strict'
          ? 'strict'
          : undefined;
  return {
    url,
    name: p.name,
    value: p.value,
    ...(p.domain && p.domain.startsWith('.') ? { domain: p.domain } : {}),
    ...(p.path ? { path: p.path } : {}),
    ...(p.secure !== undefined ? { secure: p.secure } : {}),
    ...(p.httpOnly !== undefined ? { httpOnly: p.httpOnly } : {}),
    ...(p.expires !== undefined && p.expires > 0 ? { expirationDate: p.expires } : {}),
    ...(sameSite ? { sameSite } : {}),
  };
}

/** The URL Electron removes a cookie by. */
export function cookieUrl(c: { domain?: string; path?: string; secure?: boolean }): string {
  return `${c.secure ? 'https' : 'http'}://${(c.domain ?? '').replace(/^\./, '')}${c.path ?? '/'}`;
}

/**
 * Electron's permission names for the DevTools ones Playwright grants. A
 * DevTools permission with no Electron counterpart maps to itself and is
 * simply never asked for.
 */
export function electronPermission(cdp: string): string {
  switch (cdp) {
    case 'clipboardReadWrite':
      return 'clipboard-read';
    case 'clipboardSanitizedWrite':
      return 'clipboard-sanitized-write';
    case 'geolocation':
      return 'geolocation';
    case 'notifications':
      return 'notifications';
    case 'audioCapture':
      return 'media';
    case 'videoCapture':
      return 'media';
    default:
      return cdp;
  }
}

/** Whether `origin` (or every origin, when the grant named none) may use `permission`. */
export function permissionGranted(
  grants: ReadonlyArray<{ origin: string | undefined; permissions: ReadonlyArray<string> }>,
  origin: string,
  permission: string,
): boolean {
  return grants.some(
    (g) =>
      (g.origin === undefined || g.origin === origin) &&
      g.permissions.some((p) => electronPermission(p) === permission),
  );
}

/** A DevTools download state from an Electron DownloadItem's. */
export function downloadState(
  electronState: 'progressing' | 'completed' | 'cancelled' | 'interrupted',
): 'inProgress' | 'completed' | 'canceled' {
  if (electronState === 'completed') return 'completed';
  if (electronState === 'progressing') return 'inProgress';
  return 'canceled';
}

/**
 * The endpoint file the host reads to reach this bridge. Written mode 600: the
 * token in `endpoint` is what lets a process drive the agent's signed-in
 * browser, so only this user may read it.
 */
export interface AgentBrowserEndpoint {
  /** `ws://127.0.0.1:<port>/devtools/browser/<token>`, absent while the app is not running. */
  endpoint?: string;
  pid?: number;
  /** The app to start when it is not running (the .app bundle on a Mac). */
  appPath: string;
  version: string;
}
