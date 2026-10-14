import { saveConfig } from '../config';
import { clearConnectionCache } from '../session';
import type { CommandDeps } from './context';

/** Stop the daemon, then forget the app password and cached master key. The vault binding stays. */
export async function logoutCommand(
  deps: CommandDeps,
  stop: () => Promise<{ wasRunning: boolean }>
): Promise<{ ok: true; stoppedDaemon: boolean }> {
  const { wasRunning } = await stop();
  const cfg = await deps.loadConfig();
  await saveConfig({ ...cfg, appPassword: '', masterKeyB64: '' });
  clearConnectionCache();
  return { ok: true, stoppedDaemon: wasRunning };
}
