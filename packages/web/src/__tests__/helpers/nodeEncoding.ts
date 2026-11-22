// The real server and host sign credentials with `jose`, which checks payloads
// with `instanceof Uint8Array`. Under jsdom the global Uint8Array and the
// TextEncoder are another realm's than the bytes Node produces, so the check
// fails. A test that boots the real stack imports this first, putting Node's
// own back.
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'node:util';

const NodeUint8Array = Object.getPrototypeOf(Buffer.prototype).constructor as Uint8ArrayConstructor;
globalThis.Uint8Array = NodeUint8Array;
globalThis.TextEncoder = NodeTextEncoder as unknown as typeof TextEncoder;
globalThis.TextDecoder = NodeTextDecoder as unknown as typeof TextDecoder;
