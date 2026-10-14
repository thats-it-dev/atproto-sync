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
import { isAuthError, isAuthFailure, runSync, sha256, type Connect, type Connection } from './session';
import { RepoSubscription, type SubscriptionState } from './subscription';

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
  /** Poll interval while not subscribed (default: config syncIntervalMinutes; tests only). */
  pollMs?: number;
}

/** Identifies the credentials a sign-in was attempted with, without keeping the password. */
const credentialFingerprint = (cfg: AtpsyncConfig): string => sha256(`${cfg.identifier}\0${cfg.appPassword}`);

/** What this daemon is bound to; a change means it must be restarted (setup picked another vault or account). */
function bindingOf(cfg: AtpsyncConfig): string {
  let vaultDir = '';
  try {
    vaultDir = boundVaultDir(cfg);
  } catch {
    // unbound: compares unequal to the startup binding
  }
  return JSON.stringify([cfg.identifier, cfg.vaultRkey, vaultDir, cfg.masterKeyB64]);
}

export async function runDaemon(deps: DaemonDeps): Promise<void> {
  const { log } = deps;
  const signals = deps.signals ?? process;
  const cfg0 = await deps.loadConfig();
  if (!isConfigured(cfg0)) {
    throw new AtpsyncError('NOT_CONFIGURED', 'atpsync is not configured. Run `atpsync setup` first.');
  }
  const vaultDir = boundVaultDir(cfg0);
  const binding = bindingOf(cfg0);
  await writePidExclusive(process.pid);

  let requestStop: (reason: string) => void = () => {};
  const stopRequested = new Promise<string>((resolve) => {
    requestStop = resolve;
  });

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

  const slowPollMs = deps.pollMs ?? Math.max(1, cfg0.syncIntervalMinutes) * 60_000;
  const subscribedPollMs = deps.subscribedPollMs ?? 15 * 60_000;

  // --- Sign-in gate: after a rejected sign-in, never log in again with the same
  // credentials (no login storm against the PDS); resume once setup changes them.
  let authFailedFp: string | null = null;
  let subState: SubscriptionState = 'reconnecting';
  const liveConnection = () => (cfg0.remote === 'subscribe' ? subState : 'poll');
  const markAuthFailed = (fp: string, err: unknown) => {
    deps.clearConnection();
    if (authFailedFp === fp) return;
    authFailedFp = fp;
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`sign-in rejected; not retrying until the app password changes (run \`atpsync setup\`): ${msg}`);
    void state.update({ connection: 'auth-failed', lastResult: 'error', lastError: msg });
  };
  /** True while `cfg` carries the credentials that were rejected. */
  const authBlocked = (cfg: AtpsyncConfig): boolean => {
    if (authFailedFp === null) return false;
    if (credentialFingerprint(cfg) === authFailedFp) return true;
    authFailedFp = null;
    log.info('app password changed; signing in again');
    void state.update({ connection: liveConnection(), lastError: null });
    return false;
  };
  // Concurrent sign-ins with the same credentials (startup run + event stream) share one login.
  let pendingLogin: { fp: string; p: Promise<Connection> } | null = null;
  const gatedConnect = (cfg: AtpsyncConfig): Promise<Connection> => {
    if (authBlocked(cfg)) {
      return Promise.reject(new AtpsyncError('AUTH', 'sign-in was rejected; waiting for `atpsync setup`'));
    }
    const fp = credentialFingerprint(cfg);
    if (pendingLogin?.fp === fp) return pendingLogin.p;
    const p = deps.connect(cfg).catch((err: unknown) => {
      if (isAuthError(err)) markAuthFailed(fp, err);
      throw err;
    });
    const entry = { fp, p };
    pendingLogin = entry;
    const clear = () => {
      if (pendingLogin === entry) pendingLogin = null;
    };
    p.then(clear, clear);
    return p;
  };

  const run = async (reason: Trigger): Promise<'ok' | 'busy'> => {
    let cfg: AtpsyncConfig;
    try {
      cfg = await deps.loadConfig();
    } catch (err) {
      await recordFailure(reason, err);
      return 'ok';
    }
    if (bindingOf(cfg) !== binding) {
      log.info('config changed (account, vault or folder); stopping. Run `atpsync start` to start again.');
      requestStop('config changed; run `atpsync start`');
      return 'ok';
    }
    if (authBlocked(cfg)) return 'ok'; // logged once by markAuthFailed
    const lock = await tryAcquireLock(vaultDir);
    if (!lock) {
      log.info(`sync (${reason}) deferred: vault locked by another atpsync process`);
      return 'busy';
    }
    try {
      const { pds } = await gatedConnect(cfg);
      const s = await runSync(cfg, { pds, vaultDir });
      log.info(`sync (${reason}): ${s.opsExecuted} operation(s)`);
      for (const w of s.warnings) log.warn(w);
      await state.update({ lastSyncAt: s.lastSyncAt, lastResult: 'ok', lastError: null });
    } catch (err) {
      if (authFailedFp === null) {
        // A 401 from a PDS call (not the sign-in) means the session died: log in afresh next time.
        if (isAuthFailure(err)) deps.clearConnection();
        await recordFailure(reason, err);
      }
    } finally {
      await lock.release();
    }
    return 'ok';
  };

  async function recordFailure(reason: Trigger, err: unknown): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`sync (${reason}) failed: ${msg}`);
    await state.update({ lastResult: 'error', lastError: msg });
  }

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
        const c = await gatedConnect(await deps.loadConfig());
        return { pdsUrl: c.pdsUrl, did: c.did };
      },
      onRelevant: () => scheduler.trigger('remote'),
      onState: (s) => {
        subState = s;
        if (authFailedFp === null) void state.update({ connection: s });
        scheduler.setPollInterval(s === 'subscribed' ? subscribedPollMs : slowPollMs);
        if (s === 'subscribed') {
          log.info('subscribed to PDS event stream');
          scheduler.trigger('startup'); // cover anything missed while disconnected
        }
      },
      // While sign-in is blocked every reconnect attempt fails the same way; markAuthFailed logged it once.
      log: (m) => {
        if (authFailedFp === null) log.warn(m);
      },
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

  const onSignal = (sig: string) => {
    log.info(`received ${sig}, shutting down`);
    requestStop(`stopped at ${new Date().toISOString()}`);
  };
  signals.once('SIGTERM', onSignal);
  signals.once('SIGINT', onSignal);
  const exitReason = await stopRequested;
  signals.off('SIGTERM', onSignal);
  signals.off('SIGINT', onSignal);

  clearInterval(rotate);
  subscription?.stop();
  unwatch();
  await scheduler.stop(); // lets an in-flight sync finish and release the lock
  await state.update({ lastExit: exitReason });
  await removePid(process.pid);
  log.info('daemon stopped');
}
