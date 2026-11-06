import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UdsClient } from '../src/transport/uds.js';

describe('UdsClient.stream', () => {
  it('reads ndjson lines, authenticates with the local key, and stops when told', async () => {
    const sock = join(mkdtempSync(join(tmpdir(), 'patch-uds-')), 's.sock');
    let auth = '';
    const srv = createServer((req, res) => {
      auth = String(req.headers.authorization);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write('{"type":"a"}\n{"type":"b"}\n{"ty');
      setTimeout(() => res.write('pe":"c"}\n'), 20);
    });
    await new Promise<void>((r) => srv.listen(sock, r));
    const got: unknown[] = [];
    await new UdsClient({ socketPath: sock, localKey: 'k' }).stream('/server-events', (l) => {
      got.push(l);
      return got.length < 3;
    });
    srv.closeAllConnections();
    srv.close();
    assert.equal(auth, 'Bearer k');
    assert.deepEqual(got, [{ type: 'a' }, { type: 'b' }, { type: 'c' }]);
  });

  it('rejects a non-2xx answer with the daemon message', async () => {
    const sock = join(mkdtempSync(join(tmpdir(), 'patch-uds-')), 's.sock');
    const srv = createServer((_q, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{"error":"link_offline","message":"link is offline"}');
    });
    await new Promise<void>((r) => srv.listen(sock, r));
    await assert.rejects(
      new UdsClient({ socketPath: sock, localKey: 'k' }).stream('/server-events', () => {}),
      /link is offline/,
    );
    srv.close();
  });
});
