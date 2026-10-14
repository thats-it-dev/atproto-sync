import { promises as fs, watchFile, unwatchFile } from 'node:fs';
import { logPath } from '../paths';

export async function tailLog(lines: number): Promise<string> {
  try {
    const text = await fs.readFile(logPath(), 'utf8');
    return text.split('\n').filter(Boolean).slice(-lines).join('\n');
  } catch {
    return '(no daemon log yet)';
  }
}

/** Print the last 200 lines; with follow, keep printing appended bytes until aborted / SIGINT. */
export async function logsCommand(opts: { follow: boolean; write(s: string): void; signal?: AbortSignal }): Promise<void> {
  opts.write(`${await tailLog(200)}\n`);
  if (!opts.follow) return;
  const file = logPath();
  let offset = (await fs.stat(file).catch(() => ({ size: 0 }))).size;
  const onChange = async () => {
    const { size } = await fs.stat(file).catch(() => ({ size: 0 }));
    if (size < offset) offset = 0; // rotated
    if (size === offset) return;
    const fh = await fs.open(file, 'r');
    try {
      const buf = Buffer.alloc(size - offset);
      await fh.read(buf, 0, buf.length, offset);
      offset = size;
      opts.write(buf.toString('utf8'));
    } finally {
      await fh.close();
    }
  };
  watchFile(file, { interval: 500 }, () => void onChange());
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    opts.signal?.addEventListener('abort', done, { once: true });
    process.once('SIGINT', done);
  });
  unwatchFile(file);
}
