// Flatten markdown to plain text for surfaces that render a single line
// verbatim — sidebar titles/previews, native OS toasts — where `**x**`,
// `| a | b |`, `# h`, `[t](url)` etc. must not show as literal syntax.
export function stripMarkdown(s: string): string {
  return (
    s
      .replace(/`{1,3}([^`]*)`{1,3}/g, '$1') // code spans/fences → inner text
      .replace(/!?\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1') // links/images → label (url may hold one level of brackets)
      .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1') // bold/italic → inner text
      // Underscore emphasis only counts at word edges: `my_file_name` is a name.
      .replace(/(^|\W)_{1,3}([^_]+)_{1,3}(?!\w)/g, '$1$2')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '') // ATX headings
      .replace(/^\s{0,3}>\s?/gm, '') // blockquotes
      .replace(/^\s{0,3}[-*+]\s+/gm, '') // list bullets
      .replace(/\|/g, ' ') // table pipes
      // Rules and table delimiter rows are whole lines; `a === b` and `x --- y` are text.
      .replace(/^[ \t|:-]*-{3,}[ \t|:-]*$/gm, ' ')
      .replace(/^[ \t]*={3,}[ \t]*$/gm, ' ')
      .replace(/~~([^~]+)~~/g, '$1') // strikethrough → inner text
      // Stray emphasis/code tokens only. `#`, `>` and `~` are NOT stripped here:
      // headings and quotes are handled line-anchored above, and elsewhere they
      // are text ("C#", "~/projects", "a > b").
      .replace(/[*`]/g, '')
      // Stray underscores: a run not attached to a word on either side. One that
      // follows a letter (`file__name__.txt`) is part of the name — CommonMark
      // cannot open emphasis there either.
      .replace(/(^|\W)_+(?=\W|$)/g, '$1')
      .replace(/\s+/g, ' ') // collapse to one line
      .trim()
  );
}
