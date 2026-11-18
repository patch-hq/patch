// Agents sometimes draw a table with box-drawing characters (┌─┬─┐ style) as
// plain text. Markdown reflows that into a paragraph and the phone wraps every
// line, leaving broken rules and stray pipes. A run of such lines is wrapped in
// a fence so it renders as a code block — monospace, no wrapping, scrollable.

const BOX = /[─-╿]/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

export function fenceBoxDrawing(text: string): string {
  if (!BOX.test(text)) return text;
  const out: string[] = [];
  let inFence = false;
  let fenceMark = '';
  let inRun = false;
  for (const line of text.split('\n')) {
    const fence = FENCE.exec(line);
    if (inFence) {
      out.push(line);
      if (fence && fence[1]!.startsWith(fenceMark) && line.trim() === fence[1]) inFence = false;
      continue;
    }
    if (fence) {
      if (inRun) {
        out.push('```');
        inRun = false;
      }
      inFence = true;
      fenceMark = fence[1]![0]!.repeat(3);
      out.push(line);
      continue;
    }
    const box = BOX.test(line);
    if (box && !inRun) out.push('```');
    if (!box && inRun) out.push('```');
    inRun = box;
    out.push(line);
  }
  if (inRun) out.push('```');
  return out.join('\n');
}
