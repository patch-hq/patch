// Keeps Patch findable in Spotlight. Auto-updates (Squirrel/ShipIt) swap the
// bundle in /Applications in place, and Spotlight does not reliably re-index
// the replacement, so Patch drops out of search. On every packaged launch we
// ask Spotlight whether it knows the app and, if not, re-register and import
// the bundle. Failures are logged loudly, never swallowed.

export interface SpotlightDeps {
  platform: string;
  isPackaged: boolean;
  bundlePath: string;
  run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  log(message: string): void;
  error(message: string): void;
}

export const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework' +
  '/Support/lsregister';

export async function ensureSpotlightIndexed(
  deps: SpotlightDeps,
): Promise<'skipped' | 'indexed' | 'repaired'> {
  if (deps.platform !== 'darwin' || !deps.isPackaged) return 'skipped';
  const query = await deps.run('mdfind', [
    '-onlyin',
    '/Applications',
    'kMDItemKind == Application && kMDItemDisplayName == Patch',
  ]);
  if (query.code === 0 && query.stdout.split('\n').some((l) => l.trim() === deps.bundlePath)) {
    return 'indexed';
  }
  deps.log(`[spotlight] ${deps.bundlePath} not indexed — re-registering`);
  for (const [cmd, args] of [
    [LSREGISTER, ['-f', deps.bundlePath]],
    ['mdimport', [deps.bundlePath]],
  ] as const) {
    const r = await deps.run(cmd, [...args]);
    if (r.code !== 0) {
      deps.error(`[spotlight] ${cmd} failed (exit ${r.code}): ${r.stderr.trim()}`);
      throw new Error(`spotlight re-register failed: ${cmd}`);
    }
  }
  return 'repaired';
}
