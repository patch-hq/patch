// Turns dictation mode sent by itself (spec/07 § Dictation mode). A chat
// re-pins to the bottom when the user sends (spec/14 § Main chat panel), but
// dictation sends on its own while they may be reading, so the chat must not
// treat those echoes as the user asking to go to the bottom.
const dictated = new Set<string>();

export function markDictatedSend(localId: string): void {
  dictated.add(localId);
}

export function isDictatedSend(localId: string): boolean {
  return dictated.has(localId);
}
