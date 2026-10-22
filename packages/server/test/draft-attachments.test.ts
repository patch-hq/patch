// Draft attachments (spec/14 & spec/15 § Composer → Attachments): attaching a file to an unsent draft (an existing chat's
// composer, or a not-yet-spawned new-chat draft) uploads it straight away and
// registers it on the server-held draft, so every surface shows the same
// chip. Exercises the real HTTP round-trip for both draft kinds: attach,
// remove-before-send, detach-on-send, promote-to-real-chat (new-chat drafts
// only), and cleanup on discard/chat-delete.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import type { WireEvent } from '@patch/wire';
import { WireTestClient } from '@patch/wire/test-client';
import type { AddressInfo } from 'node:net';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BOUNDARY = '----patchdraftattachboundary';

function multipart(
  filename: string,
  contentType: string,
  bytes: Buffer,
): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const payload = Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` } };
}

describe('draft attachments', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-draft-attach-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function makeApp(opts: { hostOk?: boolean } = {}) {
    const hostOk = opts.hostOk ?? true;
    const user = generateUserKeypair(() => new Uint8Array(32).fill(17));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-web-1',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: 1,
    });
    const hostLink = new InProcessHostLink();
    const storeRequests: Extract<WireEvent, { type: 'patch.attachment.store_request' }>[] = [];
    const deleteRequests: Extract<WireEvent, { type: 'patch.attachment.delete_request' }>[] = [];
    const origSend = hostLink.send.bind(hostLink);
    hostLink.send = (surfaceId: string, event: WireEvent): void => {
      origSend(surfaceId, event);
      if (event.type === 'patch.attachment.store_request') {
        storeRequests.push(event);
        hostLink.emit(
          hostOk
            ? {
                type: 'patch.attachment.store_response',
                requestId: event.requestId,
                ok: true,
                path: `/tmp/chat/.patch/attachments/${event.id}-${event.name}`,
              }
            : {
                type: 'patch.attachment.store_response',
                requestId: event.requestId,
                ok: false,
                error: { code: 'internal', message: 'disk full' },
              },
        );
      }
      if (event.type === 'patch.attachment.delete_request') {
        deleteRequests.push(event);
        hostLink.emit({
          type: 'patch.attachment.delete_response',
          requestId: event.requestId,
          ok: true,
        });
      }
    };
    const built = await buildAll({ logger: false, registry, hostLink });
    hostLink.emit({ type: 'chat.spawned', hostId: 'd1', chatId: 'c1', folder: '/tmp/chat' });
    const credential = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-web-1',
      surfaceKind: 'web',
      label: 'browser',
    });
    return {
      built,
      credential,
      registry,
      hostLink,
      storeRequests,
      deleteRequests,
      attachmentsDir: join(dir, 'attachments'),
      newChatDraftAttachmentsDir: join(dir, 'new-chat-draft-attachments'),
    };
  }

  // ---- composer drafts (existing chat) ----

  describe('composer draft attachments', () => {
    it('attaching registers the ref onto the composer draft', async () => {
      const { built, credential } = await makeApp();
      try {
        const mp = multipart('shot.png', 'image/png', PNG);
        const res = await built.app.inject({
          method: 'POST',
          url: '/api/chats/c1/attachment',
          headers: { authorization: `Bearer ${credential}`, ...mp.headers },
          payload: mp.payload,
        });
        expect(res.statusCode).toBe(200);
        const { ref } = res.json() as { ref: { id: string } };
        expect(built.composerAttachments.get('c1')).toEqual([
          {
            id: ref.id,
            name: 'shot.png',
            mimeType: 'image/png',
            kind: 'image',
            url: `/api/chats/c1/attachment/${ref.id}`,
          },
        ]);
      } finally {
        await built.app.close();
      }
    });

    it('attaching with no text typed yet holds the file without inventing a text draft', async () => {
      const { built, credential } = await makeApp();
      try {
        expect(built.composerDrafts.get('c1')).toBeUndefined();
        const mp = multipart('shot.png', 'image/png', PNG);
        await built.app.inject({
          method: 'POST',
          url: '/api/chats/c1/attachment',
          headers: { authorization: `Bearer ${credential}`, ...mp.headers },
          payload: mp.payload,
        });
        expect(built.composerDrafts.get('c1')).toBeUndefined();
        expect(built.composerAttachments.get('c1')).toHaveLength(1);
      } finally {
        await built.app.close();
      }
    });

    it('a second attach appends without disturbing the first', async () => {
      const { built, credential } = await makeApp();
      try {
        const mp1 = multipart('one.png', 'image/png', PNG);
        await built.app.inject({
          method: 'POST',
          url: '/api/chats/c1/attachment',
          headers: { authorization: `Bearer ${credential}`, ...mp1.headers },
          payload: mp1.payload,
        });
        const mp2 = multipart('two.png', 'image/png', PNG);
        await built.app.inject({
          method: 'POST',
          url: '/api/chats/c1/attachment',
          headers: { authorization: `Bearer ${credential}`, ...mp2.headers },
          payload: mp2.payload,
        });
        const names = built.composerAttachments.get('c1').map((a) => a.name);
        expect(names).toEqual(['one.png', 'two.png']);
      } finally {
        await built.app.close();
      }
    });

    it('emptying the composer text keeps the attachment chip alive', async () => {
      const { built, credential } = await makeApp();
      try {
        built.composerDrafts.set('c1', 'hello');
        const mp = multipart('shot.png', 'image/png', PNG);
        await built.app.inject({
          method: 'POST',
          url: '/api/chats/c1/attachment',
          headers: { authorization: `Bearer ${credential}`, ...mp.headers },
          payload: mp.payload,
        });
        built.composerDrafts.set('c1', '');
        expect(built.composerAttachments.get('c1')).toHaveLength(1);
      } finally {
        await built.app.close();
      }
    });

    it('DELETE removes a pending attachment from the draft, disk, and asks the host to delete its copy', async () => {
      const { built, credential, attachmentsDir, deleteRequests } = await makeApp();
      try {
        const mp = multipart('shot.png', 'image/png', PNG);
        const upload = await built.app.inject({
          method: 'POST',
          url: '/api/chats/c1/attachment',
          headers: { authorization: `Bearer ${credential}`, ...mp.headers },
          payload: mp.payload,
        });
        const { id } = (upload.json() as { ref: { id: string } }).ref;
        expect(existsSync(join(attachmentsDir, 'c1', id))).toBe(true);

        const del = await built.app.inject({
          method: 'DELETE',
          url: `/api/chats/c1/attachment/${id}`,
          headers: { authorization: `Bearer ${credential}` },
        });
        expect(del.statusCode).toBe(200);
        expect(built.composerAttachments.get('c1')).toEqual([]);
        expect(existsSync(join(attachmentsDir, 'c1', id))).toBe(false);
        expect(deleteRequests).toHaveLength(1);
        expect(deleteRequests[0]).toMatchObject({ chatId: 'c1', id, name: 'shot.png' });
      } finally {
        await built.app.close();
      }
    });

    it('DELETE 404s for an id not currently in the draft (never a sent message)', async () => {
      const { built, credential } = await makeApp();
      try {
        const res = await built.app.inject({
          method: 'DELETE',
          url: '/api/chats/c1/attachment/NEVERUPLOADED',
          headers: { authorization: `Bearer ${credential}` },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await built.app.close();
      }
    });

    it('DELETE requires auth', async () => {
      const { built } = await makeApp();
      try {
        const res = await built.app.inject({ method: 'DELETE', url: '/api/chats/c1/attachment/x' });
        expect(res.statusCode).toBe(401);
      } finally {
        await built.app.close();
      }
    });

    it('detach clears draft bookkeeping WITHOUT deleting the files (they now belong to the sent message)', async () => {
      const { built, credential, attachmentsDir } = await makeApp();
      try {
        const mp = multipart('shot.png', 'image/png', PNG);
        const upload = await built.app.inject({
          method: 'POST',
          url: '/api/chats/c1/attachment',
          headers: { authorization: `Bearer ${credential}`, ...mp.headers },
          payload: mp.payload,
        });
        const { id } = (upload.json() as { ref: { id: string } }).ref;

        const detach = await built.app.inject({
          method: 'POST',
          url: '/api/chats/c1/attachments/detach',
          headers: { authorization: `Bearer ${credential}` },
        });
        expect(detach.statusCode).toBe(200);
        expect(built.composerAttachments.get('c1')).toEqual([]);
        // The bytes are untouched — the sent message references the same id.
        expect(existsSync(join(attachmentsDir, 'c1', id))).toBe(true);
        const get = await built.app.inject({
          method: 'GET',
          url: `/api/chats/c1/attachment/${id}`,
        });
        expect(get.statusCode).toBe(200);
      } finally {
        await built.app.close();
      }
    });

    it('detach with ids releases only those, so a file attached after Send stays on the draft', async () => {
      const { built, credential } = await makeApp();
      try {
        const upload = async (name: string): Promise<string> => {
          const mp = multipart(name, 'image/png', PNG);
          const res = await built.app.inject({
            method: 'POST',
            url: '/api/chats/c1/attachment',
            headers: { authorization: `Bearer ${credential}`, ...mp.headers },
            payload: mp.payload,
          });
          return (res.json() as { ref: { id: string } }).ref.id;
        };
        const sent = await upload('sent.png');
        const later = await upload('later.png');

        const detach = await built.app.inject({
          method: 'POST',
          url: '/api/chats/c1/attachments/detach',
          headers: { authorization: `Bearer ${credential}` },
          payload: { ids: [sent] },
        });
        expect(detach.statusCode).toBe(200);
        expect(built.composerAttachments.get('c1').map((a) => a.id)).toEqual([later]);
      } finally {
        await built.app.close();
      }
    });

    it('detach with text still present clears only the attachments, keeping the text', async () => {
      const { built, credential } = await makeApp();
      try {
        built.composerDrafts.set('c1', 'still typing');
        const mp = multipart('shot.png', 'image/png', PNG);
        await built.app.inject({
          method: 'POST',
          url: '/api/chats/c1/attachment',
          headers: { authorization: `Bearer ${credential}`, ...mp.headers },
          payload: mp.payload,
        });
        await built.app.inject({
          method: 'POST',
          url: '/api/chats/c1/attachments/detach',
          headers: { authorization: `Bearer ${credential}` },
        });
        expect(built.composerAttachments.get('c1')).toEqual([]);
        expect(built.composerDrafts.get('c1')?.text).toBe('still typing');
      } finally {
        await built.app.close();
      }
    });

    it('chat delete frees every still-draft attachment — server files, host copy, and bookkeeping', async () => {
      const { built, credential, attachmentsDir, deleteRequests } = await makeApp();
      try {
        const mp = multipart('shot.png', 'image/png', PNG);
        const upload = await built.app.inject({
          method: 'POST',
          url: '/api/chats/c1/attachment',
          headers: { authorization: `Bearer ${credential}`, ...mp.headers },
          payload: mp.payload,
        });
        const { id } = (upload.json() as { ref: { id: string } }).ref;

        const del = await built.app.inject({
          method: 'DELETE',
          url: '/api/chats/c1',
          headers: { authorization: `Bearer ${credential}` },
        });
        expect(del.statusCode).toBe(200);
        expect(built.composerDrafts.get('c1')).toBeUndefined();
        expect(built.composerAttachments.get('c1')).toEqual([]);
        expect(existsSync(join(attachmentsDir, 'c1', id))).toBe(false);
        expect(deleteRequests.some((r) => r.id === id)).toBe(true);
      } finally {
        await built.app.close();
      }
    });

    it('a composer_draft.clear over the wire clears the text only — the attachment stays', async () => {
      const { built, credential, attachmentsDir } = await makeApp();
      try {
        const mp = multipart('shot.png', 'image/png', PNG);
        const upload = await built.app.inject({
          method: 'POST',
          url: '/api/chats/c1/attachment',
          headers: { authorization: `Bearer ${credential}`, ...mp.headers },
          payload: mp.payload,
        });
        const { id } = (upload.json() as { ref: { id: string } }).ref;

        await built.app.listen({ port: 0, host: '127.0.0.1' });
        const addr = built.app.server.address() as AddressInfo;
        const client = new WireTestClient({
          url: `ws://127.0.0.1:${addr.port}/ws`,
          auth: credential,
        });
        const online = client.waitFor('auth.ok');
        await client.connect();
        await online;
        try {
          client.send({ type: 'composer_draft.clear', chatId: 'c1' });
          // Give the server a beat to process the frame.
          await new Promise((r) => setTimeout(r, 100));
          expect(built.composerDrafts.get('c1')).toBeUndefined();
          expect(built.composerAttachments.get('c1')).toHaveLength(1);
          expect(existsSync(join(attachmentsDir, 'c1', id))).toBe(true);
        } finally {
          await client.close();
        }
      } finally {
        await built.app.close();
      }
    });
  });

  // ---- new-chat drafts (no chat yet) ----

  describe('new-chat draft attachments', () => {
    it('attaching stores server-side ONLY — no host round-trip yet', async () => {
      const { built, credential, storeRequests } = await makeApp();
      try {
        const mp = multipart('shot.png', 'image/png', PNG);
        const res = await built.app.inject({
          method: 'POST',
          url: '/api/new-chat-drafts/draft-1/attachment',
          headers: { authorization: `Bearer ${credential}`, ...mp.headers },
          payload: mp.payload,
        });
        expect(res.statusCode).toBe(200);
        const { ref } = res.json() as { ref: { id: string; url: string } };
        expect(ref.url).toBe(`/api/new-chat-drafts/draft-1/attachment/${ref.id}`);
        expect(built.newChatAttachments.get('draft-1')).toHaveLength(1);
        expect(storeRequests).toHaveLength(0);

        // Served back from the draft-scoped route.
        const get = await built.app.inject({ method: 'GET', url: ref.url });
        expect(get.statusCode).toBe(200);
        expect(get.rawPayload.equals(PNG)).toBe(true);
      } finally {
        await built.app.close();
      }
    });

    it('DELETE removes it before it was ever sent, no host involved', async () => {
      const { built, credential, newChatDraftAttachmentsDir, deleteRequests } = await makeApp();
      try {
        const mp = multipart('shot.png', 'image/png', PNG);
        const upload = await built.app.inject({
          method: 'POST',
          url: '/api/new-chat-drafts/draft-1/attachment',
          headers: { authorization: `Bearer ${credential}`, ...mp.headers },
          payload: mp.payload,
        });
        const { id } = (upload.json() as { ref: { id: string } }).ref;
        const del = await built.app.inject({
          method: 'DELETE',
          url: `/api/new-chat-drafts/draft-1/attachment/${id}`,
          headers: { authorization: `Bearer ${credential}` },
        });
        expect(del.statusCode).toBe(200);
        expect(built.newChatAttachments.get('draft-1')).toEqual([]);
        expect(existsSync(join(newChatDraftAttachmentsDir, 'draft-1', id))).toBe(false);
        expect(deleteRequests).toHaveLength(0);
      } finally {
        await built.app.close();
      }
    });

    it('promote moves the bytes into the real chat dir and does the ONE host hand-off', async () => {
      const { built, credential, storeRequests, attachmentsDir, newChatDraftAttachmentsDir } =
        await makeApp();
      try {
        const mp = multipart('shot.png', 'image/png', PNG);
        const upload = await built.app.inject({
          method: 'POST',
          url: '/api/new-chat-drafts/draft-1/attachment',
          headers: { authorization: `Bearer ${credential}`, ...mp.headers },
          payload: mp.payload,
        });
        const { id } = (upload.json() as { ref: { id: string } }).ref;

        const promote = await built.app.inject({
          method: 'POST',
          url: '/api/new-chat-drafts/draft-1/promote',
          headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
          payload: JSON.stringify({ chatId: 'c1' }),
        });
        expect(promote.statusCode).toBe(200);
        const { refs } = promote.json() as { refs: { id: string; name: string }[] };
        expect(refs).toEqual([{ id, name: 'shot.png', mimeType: 'image/png', kind: 'image' }]);

        // Host got its ONE round-trip, and only that one.
        expect(storeRequests).toHaveLength(1);
        expect(storeRequests[0]).toMatchObject({ chatId: 'c1', id });

        // Bytes moved (not copied) — draft's copy is gone, chat's copy exists.
        expect(existsSync(join(newChatDraftAttachmentsDir, 'draft-1', id))).toBe(false);
        expect(existsSync(join(attachmentsDir, 'c1', id))).toBe(true);

        // Now servable from the ordinary per-chat route.
        const get = await built.app.inject({
          method: 'GET',
          url: `/api/chats/c1/attachment/${id}`,
        });
        expect(get.statusCode).toBe(200);
        expect(get.rawPayload.equals(PNG)).toBe(true);

        // Draft bookkeeping cleared (bytes already moved — nothing left to free).
        expect(built.newChatAttachments.get('draft-1')).toEqual([]);
      } finally {
        await built.app.close();
      }
    });

    it('promote with an unknown chatId 404s', async () => {
      const { built, credential } = await makeApp();
      try {
        const res = await built.app.inject({
          method: 'POST',
          url: '/api/new-chat-drafts/draft-1/promote',
          headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
          payload: JSON.stringify({ chatId: 'NOPE' }),
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await built.app.close();
      }
    });
  });

  // ---- fan-out + cold start ----

  describe('wire', () => {
    it('an upload fans attachments_changed out to every connected surface, and a later connect gets the snapshot', async () => {
      const { built, credential } = await makeApp();
      try {
        await built.app.listen({ port: 0, host: '127.0.0.1' });
        const addr = built.app.server.address() as AddressInfo;
        const url = `ws://127.0.0.1:${addr.port}/ws`;
        const first = new WireTestClient({ url, auth: credential });
        const online = first.waitFor('auth.ok');
        await first.connect();
        await online;
        try {
          const changed = first.waitFor('composer_draft.attachments_changed');
          const mp = multipart('shot.png', 'image/png', PNG);
          const res = await built.app.inject({
            method: 'POST',
            url: '/api/chats/c1/attachment',
            headers: { authorization: `Bearer ${credential}`, ...mp.headers },
            payload: mp.payload,
          });
          const { ref } = res.json() as { ref: { id: string } };
          const ev = await changed;
          expect(ev).toMatchObject({ chatId: 'c1', attachments: [{ id: ref.id }] });

          const second = new WireTestClient({ url, auth: credential });
          const list = second.waitFor('composer_draft.attachments_list');
          await second.connect();
          try {
            expect(await list).toMatchObject({
              drafts: [{ chatId: 'c1', attachments: [{ id: ref.id }] }],
            });
          } finally {
            await second.close();
          }

          const emptied = first.waitFor('composer_draft.attachments_changed');
          await built.app.inject({
            method: 'POST',
            url: '/api/chats/c1/attachments/detach',
            headers: { authorization: `Bearer ${credential}` },
          });
          expect(await emptied).toMatchObject({ chatId: 'c1', attachments: [] });
        } finally {
          await first.close();
        }
      } finally {
        await built.app.close();
      }
    });

    it('promote fails loudly when a held attachment lost its bytes', async () => {
      const { built, credential, newChatDraftAttachmentsDir } = await makeApp();
      try {
        const mp = multipart('shot.png', 'image/png', PNG);
        const upload = await built.app.inject({
          method: 'POST',
          url: '/api/new-chat-drafts/draft-1/attachment',
          headers: { authorization: `Bearer ${credential}`, ...mp.headers },
          payload: mp.payload,
        });
        const { id } = (upload.json() as { ref: { id: string } }).ref;
        rmSync(join(newChatDraftAttachmentsDir, 'draft-1', id));
        const promote = await built.app.inject({
          method: 'POST',
          url: '/api/new-chat-drafts/draft-1/promote',
          headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
          payload: JSON.stringify({ chatId: 'c1' }),
        });
        expect(promote.statusCode).toBe(500);
        expect(promote.json()).toMatchObject({ error: 'attachment_missing', id });
        expect(built.newChatAttachments.get('draft-1')).toHaveLength(1);
      } finally {
        await built.app.close();
      }
    });
  });
});
