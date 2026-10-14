/**
 * Background watcher: fs.watch (recursive) + safety interval, debounced.
 * Mirrors the Obsidian plugin's "debounce file events + periodic interval" behavior.
 *
 * Every sync writes inside the vault (<vault>/.atpsync/index.json, pulled notes),
 * and fs.watch reports those writes back to us. Two guards keep that from
 * becoming a feedback loop: events on ignored paths are dropped, and a change
 * that lands mid-sync is re-scheduled through the debounce rather than re-run
 * immediately.
 */
import { watch, type FSWatcher } from 'node:fs';

export interface WatcherOptions {
  /** Debounce window for fs events (default 2000ms, same as the Obsidian plugin). */
  debounceMs?: number;
  /** Safety-net full-sync interval in ms (default 5 min). */
  intervalMs?: number;
  /** Return true for vault-relative paths whose events should be dropped (e.g. `.atpsync/`). */
  ignore?: (relPath: string) => boolean;
}

export class VaultWatcher {
  private watcher: FSWatcher | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private syncing = false;
  private pending = false;
  private running = false;

  constructor(
    public readonly root: string,
    private readonly doSync: () => Promise<void>,
    private readonly opts: WatcherOptions = {},
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
        if (filename != null && this.opts.ignore) {
          const rel = String(filename).split('\\').join('/');
          if (this.opts.ignore(rel)) return;
        }
        this.schedule();
      });
    } catch (err) {
      // Recursive fs.watch is unsupported on some platforms; the interval still covers us.
      this.watcher = null;
      console.warn(`[atpsync] fs.watch failed (${(err as Error).message}); interval-only watch mode.`);
    }
    const intervalMs = this.opts.intervalMs ?? 5 * 60_000;
    this.interval = setInterval(() => this.schedule(), intervalMs);
  }

  stop(): void {
    this.running = false;
    this.watcher?.close();
    this.watcher = null;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
    this.pending = false;
  }

  private schedule(): void {
    if (!this.running) return;
    if (this.syncing) {
      this.pending = true;
      return;
    }
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.run();
    }, this.opts.debounceMs ?? 2000);
  }

  private async run(): Promise<void> {
    if (!this.running) return;
    this.syncing = true;
    try {
      await this.doSync();
    } catch (err) {
      console.warn(`[atpsync] watch sync failed: ${(err as Error).message}`);
    } finally {
      this.syncing = false;
      if (this.pending) {
        this.pending = false;
        this.schedule(); // through the debounce, so our own writes settle first
      }
    }
  }
}
