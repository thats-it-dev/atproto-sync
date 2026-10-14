/**
 * <vault>/.atpsync/daemon.json: what the daemon last did, so `status` can
 * report it without IPC. Written atomically (tmp + rename), updates serialized.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { daemonStatePath } from './paths';

export type ConnectionMode = 'subscribed' | 'reconnecting' | 'poll';

export interface DaemonState {
  pid: number;
  host: string;
  startedAt: string;
  connection: ConnectionMode;
  lastSyncAt: string | null;
  lastResult: 'ok' | 'error' | null;
  lastError: string | null;
  lastExit: string | null;
}

export async function readDaemonState(vaultDir: string): Promise<DaemonState | null> {
  try {
    return JSON.parse(await fs.readFile(daemonStatePath(vaultDir), 'utf8')) as DaemonState;
  } catch {
    return null;
  }
}

export class DaemonStateWriter {
  private state: DaemonState;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly vaultDir: string,
    initial: DaemonState
  ) {
    this.state = { ...initial };
  }

  get current(): DaemonState {
    return { ...this.state };
  }

  update(patch: Partial<DaemonState>): Promise<void> {
    this.state = { ...this.state, ...patch };
    const snapshot = JSON.stringify(this.state, null, 2);
    this.chain = this.chain.then(() => this.write(snapshot)).catch(() => {});
    return this.chain;
  }

  private async write(json: string): Promise<void> {
    const file = daemonStatePath(this.vaultDir);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.tmp`, json, 'utf8');
    await fs.rename(`${file}.tmp`, file);
  }
}
