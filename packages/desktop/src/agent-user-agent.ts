// What sites see of the agent browser: a normal Chrome, with no app or
// Electron token. The app's own token is `@patch/desktop/<version>`, so the
// `@` has to be matched or Cloudflare Turnstile never renders.
export function stripAppTokens(userAgent: string): string {
  return userAgent.replace(/ (?:Electron|@?patch)\/\S+/gi, '');
}
