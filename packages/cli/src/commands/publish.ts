import { boundVaultDir } from '../config';
import { flipPublicFlag, runSync, withAuthRetry, type SyncSummary } from '../session';
import { requireConfig, withVaultLock, type CommandDeps } from './context';

export interface PublishResult {
  ok: true;
  path: string;
  published: boolean;
  changed: boolean;
  message: string;
  sync: SyncSummary | null;
}

export async function publishCommand(
  deps: CommandDeps,
  args: { path: string; makePublic: boolean; slug?: string }
): Promise<PublishResult> {
  const cfg = await requireConfig(deps);
  return withVaultLock(boundVaultDir(cfg), deps.lock, async () => {
    // Sign in before touching the note, so a bad login leaves it unchanged.
    const first = await deps.connect(cfg);
    const flip = await flipPublicFlag(cfg, args.path, args.makePublic, args.slug);
    // Only the sync is retried on an auth failure: the frontmatter flip already happened.
    const sync = flip.changed
      ? await withAuthRetry(async (n) => runSync(cfg, { pds: n === 0 ? first.pds : (await deps.connect(cfg)).pds }))
      : null;
    return { ok: true, path: args.path, published: args.makePublic, changed: flip.changed, message: flip.message, sync };
  });
}
