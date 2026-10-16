// How the chat's markdown-it is set up. `typographer` is on for its smart
// quotes, but its text replacements are not: they rewrite what the agent
// actually wrote — "(c)" becomes ©, "(r)" ®, "--" an en dash, "+-" ± — so an
// answer that lists options as "(a) … (c)" came out with a copyright sign.

/** The slice of markdown-it this needs, so the library's own type is not imported here. */
interface Configurable {
  disable(rules: string | string[]): unknown;
}

export function configureMarkdownIt<T extends Configurable>(md: T): T {
  md.disable('replacements');
  return md;
}
