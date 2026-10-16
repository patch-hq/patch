// expo-clipboard stand-in for unit tests. The diagnostics screen copies its
// report here; tests assert on what was written and can force a rejection to
// exercise the loud copy-failed path.

let _last: string | null = null;
let _fail = false;

export async function setStringAsync(text: string): Promise<boolean> {
  if (_fail) throw new Error('clipboard unavailable');
  _last = text;
  return true;
}

let _lastImage: string | null = null;

export async function setImageAsync(base64: string): Promise<void> {
  if (_fail) throw new Error('clipboard unavailable');
  _lastImage = base64;
}

export function __lastCopiedImage(): string | null {
  return _lastImage;
}

export function __lastCopied(): string | null {
  return _last;
}

export function __setFail(v: boolean): void {
  _fail = v;
}

export function __resetClipboard(): void {
  _last = null;
  _lastImage = null;
  _fail = false;
}
