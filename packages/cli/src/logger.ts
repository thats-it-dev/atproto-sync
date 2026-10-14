/** Append-only daemon log with a single size-based rollover (daemon.log → daemon.log.1). */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import * as path from 'node:path';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  rotateIfNeeded?(): void;
}

export function createFileLogger(
  file: string,
  opts: { mirror?: { write(s: string): unknown } | null; maxBytes?: number } = {}
): Required<Logger> {
  mkdirSync(path.dirname(file), { recursive: true });
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const write = (level: string, message: string) => {
    const line = `${new Date().toISOString()} ${level} ${message}\n`;
    try {
      appendFileSync(file, line);
    } catch {
      // Logging must never take the daemon down.
    }
    opts.mirror?.write(line);
  };
  return {
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    error: (m) => write('ERROR', m),
    rotateIfNeeded() {
      try {
        if (statSync(file).size > maxBytes) renameSync(file, `${file}.1`);
      } catch {
        // missing file: nothing to rotate
      }
    },
  };
}
