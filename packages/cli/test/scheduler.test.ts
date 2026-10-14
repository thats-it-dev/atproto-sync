import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SyncScheduler, type RunResult, type Trigger } from '../src/scheduler';
import { watchVault } from '../src/fs-watch';
import { isIgnored } from '@atproto-sync/core/sync/ignore';

describe('SyncScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function recorder(result: RunResult = 'ok') {
    const runs: Trigger[] = [];
    const run = vi.fn(async (r: Trigger) => {
      runs.push(r);
      return result;
    });
    return { runs, run };
  }

  it('keeps polling when setPollInterval is repeated with the same interval', async () => {
    const { runs, run } = recorder();
    const s = new SyncScheduler(run);
    s.setPollInterval(1000);
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(600);
      s.setPollInterval(1000);
    }
    expect(runs.filter((r) => r === 'poll').length).toBeGreaterThanOrEqual(1);
    await s.stop();
  });

  it('coalesces a burst of 50 fs events into one run after 2 s of quiet', async () => {
    const { runs, run } = recorder();
    const s = new SyncScheduler(run);
    for (let i = 0; i < 50; i++) {
      s.trigger('fs');
      await vi.advanceTimersByTimeAsync(20);
    }
    await vi.advanceTimersByTimeAsync(1979);
    expect(runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toEqual(['fs']);
    await s.stop();
  });

  it('runs startup immediately and remote after 500 ms', async () => {
    const { runs, run } = recorder();
    const s = new SyncScheduler(run);
    s.trigger('startup');
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toEqual(['startup']);
    s.trigger('remote');
    await vi.advanceTimersByTimeAsync(499);
    expect(runs).toEqual(['startup']);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toEqual(['startup', 'remote']);
    await s.stop();
  });

  it('a slower trigger does not postpone an armed faster one', async () => {
    const { runs, run } = recorder();
    const s = new SyncScheduler(run);
    s.trigger('remote');
    s.trigger('fs');
    await vi.advanceTimersByTimeAsync(500);
    expect(runs).toEqual(['remote']);
    await s.stop();
  });

  it('never runs concurrently; a trigger mid-run is rescheduled through its debounce', async () => {
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const runs: Trigger[] = [];
    const s = new SyncScheduler(async (r) => {
      runs.push(r);
      active++;
      maxActive = Math.max(maxActive, active);
      if (runs.length === 1) await new Promise<void>((res) => (release = res));
      active--;
      return 'ok';
    });
    s.trigger('startup');
    await vi.advanceTimersByTimeAsync(0);
    expect(s.isSyncing).toBe(true);
    s.trigger('fs');
    s.trigger('fs');
    await vi.advanceTimersByTimeAsync(5000);
    expect(runs).toEqual(['startup']);
    release();
    await vi.advanceTimersByTimeAsync(1999);
    expect(runs).toEqual(['startup']);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toEqual(['startup', 'fs']);
    expect(maxActive).toBe(1);
    await s.stop();
  });

  it('retries after busyRetryMs when the vault is locked elsewhere', async () => {
    const results: RunResult[] = ['busy', 'ok'];
    const run = vi.fn(async () => results.shift()!);
    const s = new SyncScheduler(run, { busyRetryMs: 300 });
    s.trigger('startup');
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(run).toHaveBeenCalledTimes(2);
    await s.stop();
  });

  it('reports a throwing run to onError and keeps scheduling', async () => {
    const onError = vi.fn();
    let n = 0;
    const s = new SyncScheduler(async () => {
      if (n++ === 0) throw new Error('boom');
      return 'ok';
    }, { onError });
    s.trigger('startup');
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));
    s.trigger('startup');
    await vi.advanceTimersByTimeAsync(0);
    expect(n).toBe(2);
    await s.stop();
  });

  it('fires poll on the configured interval and can be re-timed', async () => {
    const { runs, run } = recorder();
    const s = new SyncScheduler(run);
    s.setPollInterval(1000);
    await vi.advanceTimersByTimeAsync(3001);
    expect(runs).toEqual(['poll', 'poll', 'poll']);
    s.setPollInterval(10_000);
    await vi.advanceTimersByTimeAsync(9000);
    expect(runs.length).toBe(3);
    await s.stop();
  });

  it('stop() waits for the in-flight run and cancels pending work', async () => {
    let release!: () => void;
    let finished = false;
    const s = new SyncScheduler(async () => {
      await new Promise<void>((res) => (release = res));
      finished = true;
      return 'ok';
    });
    s.trigger('startup');
    await vi.advanceTimersByTimeAsync(0);
    s.trigger('fs');
    const stopped = s.stop();
    release();
    await stopped;
    expect(finished).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
  });
});

describe('watchVault', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("ignores the engine's own .atpsync writes but reports note edits", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'atpsync-watch-'));
    let changes = 0;
    const unwatch = watchVault(root, (rel) => isIgnored(rel, ['.atpsync/']), () => changes++);
    await fs.mkdir(path.join(root, '.atpsync'));
    await fs.writeFile(path.join(root, '.atpsync', 'index.json'), '[]');
    await sleep(300);
    expect(changes).toBe(0);
    await fs.writeFile(path.join(root, 'note.md'), 'hi');
    await sleep(300);
    expect(changes).toBeGreaterThan(0);
    unwatch();
  });
});
