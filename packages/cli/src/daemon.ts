/**
 * The background sync process. Owns one SyncScheduler fed by the fs watcher,
 * the subscribeRepos stream and a poll timer. Each run takes the vault lock
 * without waiting (a held lock means "try again shortly"), syncs, and records
 * the outcome in <vault>/.atpsync/daemon.json for `atpsync status`.
 */
import * as os from 'node:os';
import { isIgnored } from '@atproto-sync/core/sync/ignore';
import { boundVaultDir, isConfigured, type AtpsyncConfig } from './config';
import { DaemonStateWriter } from './daemon-state';
import { AtpsyncError } from './errors';
import { watchVault } from './fs-watch';
import { tryAcquireLock } from './lock';
import type { Logger } from './logger';
import { removePid, writePidExclusive } from './pidfile';
import { SyncScheduler, type SchedulerOptions, type Trigger } from './scheduler';
import { isAuthFailure, runSync, type Connect } from './session';
import { RepoSubscription } from './subscription';

export interface DaemonDeps {
  loadConfig(): Promise<AtpsyncConfig>;
  connect: Connect;
  clearConnection(): void;
  log: Logger;
  signals?: Pick<NodeJS.EventEmitter, 'once' | 'off'>;
  /** Log + record lastExit + remove pidfile on uncaught errors (CLI only; never in tests). */
  installCrashHandlers?: boolean;
  debounceMs?: SchedulerOptions['debounceMs'];
  /** Safety-net poll while the event stream is connected (default 15 min). */
  subscribedPollMs?: number;
  subscriptionBackoffMs?: { min: number; max: number };
}

export async function runDaemon(deps: DaemonDeps): Promise<void> {
  const { log } = deps;
  const signals = deps.signals ?? process;
  const cfg0 = await deps.loadConfig();
  if (!isConfigured(cfg0)) {
    throw new AtpsyncError('NOT_CONFIGURED', 'atpsync is not configured. Run `atpsync setup` first.');
  }
  const vaultDir = boundVaultDir(cfg0);
  await writePidExclusive(process.pid);

  const state = new DaemonStateWriter(vaultDir, {
    pid: process.pid,
    host: os.hostname(),
    startedAt: new Date().toISOString(),
    connection: cfg0.remote === 'subscribe' ? 'reconnecting' : 'poll',
    lastSyncAt: null,
    lastResult: null,
    lastError: null,
    lastExit: null,
  });
  await state.update({});

  if (deps.installCrashHandlers) {
    const fatal = (err: unknown) => {
      const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
      log.error(`fatal: ${msg}`);
      void state
        .update({ lastExit: `crashed: ${err instanceof Error ? err.message : String(err)}` })
        .finally(() => removePid(process.pid).finally(() => process.exit(1)));
    };
    process.once('uncaughtException', fatal);
    process.once('unhandledRejection', fatal);
  }

  const slowPollMs = Math.max(1, cfg0.syncIntervalMinutes) * 60_000;
  const subscribedPollMs = deps.subscribedPollMs ?? 15 * 60_000;

  const run = async (reason: Trigger): Promise<'ok' | 'busy'> => {
    const lock = await tryAcquireLock(vaultDir);
    if (!lock) {
      log.info(`sync (${reason}) deferred: vault locked by another atpsync process`);
      return 'busy';
    }
    try {
      const cfg = await deps.loadConfig();
      const { pds } = await deps.connect(cfg);
      const s = await runSync(cfg, { pds, vaultDir });
      log.info(`sync (${reason}): ${s.opsExecuted} operation(s)`);
      for (const w of s.warnings) log.warn(w);
      await state.update({ lastSyncAt: s.lastSyncAt, lastResult: 'ok', lastError: null });
    } catch (err) {
      if (isAuthFailure(err) || (err instanceof AtpsyncError && err.code === 'AUTH')) deps.clearConnection();
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`sync (${reason}) failed: ${msg}`);
      await state.update({ lastResult: 'error', lastError: msg });
    } finally {
      await lock.release();
    }
    return 'ok';
  };

  const scheduler = new SyncScheduler(run, {
    debounceMs: deps.debounceMs,
    onError: (err) => log.error(`scheduler: ${(err as Error).message}`),
  });

  const unwatch = watchVault(
    vaultDir,
    (rel) => isIgnored(rel, cfg0.ignorePatterns),
    () => scheduler.trigger('fs'),
    (m) => log.warn(m)
  );

  let subscription: RepoSubscription | null = null;
  if (cfg0.remote === 'subscribe') {
    subscription = new RepoSubscription({
      resolveTarget: async () => {
        const c = await deps.connect(await deps.loadConfig());
        return { pdsUrl: c.pdsUrl, did: c.did };
      },
      onRelevant: () => scheduler.trigger('remote'),
      onState: (s) => {
        void state.update({ connection: s });
        scheduler.setPollInterval(s === 'subscribed' ? subscribedPollMs : slowPollMs);
        if (s === 'subscribed') {
          log.info('subscribed to PDS event stream');
          scheduler.trigger('startup'); // cover anything missed while disconnected
        }
      },
      log: (m) => log.warn(m),
      minBackoffMs: deps.subscriptionBackoffMs?.min,
      maxBackoffMs: deps.subscriptionBackoffMs?.max,
    });
    subscription.start();
  }

  scheduler.setPollInterval(slowPollMs);
  scheduler.trigger('startup');
  const rotate = setInterval(() => log.rotateIfNeeded?.(), 60 * 60_000);
  rotate.unref();
  log.info(`daemon started (pid ${process.pid}) for ${vaultDir}`);

  await new Promise<void>((resolve) => {
    const onSignal = (sig: string) => {
      signals.off('SIGTERM', onSignal);
      signals.off('SIGINT', onSignal);
      log.info(`received ${sig}, shutting down`);
      resolve();
    };
    signals.once('SIGTERM', onSignal);
    signals.once('SIGINT', onSignal);
  });

  clearInterval(rotate);
  subscription?.stop();
  unwatch();
  await scheduler.stop(); // lets an in-flight sync finish and release the lock
  await state.update({ lastExit: `stopped at ${new Date().toISOString()}` });
  await removePid(process.pid);
  log.info('daemon stopped');
}
