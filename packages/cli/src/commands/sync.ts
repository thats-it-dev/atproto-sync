import { boundVaultDir } from '../config';
import { runSync, withAuthRetry, type SyncSummary } from '../session';
import { requireConfig, withVaultLock, type CommandDeps } from './context';

export async function syncCommand(deps: CommandDeps): Promise<SyncSummary> {
  const cfg = await requireConfig(deps);
  return withVaultLock(boundVaultDir(cfg), deps.lock, () =>
    withAuthRetry(async () => {
      const { pds } = await deps.connect(cfg);
      return runSync(cfg, { pds });
    })
  );
}
