import { describe, it, expect } from 'vitest';
import { FakePds } from '../../src/sync/fake-pds';
import { NOTE_COLLECTION } from '../../src/lexicon/build';
import { makeEngine } from './helpers';

const MASTER = new Uint8Array(32).fill(3);

describe('two-device scenarios', () => {
  it('offline queue: concurrent non-overlapping edits converge on both devices', async () => {
    const pds = new FakePds();
    const a = makeEngine(pds, MASTER);
    const b = makeEngine(pds, MASTER);
    await a.vault.write('note.md', 'line1\nline2\nline3\n');
    await a.engine.sync();
    await b.engine.sync();

    // A edits "offline" (no sync yet); B edits a different line and syncs.
    await a.vault.write('note.md', 'line1 A\nline2\nline3\n');
    await b.vault.write('note.md', 'line1\nline2\nline3 B\n');
    await b.engine.sync();
    await a.engine.sync();
    await b.engine.sync();

    const merged = 'line1 A\nline2\nline3 B\n';
    expect(await a.vault.read('note.md')).toBe(merged);
    expect(await b.vault.read('note.md')).toBe(merged);
  });

  it('same-line edits from two devices both survive the char-level merge', async () => {
    const pds = new FakePds();
    const a = makeEngine(pds, MASTER);
    const b = makeEngine(pds, MASTER);
    await a.vault.write('note.md', 'The quick brown fox jumps over the lazy dog.\n');
    await a.engine.sync();
    await b.engine.sync();

    await a.vault.write('note.md', 'The very quick brown fox jumps over the lazy dog.\n');
    await b.vault.write('note.md', 'The quick brown fox jumps over the sleepy dog.\n');
    await b.engine.sync();
    await a.engine.sync();
    await b.engine.sync();

    const merged = 'The very quick brown fox jumps over the sleepy dog.\n';
    expect(await a.vault.read('note.md')).toBe(merged);
    expect(await b.vault.read('note.md')).toBe(merged);
  });

  it('delete vs edit race: the note survives everywhere with the edit', async () => {
    const pds = new FakePds();
    const a = makeEngine(pds, MASTER);
    const b = makeEngine(pds, MASTER);
    await a.vault.write('note.md', 'original\n');
    await a.engine.sync();
    await b.engine.sync();

    await a.vault.remove('note.md');
    await b.vault.write('note.md', 'edited after delete\n');
    await a.engine.sync(); // A tombstones the note
    await b.engine.sync(); // B's edit resurrects it
    await a.engine.sync(); // A pulls it back

    expect(await a.vault.read('note.md')).toBe('edited after delete\n');
    expect(await b.vault.read('note.md')).toBe('edited after delete\n');
    expect((await pds.listRecords(NOTE_COLLECTION)).length).toBe(1);
  });

  it("rename: B's file moves, remote record count and rkey unchanged", async () => {
    const pds = new FakePds();
    const a = makeEngine(pds, MASTER);
    const b = makeEngine(pds, MASTER);
    await a.vault.write('Ideas/old name.md', 'stable content\n');
    await a.engine.sync();
    await b.engine.sync();
    const rkeyBefore = (await pds.listRecords(NOTE_COLLECTION))[0].rkey;

    await a.vault.remove('Ideas/old name.md');
    await a.vault.write('Ideas/new name.md', 'stable content\n');
    await a.engine.sync();
    await b.engine.sync();

    const records = await pds.listRecords(NOTE_COLLECTION);
    expect(records.length).toBe(1);
    expect(records[0].rkey).toBe(rkeyBefore);
    expect(await b.vault.read('Ideas/new name.md')).toBe('stable content\n');
    expect(await b.vault.read('Ideas/old name.md')).toBeUndefined();
  });

  it('CAS race: concurrent pushes lose no update; the second writer merges', async () => {
    const pds = new FakePds();
    const a = makeEngine(pds, MASTER);
    // B sees a stale listing on its first read of the cycle: it will push against
    // a cid that A has already replaced, hit CasError, and re-run with fresh state.
    let staleOnce: Array<{ rkey: string; cid: string; value: unknown }> | undefined;
    const stalePds = new Proxy(pds, {
      get(target, prop, receiver) {
        if (prop === 'listRecords') {
          return async (collection: string) => {
            if (collection === NOTE_COLLECTION && staleOnce) {
              const snapshot = staleOnce;
              staleOnce = undefined;
              return snapshot;
            }
            return target.listRecords(collection);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const b = makeEngine(stalePds, MASTER);

    await a.vault.write('note.md', 'line1\nline2\nline3\n');
    await a.engine.sync();
    await b.engine.sync();

    await a.vault.write('note.md', 'line1 A\nline2\nline3\n');
    await b.vault.write('note.md', 'line1\nline2\nline3 B\n');
    staleOnce = await pds.listRecords(NOTE_COLLECTION); // B's next listing predates A's push
    await a.engine.sync();
    await b.engine.sync(); // stale CAS -> CasError -> dirty re-run -> merge
    await a.engine.sync();

    const merged = 'line1 A\nline2\nline3 B\n';
    expect(await a.vault.read('note.md')).toBe(merged);
    expect(await b.vault.read('note.md')).toBe(merged);
  });
});

/** Deterministic PRNG (mulberry32) so failures reproduce from the logged seed. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('property: random interleavings converge', () => {
  it('200 seeded iterations: convergence, encryption at rest, nothing invented', async () => {
    for (let iter = 0; iter < 200; iter++) {
      const rand = mulberry32(1000 + iter);
      const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];

      const pds = new FakePds();
      const deviceCount = 2 + (rand() < 0.5 ? 1 : 0);
      const devices = Array.from({ length: deviceCount }, () => makeEngine(pds, MASTER));
      // Tokens and paths contain '#', which cannot appear in base64/hex/JSON keys,
      // so any '#' in the raw PDS dump is a plaintext leak.
      const paths = ['#p0.md', '#p1.md', '#p2.md', 'dir/#p3.md'];
      const binPaths = ['#img0.bin', '#img1.bin', 'att/#img2.bin'];
      const writtenTokens = new Set<string>();
      const writtenBinaries = new Set<string>();
      let tokenCounter = 0;
      const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

      const actions = 8 + Math.floor(rand() * 12);
      for (let step = 0; step < actions; step++) {
        const d = pick(devices);
        const roll = rand();
        if (roll < 0.35) {
          // note edit/create
          const token = `#tok-i${iter}-c${tokenCounter++}#`;
          writtenTokens.add(token);
          await d.vault.write(pick(paths), token);
        } else if (roll < 0.48) {
          // attachment edit/create with seeded bytes
          const bytes = Uint8Array.from({ length: 4 + Math.floor(rand() * 8) }, () =>
            Math.floor(rand() * 256)
          );
          writtenBinaries.add(hex(bytes));
          await d.vault.writeBinary(pick(binPaths), bytes);
        } else if (roll < 0.6) {
          // delete a random existing file (note or attachment)
          const all = [...d.vault.files.keys(), ...d.vault.binaries.keys()];
          if (all.length) await d.vault.remove(pick(all));
        } else if (roll < 0.7) {
          // rename a random existing file to an unused path of its kind
          if (rand() < 0.5) {
            const files = [...d.vault.files.keys()];
            const free = paths.filter((p) => !d.vault.files.has(p));
            if (files.length && free.length) {
              const from = pick(files);
              const content = d.vault.files.get(from)!;
              await d.vault.remove(from);
              await d.vault.write(pick(free), content);
            }
          } else {
            const bins = [...d.vault.binaries.keys()].filter(
              (p) => !p.startsWith('Notesky Conflicts/')
            );
            const free = binPaths.filter((p) => !d.vault.binaries.has(p));
            if (bins.length && free.length) {
              const from = pick(bins);
              const bytes = d.vault.binaries.get(from)!;
              await d.vault.remove(from);
              await d.vault.writeBinary(pick(free), bytes);
            }
          }
        } else {
          await d.engine.sync();
        }
      }

      // Quiescence: two rounds of syncs with no new edits.
      for (let round = 0; round < 2; round++) {
        for (const d of devices) await d.engine.sync();
      }

      // Invariant 1: all vaults identical — notes and binaries (the conflicts
      // stash is device-local by design, so it sits outside the comparison).
      const dumps = devices.map((d) =>
        JSON.stringify([
          [...d.vault.files.entries()]
            .filter(([p]) => !p.startsWith('Notesky Conflicts/'))
            .sort((x, y) => x[0].localeCompare(y[0])),
          [...d.vault.binaries.entries()]
            .filter(([p]) => !p.startsWith('Notesky Conflicts/'))
            .map(([p, b]) => [p, hex(b)])
            .sort((x, y) => x[0].localeCompare(y[0])),
        ])
      );
      for (const dump of dumps.slice(1)) {
        expect(dump, `seed ${1000 + iter}: vaults diverged`).toBe(dumps[0]);
      }

      // Invariant 2: no plaintext at rest ('#' cannot occur in encrypted records).
      const raw = JSON.stringify([
        await pds.listRecords('app.notesky.note'),
        await pds.listRecords('app.notesky.attachment'),
        await pds.listRecords('app.notesky.tombstone'),
      ]);
      expect(raw.includes('#'), `seed ${1000 + iter}: plaintext leaked to PDS`).toBe(false);

      // Invariant 3: nothing invented — every complete token in a surviving
      // file was actually written by some device. (Char-level merging can
      // splice within a line, so line identity is no longer guaranteed.)
      for (const [path, content] of devices[0].vault.files) {
        for (const tok of content.match(/#tok-i\d+-c\d+#/g) ?? []) {
          expect(
            writtenTokens.has(tok),
            `seed ${1000 + iter}: invented token ${tok} in ${path}`
          ).toBe(true);
        }
      }

      // Invariant 4: binaries never merge, so every surviving binary must be
      // byte-identical to something some device actually wrote.
      for (const [path, bytes] of devices[0].vault.binaries) {
        if (path.startsWith('Notesky Conflicts/')) continue;
        expect(
          writtenBinaries.has(hex(bytes)),
          `seed ${1000 + iter}: invented bytes in ${path}`
        ).toBe(true);
      }
    }
  }, 120_000);
});
