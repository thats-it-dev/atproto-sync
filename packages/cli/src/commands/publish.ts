import { boundVaultDir } from '../config';
import { togglePublic, type SyncSummary } from '../session';
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
    const { pds } = await deps.connect(cfg);
    const r = await togglePublic(cfg, args.path, args.makePublic, args.slug, { pds });
    return { ok: true, path: args.path, published: args.makePublic, changed: r.changed, message: r.message, sync: r.summary };
  });
}
