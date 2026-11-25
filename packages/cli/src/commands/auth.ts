// `patch auth *` — sign-in by approval, bootstrap and revoke.
//
// `login` asks the server for a sign-in request (no bearer needed, so it works
// with an expired credential), a signed-in surface approves it and shows a
// six-digit code, and typing that code here redeems a new credential.

import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { signInByApproval } from '../signin.js';
import type { CommonOpts } from './_common.js';
import { emitJson, emitText, getTransport, run } from './_common.js';
import { credentialFilePath, identityFilePath, loadConfig } from '../config.js';
import {
  ensureConfigDir,
  loadOrCreateIdentity,
  readIdentity,
  writeCredential,
  writeIdentity,
} from '../auth.js';
import { RestClient } from '../transport/rest.js';
import { generateUserKeypair, verifySurfaceCredential } from '@patch/auth';

export function registerAuthCommands(program: Command): void {
  const auth = program.command('auth').description('Identity / pairing ops');

  auth
    .command('login')
    .description('Sign this terminal in by approving it from a signed-in surface')
    .option('--credential <jwt>', 'Skip pairing dance: write this credential as the JWT')
    .option('--json', 'JSON output')
    .action(async (opts: CommonOpts & { credential?: string }) => {
      await run(opts, async () => {
        ensureConfigDir();

        // Test-friendly bypass: caller already has a credential.
        if (opts.credential) {
          const kp = loadOrCreateIdentity();
          writeIdentity(kp);
          // Verify the JWT signs against our local identity, and `sub` matches.
          let claims;
          try {
            claims = await verifySurfaceCredential(opts.credential, {
              userPublicKey: kp.publicKey,
            });
          } catch (e) {
            throw new Error(
              `--credential failed to verify against local identity (${identityFilePath()}): ${(e as Error).message}`,
            );
          }
          if (claims.sub !== kp.publicKey) {
            throw new Error(
              `--credential sub (${claims.sub}) does not match local accountId (${kp.publicKey})`,
            );
          }
          writeCredential(opts.credential);
          if (opts.json)
            emitJson({
              ok: true,
              identity: identityFilePath(),
              accountId: kp.publicKey,
              surfaceId: claims.surface_id,
              sub: claims.sub,
              expiresAt: claims.exp,
            });
          else
            emitText(
              `paired (test bypass) — accountId=${kp.publicKey} surfaceId=${claims.surface_id}`,
            );
          return;
        }

        loadOrCreateIdentity();
        const config = loadConfig();
        const rest = new RestClient({ serverUrl: config.serverUrl, bearer: null });
        const out = await signInByApproval({
          rest,
          label: 'patch-cli',
          now: () => Date.now(),
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          onRequested: (r) => {
            if (!opts.json)
              emitText(
                `Approve "patch-cli" on a signed-in Patch surface (expires ${new Date(r.expiresAt).toISOString()}), then type the six-digit code it shows.`,
              );
          },
          readCode: async () => {
            const rl = createInterface({ input: process.stdin, output: process.stderr });
            try {
              return await rl.question('Code: ');
            } finally {
              rl.close();
            }
          },
        });
        writeCredential(out.credential);
        if (opts.json)
          emitJson({ ok: true, surfaceId: out.surfaceId, credential: credentialFilePath() });
        else emitText(`signed in — surfaceId=${out.surfaceId}`);
      });
    });

  auth
    .command('bootstrap')
    .description('First-run: create account from a fresh keypair, mint a CLI surface JWT')
    .option('--server <url>', 'Override server URL (else config / PATCH_SERVER_URL)')
    .option('--label <label>', 'Surface label', 'patch-cli')
    .option(
      '--surface-kind <kind>',
      'Surface kind to mint (terminal | web | desktop | mobile | voice-device | web-dev | desktop-dev | mobile-dev)',
      'terminal',
    )
    .option('--json', 'JSON output')
    .action(async (opts: CommonOpts & { server?: string; label: string; surfaceKind: string }) => {
      await run(opts, async () => {
        ensureConfigDir();
        // 1. Generate or reuse identity.
        let kp;
        try {
          kp = readIdentity();
        } catch {
          kp = generateUserKeypair();
          writeIdentity(kp);
        }

        // 2. Bootstrap the account on the server.
        //
        // The SERVER owns the account keypair (it calls generateUserKeypair()
        // itself) and mints the first surface credential. This used to send
        // `{userPublicKey}` from a locally-generated account key and then mint
        // its own JWT — an older contract the server no longer speaks, so
        // bootstrap failed outright with `{"error":"invalid body"}`. All this
        // command supplies now is THIS device's public key.
        const config = loadConfig();
        const serverUrl = opts.server ?? config.serverUrl;
        const rest = new RestClient({ serverUrl, bearer: null });
        const resp = await rest.post<{
          account: { accountId: string; userPublicKey: string; createdAt: number };
          credential: string;
          surfaceId: string;
        }>('/api/auth/account', {
          clientType: 'surface-cli',
          devicePublicKey: kp.publicKey,
          label: opts.label,
        });
        const jwt = resp.credential;

        // 3. Verify the credential the server gave us actually works, against
        // the account key the SERVER holds — not one we assumed.
        const claims = await verifySurfaceCredential(jwt, {
          userPublicKey: resp.account.userPublicKey,
        });
        const verifyClient = new RestClient({ serverUrl, bearer: jwt });
        try {
          await verifyClient.get<unknown>('/api/auth/me');
        } catch (e) {
          throw new Error(
            'bootstrap: the server rejected the credential it just issued. ' +
              'Aborting (NO FALLBACK). Underlying: ' +
              (e as Error).message,
          );
        }

        // 6. Persist.
        writeCredential(jwt);

        const out = {
          ok: true,
          // The SERVER's account id, not this device's public key — they are
          // different things, and reporting the device key here made bootstrap
          // print an "accountId" that matched nothing on the server.
          accountId: resp.account.accountId,
          surfaceId: claims.surface_id,
          expiresAt: claims.exp,
          identity: identityFilePath(),
          credential: credentialFilePath(),
          serverUrl,
          bootstrapped: true,
        };
        if (opts.json) emitJson(out);
        else
          emitText(
            `bootstrapped accountId=${out.accountId} surfaceId=${out.surfaceId} server=${serverUrl}`,
          );
      });
    });

  auth
    .command('revoke <id>')
    .description('Revoke a paired surface (alias of `surfaces revoke`)')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: CommonOpts) => {
      await run(opts, async () => {
        const t = getTransport({ ...opts, remote: true });
        const res = await t.post<{ ok: true }>('/api/auth/revoke', { id });
        if (opts.json) emitJson(res);
        else emitText('revoked');
      });
    });
}
