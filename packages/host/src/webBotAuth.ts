// The deployment-owned private key stays on the paired Patch server. A host
// only knows its public directory and asks the server for per-request headers.

import { DIRECTORY_PATH } from '@patch/wire/web-bot-auth';

export interface WebBotAuthConfig {
  /** URL placed in `Signature-Agent`; where verifiers fetch the public key. */
  directoryUrl: string;
  sign(url: string): Promise<Record<string, string>>;
}

/** Bind remote signing and the public directory to this host's paired server. */
export function webBotAuthFromServer(
  serverUrl: string,
  sign: (url: string, directoryUrl: string) => Promise<Record<string, string>>,
): WebBotAuthConfig {
  const origin = new URL(serverUrl).origin;
  const directoryUrl = `${origin}${DIRECTORY_PATH}`;
  return {
    directoryUrl,
    sign: (url) => sign(url, directoryUrl),
  };
}
