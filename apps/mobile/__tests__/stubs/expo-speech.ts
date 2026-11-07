// expo-speech stand-in for unit tests: records what was spoken and lets a test
// finish or fail the utterance.

export interface SpeakOptions {
  language?: string;
  onDone?: () => void;
  onStopped?: () => void;
  onError?: (e: Error) => void;
}

let _spoken: string[] = [];
let _opts: SpeakOptions | null = null;
let _fail: string | null = null;

export function speak(text: string, options?: SpeakOptions): void {
  if (_fail !== null) throw new Error(_fail);
  _spoken.push(text);
  _opts = options ?? null;
}

export function stop(): Promise<void> {
  const o = _opts;
  _opts = null;
  o?.onStopped?.();
  return Promise.resolve();
}

export function __spoken(): string[] {
  return _spoken;
}
export function __finish(): void {
  const o = _opts;
  _opts = null;
  o?.onDone?.();
}
export function __error(message: string): void {
  _opts?.onError?.(new Error(message));
}
export function __setFail(message: string | null): void {
  _fail = message;
}
export function __resetSpeech(): void {
  _spoken = [];
  _opts = null;
  _fail = null;
}
