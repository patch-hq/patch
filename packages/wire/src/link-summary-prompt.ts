// The built-in instructions the message-link Summarise button runs with
// (spec/14 § Message links). Shared so Settings can offer "Reset to default"
// without a server round trip. The page text itself is appended by the host.
export const DEFAULT_LINK_SUMMARY_PROMPT = `Summarise the web page below for someone deciding whether to read it.
Give the gist in two or three short sentences, then up to three bullet points
with the key facts. Plain text, no preamble, and say so if the text looks like
a login wall, cookie notice or error page rather than real content.`;
