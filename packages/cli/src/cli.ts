/** Argument parsing, dispatch, text vs --json output, and exit codes. */
import { parseArgs } from 'node:util';
import { defaultDeps, type CommandDeps } from './commands/context';
import type { StartDeps } from './commands/daemon-control';
import { logoutCommand } from './commands/logout';
import { publishCommand } from './commands/publish';
import { statusCommand } from './commands/status';
import { syncCommand } from './commands/sync';
import { loadConfig } from './config';
import { runDaemon } from './daemon';
import { AtpsyncError, EXIT_CODES, toAtpsyncError } from './errors';
import { createFileLogger } from './logger';
import { logPath } from './paths';
import { createTtyIO } from './prompts';
import { renderPublish, renderStatus, renderSync } from './render';
import { clearConnectionCache, connect } from './session';
import { runSetup } from './setup';
import { VERSION } from './version';

export interface CliIO {
  stdout(s: string): void;
  stderr(s: string): void;
}

export interface CliEnv {
  io: CliIO;
  deps: CommandDeps;
  ctl: StartDeps;
  cwd: string;
}

export const USAGE = `atpsync ${VERSION} — sync a vault folder with your ATProto PDS (E2E-encrypted)

Usage:
  atpsync setup [folder]            sign in, bind a folder, choose/create a vault
  atpsync start                     start the background daemon
  atpsync stop                      stop the background daemon
  atpsync status [--json]           account, vault, counts, daemon state
  atpsync sync [--json] [--no-wait] sync once now
  atpsync publish <path> [slug]     make a note public, then sync
  atpsync unpublish <path>          make a note private again, then sync
  atpsync logs [-f]                 print (or follow) the daemon log
  atpsync logout                    stop the daemon and forget credentials
  atpsync daemon                    run the daemon in the foreground
  atpsync mcp                       MCP server on stdio (for agents)`;

export function defaultEnv(): CliEnv {
  return {
    io: { stdout: (s) => void process.stdout.write(s), stderr: (s) => void process.stderr.write(s) },
    deps: defaultDeps(),
    ctl: { execPath: process.execPath, cliPath: process.argv[1] },
    cwd: process.cwd(),
  };
}

export async function main(argv: string[], env: CliEnv = defaultEnv()): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: 'boolean' },
        'no-wait': { type: 'boolean' },
        follow: { type: 'boolean', short: 'f' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (err) {
    env.io.stderr(`atpsync: ${(err as Error).message}\n\n${USAGE}\n`);
    return EXIT_CODES.USAGE;
  }
  const { values, positionals } = parsed;
  const [cmd = 'help', ...rest] = values.help ? ['help'] : values.version ? ['version'] : positionals;
  const json = Boolean(values.json);
  const deps: CommandDeps = values['no-wait'] ? { ...env.deps, lock: { ...env.deps.lock, wait: false } } : env.deps;
  const emit = (result: unknown, text: string) => env.io.stdout(`${json ? JSON.stringify(result) : text}\n`);

  try {
    switch (cmd) {
      case 'help':
        env.io.stdout(`${USAGE}\n`);
        return 0;
      case 'version':
        env.io.stdout(`${VERSION}\n`);
        return 0;
      case 'status': {
        const r = await statusCommand(deps);
        emit(r, renderStatus(r));
        return 0;
      }
      case 'sync': {
        const r = await syncCommand(deps);
        emit(r, renderSync(r));
        return 0;
      }
      case 'publish':
      case 'unpublish': {
        const target = rest[0];
        if (!target) throw new AtpsyncError('USAGE', `usage: atpsync ${cmd} <path>${cmd === 'publish' ? ' [slug]' : ''}`);
        const r = await publishCommand(deps, {
          path: target,
          makePublic: cmd === 'publish',
          slug: cmd === 'publish' ? rest[1] : undefined,
        });
        emit(r, renderPublish(r));
        return 0;
      }
      case 'logout': {
        // Task 9 replaces this stub with `() => stopCommand()`.
        const r = await logoutCommand(deps, async () => ({ wasRunning: false }));
        emit(r, `Logged out${r.stoppedDaemon ? ' (daemon stopped)' : ''}. Run \`atpsync setup\` to sign back in.`);
        return 0;
      }
      case 'setup':
        await runSetup(createTtyIO(env.cwd, rest.join(' ') || undefined));
        clearConnectionCache();
        return 0;
      case 'daemon': {
        const log = createFileLogger(logPath(), { mirror: process.stdout.isTTY ? process.stdout : null });
        log.rotateIfNeeded();
        await runDaemon({
          loadConfig,
          connect: (cfg) => connect(cfg),
          clearConnection: clearConnectionCache,
          log,
          installCrashHandlers: true,
        });
        return 0;
      }
      // 'start' | 'stop' | 'logs' are added in Task 9; 'mcp' in Task 10.
      default:
        throw new AtpsyncError('USAGE', `Unknown command "${cmd}".\n\n${USAGE}`);
    }
  } catch (err) {
    const e = toAtpsyncError(err);
    if (json) env.io.stdout(`${JSON.stringify({ ok: false, error: { code: e.code, message: e.message } })}\n`);
    else env.io.stderr(`atpsync: ${e.message}\n`);
    return EXIT_CODES[e.code];
  }
}
