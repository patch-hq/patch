// react-native-view-shot stand-in for unit tests: tests that care mock it themselves.

export function captureScreen(_options?: unknown): Promise<string> {
  return Promise.reject(new Error('react-native-view-shot is a stub in unit tests'));
}
