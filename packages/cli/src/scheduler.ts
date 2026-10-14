/**
 * One sync at a time, fed by several trigger sources with their own debounce.
 * A burst of the same trigger extends the wait (debounce); a slower trigger
 * never postpones a faster one already armed. Triggers that land mid-sync are
 * remembered and rescheduled through their debounce afterwards, so the
 * engine's own writes settle before the follow-up run.
 */
export type Trigger = 'startup' | 'fs' | 'remote' | 'poll';
export type RunResult = 'ok' | 'busy';

export const DEFAULT_DEBOUNCE: Record<Trigger, number> = { startup: 0, fs: 2000, remote: 500, poll: 0 };

export interface SchedulerOptions {
  debounceMs?: Partial<Record<Trigger, number>>;
  /** Delay before retrying when run() reports the vault is locked elsewhere (default 2000). */
  busyRetryMs?: number;
  onError?: (err: unknown) => void;
}

export class SyncScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private armedDelay = Infinity;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private syncing = false;
  private pending: Trigger | null = null;
  private stopped = false;
  private inflight: Promise<void> = Promise.resolve();

  constructor(
    private readonly run: (reason: Trigger) => Promise<RunResult>,
    private readonly opts: SchedulerOptions = {}
  ) {}

  get isSyncing(): boolean {
    return this.syncing;
  }

  trigger(reason: Trigger): void {
    if (this.stopped) return;
    if (this.syncing) {
      this.pending = reason;
      return;
    }
    this.arm(this.delayFor(reason), reason);
  }

  setPollInterval(ms: number): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = this.stopped ? null : setInterval(() => this.trigger('poll'), ms);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.timer = null;
    this.pollTimer = null;
    this.pending = null;
    await this.inflight;
  }

  private delayFor(reason: Trigger): number {
    return this.opts.debounceMs?.[reason] ?? DEFAULT_DEBOUNCE[reason];
  }

  private arm(delay: number, reason: Trigger): void {
    if (this.timer && this.armedDelay < delay) return; // a faster run is already queued
    if (this.timer) clearTimeout(this.timer);
    this.armedDelay = delay;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.armedDelay = Infinity;
      this.inflight = this.execute(reason);
    }, delay);
  }

  private async execute(reason: Trigger): Promise<void> {
    if (this.stopped) return;
    this.syncing = true;
    let result: RunResult = 'ok';
    try {
      result = await this.run(reason);
    } catch (err) {
      this.opts.onError?.(err);
    } finally {
      this.syncing = false;
    }
    if (this.stopped) return;
    if (result === 'busy') {
      this.pending = null;
      this.arm(this.opts.busyRetryMs ?? 2000, reason);
      return;
    }
    if (this.pending) {
      const next = this.pending;
      this.pending = null;
      this.arm(this.delayFor(next), next);
    }
  }
}
