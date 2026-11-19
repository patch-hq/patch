// `patch voice` — voice profiles from the command line (spec/16 § Who is
// speaking, spec/17-cli.md § voice). The Manager uses it to enrol someone when
// asked ("that was Eleanor"): list the voices the devices heard lately, then
// fold one into a person's voiceprint.

import { Command } from 'commander';
import {
  addVoiceSample,
  VoiceProfileAccess,
  type RecentVoice,
  type VoiceProfile,
} from '@patch/wire';
import type { CommonOpts } from './_common.js';
import { emitJson, emitText, getTransport, run } from './_common.js';

const server = (opts: CommonOpts) => getTransport({ ...opts, remote: true });

interface Shared {
  settings: { voiceProfiles: VoiceProfile[] };
}

/**
 * The profiles after enrolling `samples` (voiceprints) for `name`: folded into
 * the person's running mean, or a new person (household unless `access` says
 * otherwise). Matched by name, ignoring case.
 */
export function enrolProfiles(
  profiles: readonly VoiceProfile[],
  name: string,
  samples: readonly number[][],
  opts: { access?: VoiceProfileAccess; context?: string; newId?: string } = {},
): { profiles: VoiceProfile[]; profile: VoiceProfile } {
  const next = [...profiles];
  let i = next.findIndex((p) => p.name.toLowerCase() === name.toLowerCase());
  if (i < 0) {
    next.push({
      id: opts.newId ?? `vp-${Date.now().toString(36)}`,
      name,
      access: opts.access ?? 'household',
      context: opts.context ?? '',
      samples: 0,
    });
    i = next.length - 1;
  }
  let p = next[i]!;
  for (const s of samples) {
    p = { ...p, voiceprint: addVoiceSample(p.voiceprint, p.samples, s), samples: p.samples + 1 };
  }
  if (opts.access !== undefined) p = { ...p, access: opts.access };
  if (opts.context !== undefined) p = { ...p, context: opts.context };
  next[i] = p;
  return { profiles: next, profile: p };
}

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 60
    ? `${s}s ago`
    : s < 3600
      ? `${Math.round(s / 60)}m ago`
      : `${Math.round(s / 3600)}h ago`;
}

export function registerVoiceCommands(program: Command): void {
  const voice = program
    .command('voice')
    .description('Voice profiles: who a voice device recognises');

  voice
    .command('profiles', { isDefault: true })
    .description('The people a voice device recognises')
    .option('--json', 'JSON output')
    .action(async (opts: CommonOpts) => {
      await run(opts, async () => {
        const { settings } = await server(opts).get<Shared>('/api/settings/shared');
        const list = settings.voiceProfiles.map((p) => ({
          id: p.id,
          name: p.name,
          access: p.access,
          samples: p.samples,
          context: p.context,
        }));
        if (opts.json) return emitJson(list);
        if (list.length === 0) emitText('No voice profiles.');
        for (const p of list) emitText(`${p.name} (${p.access}, ${p.samples} samples) ${p.id}`);
      });
    });

  voice
    .command('recent')
    .description('The voices the voice devices heard lately, newest first')
    .option('--json', 'JSON output')
    .action(async (opts: CommonOpts) => {
      await run(opts, async () => {
        const [{ recent }, { settings }] = await Promise.all([
          server(opts).get<{ recent: RecentVoice[] }>('/api/voice/recent-voices'),
          server(opts).get<Shared>('/api/settings/shared'),
        ]);
        const nameOf = (id?: string): string | null =>
          settings.voiceProfiles.find((p) => p.id === id)?.name ?? null;
        const list = recent.map((v) => ({
          id: v.id,
          at: v.at,
          text: v.text,
          seconds: v.seconds,
          heardAs: nameOf(v.matchedProfileId),
          score: v.score,
        }));
        if (opts.json) return emitJson(list);
        if (list.length === 0) emitText('Nothing heard yet.');
        for (const v of list) {
          emitText(
            `${v.id}  ${ago(v.at)}  ${v.seconds}s  ${v.heardAs ?? 'not recognised'} (${v.score})  "${v.text}"`,
          );
        }
      });
    });

  voice
    .command('enrol <name> <recentIds...>')
    .description(
      "Add heard voices to a person's voiceprint (from `patch voice recent`); creates the person if new",
    )
    .option('--access <access>', 'owner, household or guest (a new person defaults to household)')
    .option('--context <text>', 'What Patch should know when they speak')
    .option('--json', 'JSON output')
    .action(
      async (
        name: string,
        recentIds: string[],
        opts: CommonOpts & { access?: string; context?: string },
      ) => {
        await run(opts, async () => {
          const access =
            opts.access === undefined ? undefined : VoiceProfileAccess.parse(opts.access);
          const [{ recent }, { settings }] = await Promise.all([
            server(opts).get<{ recent: RecentVoice[] }>('/api/voice/recent-voices'),
            server(opts).get<Shared>('/api/settings/shared'),
          ]);
          const samples = recentIds.map((id) => {
            const v = recent.find((r) => r.id === id);
            if (!v) throw new Error(`no recent voice ${id} (see \`patch voice recent\`)`);
            return v.voiceprint;
          });
          const { profiles, profile: p } = enrolProfiles(settings.voiceProfiles, name, samples, {
            ...(access !== undefined ? { access } : {}),
            ...(opts.context !== undefined ? { context: opts.context } : {}),
          });
          await server(opts).patch('/api/settings', { voiceProfiles: profiles });
          if (opts.json)
            return emitJson({ id: p.id, name: p.name, access: p.access, samples: p.samples });
          emitText(`${p.name}: ${p.samples} samples (${p.access})`);
        });
      },
    );

  voice
    .command('remove <name>')
    .description('Forget a person')
    .option('--json', 'JSON output')
    .action(async (name: string, opts: CommonOpts) => {
      await run(opts, async () => {
        const { settings } = await server(opts).get<Shared>('/api/settings/shared');
        const next = settings.voiceProfiles.filter(
          (p) => p.name.toLowerCase() !== name.toLowerCase(),
        );
        if (next.length === settings.voiceProfiles.length)
          throw new Error(`no profile named ${name}`);
        await server(opts).patch('/api/settings', { voiceProfiles: next });
        if (opts.json) return emitJson({ removed: name });
        emitText(`Removed ${name}`);
      });
    });
}
