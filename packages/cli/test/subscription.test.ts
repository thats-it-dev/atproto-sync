import { describe, it, expect, afterEach } from 'vitest';
import { encode } from 'cborg';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import {
  RepoSubscription,
  backoffDelay,
  decodeFrame,
  isRelevantCommit,
  subscribeReposUrl,
  type SubscriptionState,
} from '../src/subscription';
import { waitFor } from './helpers';

const ME = 'did:plc:me';

function frame(header: object, body: object): Uint8Array {
  const h = encode(header);
  const b = encode(body);
  const out = new Uint8Array(h.length + b.length);
  out.set(h, 0);
  out.set(b, h.length);
  return out;
}
const commit = (repo: string, paths: string[]) =>
  frame({ op: 1, t: '#commit' }, { repo, ops: paths.map((p) => ({ action: 'create', path: p, cid: null })) });

describe('frame decoding', () => {
  it('decodes header and body', () => {
    const f = decodeFrame(commit(ME, ['app.notesky.note/abc']));
    expect(f?.header).toEqual({ op: 1, t: '#commit' });
    expect(f?.body.repo).toBe(ME);
  });

  it('accepts CID tags (tag 42) without interpreting them', () => {
    const header = encode({ op: 1, t: '#commit' });
    // body = { "c": tag42(h'00') }
    const body = Uint8Array.of(0xa1, 0x61, 0x63, 0xd8, 0x2a, 0x41, 0x00);
    const bytes = new Uint8Array(header.length + body.length);
    bytes.set(header, 0);
    bytes.set(body, header.length);
    expect(decodeFrame(bytes)).not.toBeNull();
  });

  it('returns null for garbage and truncated frames', () => {
    expect(decodeFrame(Uint8Array.of(0xff, 0x00, 0x13))).toBeNull();
    const ok = commit(ME, ['app.notesky.note/abc']);
    expect(decodeFrame(ok.slice(0, ok.length - 3))).toBeNull();
    expect(decodeFrame(new Uint8Array())).toBeNull();
  });

  it('only notesky commits for our DID are relevant', () => {
    expect(isRelevantCommit(decodeFrame(commit(ME, ['app.notesky.note/a']))!, ME)).toBe(true);
    expect(isRelevantCommit(decodeFrame(commit(ME, ['app.bsky.feed.post/a', 'app.notesky.vault/v']))!, ME)).toBe(true);
    expect(isRelevantCommit(decodeFrame(commit('did:plc:other', ['app.notesky.note/a']))!, ME)).toBe(false);
    expect(isRelevantCommit(decodeFrame(commit(ME, ['app.bsky.feed.post/a']))!, ME)).toBe(false);
    expect(isRelevantCommit(decodeFrame(frame({ op: 1, t: '#identity' }, { did: ME }))!, ME)).toBe(false);
  });
});

describe('helpers', () => {
  it('builds ws/wss URLs', () => {
    expect(subscribeReposUrl('https://pds.example.com')).toBe('wss://pds.example.com/xrpc/com.atproto.sync.subscribeRepos');
    expect(subscribeReposUrl('http://localhost:2583/')).toBe('ws://localhost:2583/xrpc/com.atproto.sync.subscribeRepos');
  });

  it('backs off exponentially with jitter, capped', () => {
    expect(backoffDelay(0, 1000, 60_000, () => 0)).toBe(500);
    expect(backoffDelay(0, 1000, 60_000, () => 1)).toBe(1000);
    expect(backoffDelay(3, 1000, 60_000, () => 1)).toBe(8000);
    expect(backoffDelay(20, 1000, 60_000, () => 1)).toBe(60_000);
    expect(backoffDelay(20, 1000, 60_000, () => 0)).toBe(30_000);
  });
});

describe('RepoSubscription against a local websocket server', () => {
  let wss: WebSocketServer | null = null;
  let sub: RepoSubscription | null = null;
  afterEach(async () => {
    sub?.stop();
    await new Promise<void>((r) => (wss ? wss.close(() => r()) : r()));
    wss = null;
  });

  async function server(onConn: (s: WsSocket, url: string) => void): Promise<string> {
    wss = new WebSocketServer({ port: 0 });
    wss.on('connection', (s, req) => onConn(s, req.url ?? ''));
    await new Promise<void>((r) => wss!.once('listening', () => r()));
    return `http://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  }

  it('fires onRelevant for matching commits, ignores others, reconnects after close and after an error frame', async () => {
    const urls: string[] = [];
    let connections = 0;
    const pdsUrl = await server((s, url) => {
      urls.push(url);
      connections++;
      if (connections === 1) {
        s.send(commit('did:plc:other', ['app.notesky.note/x']));
        s.send(Uint8Array.of(0xff, 0x00)); // garbage: must be skipped
        s.send(commit(ME, ['app.notesky.note/a']));
        setTimeout(() => s.close(), 50);
      } else if (connections === 2) {
        s.send(frame({ op: -1 }, { error: 'FutureCursor', message: 'nope' }));
      } else {
        s.send(commit(ME, ['app.notesky.attachment/b']));
      }
    });
    const states: SubscriptionState[] = [];
    let relevant = 0;
    sub = new RepoSubscription({
      resolveTarget: async () => ({ pdsUrl, did: ME }),
      onRelevant: () => relevant++,
      onState: (s) => states.push(s),
      minBackoffMs: 20,
      maxBackoffMs: 40,
    });
    sub.start();
    await waitFor(() => relevant === 2 && connections >= 3);
    expect(urls[0]).toBe('/xrpc/com.atproto.sync.subscribeRepos');
    expect(states.filter((s) => s === 'subscribed').length).toBeGreaterThanOrEqual(3);
    expect(states).toContain('reconnecting');
  });

  it('retries when resolving the target fails', async () => {
    const pdsUrl = await server(() => {});
    let calls = 0;
    const states: SubscriptionState[] = [];
    sub = new RepoSubscription({
      resolveTarget: async () => {
        if (calls++ === 0) throw new Error('offline');
        return { pdsUrl, did: ME };
      },
      onRelevant: () => {},
      onState: (s) => states.push(s),
      minBackoffMs: 20,
      maxBackoffMs: 40,
    });
    sub.start();
    await waitFor(() => states.includes('subscribed'));
    expect(states[0]).toBe('reconnecting');
  });

  it('a target URL that cannot be opened schedules a reconnect instead of rejecting', async () => {
    let resolves = 0;
    const states: SubscriptionState[] = [];
    const logs: string[] = [];
    sub = new RepoSubscription({
      resolveTarget: async () => {
        resolves++;
        return { pdsUrl: 'not a url', did: ME };
      },
      onRelevant: () => {},
      onState: (s) => states.push(s),
      log: (m) => logs.push(m),
      minBackoffMs: 10,
      maxBackoffMs: 20,
    });
    sub.start();
    await waitFor(() => resolves >= 3);
    expect(states.every((s) => s === 'reconnecting')).toBe(true);
    expect(logs[0]).toMatch(/cannot open not a url/);
  });

  it('keeps backing off against a server that accepts and immediately closes', async () => {
    const at: number[] = [];
    const pdsUrl = await server((s) => {
      at.push(Date.now());
      s.close();
    });
    sub = new RepoSubscription({
      resolveTarget: async () => ({ pdsUrl, did: ME }),
      onRelevant: () => {},
      onState: () => {},
      minBackoffMs: 20,
      maxBackoffMs: 2000,
      random: () => 1, // no jitter: delays 20, 40, 80, 160, ...
    });
    sub.start();
    await waitFor(() => at.length >= 5, 5000);
    const gaps = at.slice(1).map((t, i) => t - at[i]);
    expect(gaps[3]).toBeGreaterThanOrEqual(160);
    expect(gaps[3]).toBeGreaterThan(gaps[0] * 2);
  });

  it('start is a no-op while started, and a restart does not leave two sockets', async () => {
    let connections = 0;
    const pdsUrl = await server(() => connections++);
    let resolves = 0;
    sub = new RepoSubscription({
      resolveTarget: async () => {
        resolves++;
        return { pdsUrl, did: ME };
      },
      onRelevant: () => {},
      onState: () => {},
    });
    sub.start();
    sub.start();
    await waitFor(() => connections === 1);
    sub.stop();
    sub.start();
    sub.stop();
    sub.start();
    await waitFor(() => connections === 2);
    await new Promise((r) => setTimeout(r, 100));
    expect(connections).toBe(2);
    expect(resolves).toBe(3);
  });
});
