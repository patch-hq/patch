// A stand-in for `claude` speaking just enough stream-json for the durable
// turn tests: answers `initialize`, says "a1" on the prompt, then — once the
// file `go` appears in its cwd — says "a2" and finishes with a result.
import { existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'control_request' && m.request.subtype === 'initialize') {
    say({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
  } else if (m.type === 'user') {
    writeFileSync('prompted', '1');
    say({ type: 'assistant', text: 'a1' });
    const timer = setInterval(() => {
      if (!existsSync('go')) return;
      clearInterval(timer);
      say({ type: 'assistant', text: 'a2' });
      say({ type: 'result', text: 'done' });
    }, 20);
  }
});
rl.on('close', () => process.exit(0));
