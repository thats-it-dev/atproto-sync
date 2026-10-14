/** TTY implementation of SetupIO: readline questions, numbered select, hidden secret input. */
import * as readline from 'node:readline/promises';
import type { SetupIO } from './setup';

function readSecret(prompt: string): Promise<string> {
  const input = process.stdin;
  const output = process.stdout;
  return new Promise((resolve, reject) => {
    output.write(prompt);
    let buf = '';
    const wasRaw = input.isRaw;
    input.setRawMode?.(true);
    input.setEncoding('utf8');
    input.resume();
    const finish = () => {
      input.off('data', onData);
      input.setRawMode?.(wasRaw ?? false);
      input.pause();
      output.write('\n');
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          finish();
          resolve(buf);
          return;
        }
        if (ch === '\u0003') {
          finish();
          reject(new Error('setup aborted'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    input.on('data', onData);
  });
}

async function question(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

export function createTtyIO(cwd: string, vaultDir?: string): SetupIO {
  return {
    cwd,
    hasUI: Boolean(process.stdin.isTTY),
    vaultDir,
    async input(title, placeholder, opts) {
      const prompt = `${title}${placeholder ? ` [${placeholder}]` : ''}: `;
      return opts?.secret ? readSecret(prompt) : question(prompt);
    },
    async select(title, options) {
      process.stdout.write(`${title}\n`);
      options.forEach((o, i) => process.stdout.write(`  ${i + 1}) ${o}\n`));
      const n = Number.parseInt(await question(`Choose 1-${options.length}: `), 10);
      return Number.isInteger(n) && n >= 1 && n <= options.length ? options[n - 1] : undefined;
    },
    notify(message, type) {
      (type === 'error' ? process.stderr : process.stdout).write(`${message}\n`);
    },
  };
}
