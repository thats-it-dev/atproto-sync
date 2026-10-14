/**
 * Real-time remote-change hints from our own PDS's com.atproto.sync.subscribeRepos.
 * We only inspect frame headers and commit op paths: an event means "sync now",
 * and the engine re-reads records over XRPC, so nothing here is trusted and
 * signatures are not verified. No cursor is persisted; the caller does a full
 * sync on every (re)connect to cover gaps.
 */
import { decodeFirst } from 'cborg';

export interface Frame {
  header: { op: number; t?: string };
  body: Record<string, unknown>;
}

// CIDs are CBOR tag 42; accept them as opaque values.
const TAGS: ((decode: () => unknown) => unknown)[] = [];
TAGS[42] = (decode) => decode();

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function decodeFrame(bytes: Uint8Array): Frame | null {
  try {
    const [header, rest] = decodeFirst(bytes, { tags: TAGS as never });
    const [body] = decodeFirst(rest, { tags: TAGS as never });
    if (!isObject(header) || typeof header.op !== 'number' || !isObject(body)) return null;
    return { header: header as Frame['header'], body };
  } catch {
    return null;
  }
}

export function isRelevantCommit(frame: Frame, did: string): boolean {
  if (frame.header.op !== 1 || frame.header.t !== '#commit') return false;
  if (frame.body.repo !== did || !Array.isArray(frame.body.ops)) return false;
  return frame.body.ops.some(
    (op) => isObject(op) && typeof op.path === 'string' && op.path.startsWith('app.notesky.')
  );
}

export function subscribeReposUrl(pdsUrl: string): string {
  const u = new URL('/xrpc/com.atproto.sync.subscribeRepos', pdsUrl);
  u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:';
  return u.toString();
}

/** Exponential backoff with jitter: a value in [base/2, base], base = min(max, min·2^attempt). */
export function backoffDelay(attempt: number, minMs: number, maxMs: number, random: () => number = Math.random): number {
  const base = Math.min(maxMs, minMs * 2 ** attempt);
  return Math.round(base / 2 + (random() * base) / 2);
}

export type SubscriptionState = 'subscribed' | 'reconnecting';

export interface SubscriptionTarget {
  pdsUrl: string;
  did: string;
}

export interface SubscriptionOptions {
  resolveTarget(): Promise<SubscriptionTarget>;
  onRelevant(): void;
  onState(state: SubscriptionState): void;
  log?(message: string): void;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** A connection must stay open this long before the backoff resets (default 30 s). */
  stableMs?: number;
  /** Jitter source for backoffDelay (tests). */
  random?: () => number;
}

export class RepoSubscription {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private stopped = true;
  /** Bumped by every start/stop so a connect() in flight from an earlier run gives up. */
  private generation = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: SubscriptionOptions) {}

  /** Connect (no-op while already started). */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.generation++;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.retryTimer = null;
    this.stableTimer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  private async connect(): Promise<void> {
    const gen = this.generation;
    const current = () => !this.stopped && this.generation === gen;
    if (!current()) return;
    let target: SubscriptionTarget;
    try {
      target = await this.opts.resolveTarget();
    } catch (err) {
      if (!current()) return;
      this.opts.log?.(`event stream: cannot reach PDS (${(err as Error).message})`);
      this.scheduleReconnect();
      return;
    }
    if (!current()) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(subscribeReposUrl(target.pdsUrl));
    } catch (err) {
      this.opts.log?.(`event stream: cannot open ${target.pdsUrl} (${(err as Error).message})`);
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      // Reset the backoff only once the connection proves stable, so a server
      // that accepts and immediately drops us is not hammered at the minimum delay.
      this.stableTimer = setTimeout(() => {
        this.stableTimer = null;
        if (this.ws === ws) this.attempt = 0;
      }, this.opts.stableMs ?? 30_000);
      this.opts.onState('subscribed');
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws) return;
      if (!(ev.data instanceof ArrayBuffer)) return;
      const f = decodeFrame(new Uint8Array(ev.data));
      if (!f) return;
      if (f.header.op === -1) {
        this.opts.log?.(`event stream error: ${String(f.body.error)} ${String(f.body.message ?? '')}`.trim());
        ws.close();
        return;
      }
      if (isRelevantCommit(f, target.did)) this.opts.onRelevant();
    };
    ws.onerror = () => {}; // a close event always follows
    ws.onclose = () => {
      if (this.ws !== ws) return; // stopped, or superseded by a newer socket
      this.ws = null;
      if (this.stableTimer) clearTimeout(this.stableTimer);
      this.stableTimer = null;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.opts.onState('reconnecting');
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const delay = backoffDelay(
      this.attempt++,
      this.opts.minBackoffMs ?? 1000,
      this.opts.maxBackoffMs ?? 60_000,
      this.opts.random
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }
}
