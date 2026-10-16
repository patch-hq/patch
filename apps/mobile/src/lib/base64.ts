// Standard bytes → base64. RN/Hermes has no btoa, and a codec dependency is
// overkill for the one place that needs it (a doc export's bytes, written to
// disk through expo-file-system's base64 encoding).

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += CHARS[(n >> 18) & 63]! + CHARS[(n >> 12) & 63]! + CHARS[(n >> 6) & 63]! + CHARS[n & 63]!;
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i]! << 16;
    out += CHARS[(n >> 18) & 63]! + CHARS[(n >> 12) & 63]! + '==';
  } else if (rem === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += CHARS[(n >> 18) & 63]! + CHARS[(n >> 12) & 63]! + CHARS[(n >> 6) & 63]! + '=';
  }
  return out;
}
