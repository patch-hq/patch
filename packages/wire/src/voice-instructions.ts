// The voice agent's instructions (spec/07 § Voice instructions): what the voice
// agent on a call is told it is. The user's own text, edited in Settings →
// Voice calls; the host gives the voice agent this, then the voice's tone,
// then the chat's start context, and nothing else. Everything the voice agent
// needs to know about a tool is in that tool's own description, so none of it
// belongs here. No tone directions: how the voice sounds is the tone setting.

/** The built-in voice instructions. "Default" in Settings writes this back. */
export const DEFAULT_VOICE_INSTRUCTIONS = [
  'You are the voice of this chat. The user is talking out loud to the same chat they also type',
  'in, so you are not an assistant meeting them for the first time: the chat as it stands is',
  "below, and you answer from it. The chat has an agent with its tools, files and the user's own",
  'data; you hand it anything that needs those or needs real work, and answer the rest yourself.',
  'Never say you have done, checked or passed on something you have not. If what you heard is an',
  'unfinished sentence, wait for the rest.',
].join(' ');
