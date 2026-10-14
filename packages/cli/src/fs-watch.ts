/**
 * Recursive fs.watch over the vault. Events on ignored paths are dropped so the
 * engine's own <vault>/.atpsync/ writes don't re-trigger a sync. Where
 * recursive watching is unsupported the caller still has the poll interval.
 */
import { watch } from 'node:fs';

export function watchVault(
  root: string,
  ignore: (rel: string) => boolean,
  onChange: () => void,
  warn: (m: string) => void = () => {}
): () => void {
  try {
    const w = watch(root, { recursive: true }, (_event, filename) => {
      if (filename != null && ignore(String(filename).split('\\').join('/'))) return;
      onChange();
    });
    w.on('error', (err) => warn(`file watcher error: ${err.message}`));
    return () => w.close();
  } catch (err) {
    warn(`fs.watch failed (${(err as Error).message}); polling only.`);
    return () => {};
  }
}
