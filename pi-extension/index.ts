/**
 * ATProto Sync pi extension: sync an Obsidian-style vault directory to an ATProto
 * PDS using the same engine, crypto and record layout as the Obsidian
 * plugin. Provides slash commands for the human and tools for the model.
 *
 * Commands:  /atpsync [setup|status|sync|publish|unpublish|watch|logout|help]
 * Tools:     atpsync_status, atpsync_sync, atpsync_publish, atpsync_unpublish, atpsync_watch
 */
import { Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { isIgnored } from '../src/obsidian/ignore';
import { boundVaultDir, configPath, isConfigured, loadConfig, saveConfig, type AtpsyncConfig } from './config';
import { clearPdsCache, formatSummary, getVaultStatus, runSync, togglePublic } from './session';
import { runSetup } from './setup';
import { VaultWatcher } from './watcher';

let watcher: VaultWatcher | null = null;

function notConfigured(): string {
  return (
    `ATProto Sync is not configured on this machine (no ${configPath()} with handle, app password, vault and master key). ` +
    'Ask the user to run /atpsync setup first.'
  );
}

function textResult(text: string, details: unknown = undefined, isError = false) {
  return { content: [{ type: 'text' as const, text }], details, isError };
}

function errorText(prefix: string, err: unknown): string {
  return `${prefix}: ${(err as Error).message}`;
}

/** Start the background watcher for the bound vault (idempotent). */
function startWatcher(cfg: AtpsyncConfig, ctx: ExtensionContext): string {
  const vaultDir = boundVaultDir(cfg);
  if (!watcher?.isRunning) {
    watcher?.stop();
    watcher = new VaultWatcher(
      vaultDir,
      async () => {
        const fresh = await loadConfig();
        await runSync(fresh, ctx.cwd);
      },
      {
        intervalMs: (cfg.syncIntervalMinutes || 5) * 60_000,
        // Drop events for ignored paths; the engine writes <vault>/.atpsync/ every sync.
        ignore: (rel) => isIgnored(rel, cfg.ignorePatterns),
      }
    );
    watcher.start();
  }
  ctx.ui.setStatus('atpsync', `watching ${vaultDir}`);
  return vaultDir;
}

function stopWatcher(ctx: ExtensionContext): string | null {
  const dir = watcher?.isRunning ? watcher.root : null;
  watcher?.stop();
  watcher = null;
  ctx.ui.setStatus('atpsync', undefined);
  return dir;
}

function statusLines(st: Awaited<ReturnType<typeof getVaultStatus>>): string[] {
  return [
    `ATProto Sync: ${st.vaultName ?? '(unknown vault)'} (${st.vaultRkey})`,
    `  account: ${st.identifier} @ ${st.pdsUrl}`,
    `  vault dir: ${st.vaultDir}`,
    `  local notes: ${st.localNotes} · remote notes: ${st.remoteNotes} · remote attachments: ${st.remoteAttachments}`,
    `  last sync: ${st.lastSyncAt ?? 'never'}`,
    `  watcher: ${watcher?.isRunning ? 'on' : 'off'}`,
  ];
}

export default function (pi: ExtensionAPI) {
  const syncTool: ToolDefinition<ReturnType<typeof syncParams>> = {
    name: 'atpsync_sync',
    label: 'ATProto Sync Sync',
    description:
      'Sync the bound ATProto Sync vault directory with the ATProto PDS (E2E-encrypted, bidirectional). ' +
      'Run this after the user edited/added/deleted vault files and wants them synced, or before they leave.',
    parameters: syncParams(),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cfg = await loadConfig();
      if (!isConfigured(cfg)) return textResult(notConfigured(), undefined, true);
      try {
        const summary = await runSync(cfg, ctx.cwd, params.vaultDir ? { vaultDir: params.vaultDir } : {});
        return textResult(formatSummary(summary), summary);
      } catch (err) {
        return textResult(errorText('ATProto Sync sync failed', err), { ok: false, error: (err as Error).message }, true);
      }
    },
  };

  const statusTool: ToolDefinition<ReturnType<typeof emptyParams>> = {
    name: 'atpsync_status',
    label: 'ATProto Sync Status',
    description:
      'Show ATProto Sync sync state: account, vault name, local vs remote note/attachment counts, last sync time, and whether the watcher is running.',
    parameters: emptyParams(),
    annotations: { readOnlyHint: true },
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const cfg = await loadConfig();
      if (!isConfigured(cfg)) return textResult(notConfigured(), undefined, true);
      try {
        const st = await getVaultStatus(cfg, ctx.cwd);
        return textResult(statusLines(st).join('\n'), { ...st, watching: watcher?.isRunning ?? false });
      } catch (err) {
        return textResult(errorText('ATProto Sync status failed', err), { error: (err as Error).message }, true);
      }
    },
  };

  const publishTool: ToolDefinition<ReturnType<typeof publishParams>> = {
    name: 'atpsync_publish',
    label: 'ATProto Sync Publish',
    description:
      'Mark a vault note as public (plaintext on the PDS, addressable by slug) and sync. ' +
      'Public notes and the attachments they embed become visible to anyone with the link.',
    parameters: publishParams(),
    annotations: { readOnlyHint: false, openWorldHint: true },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cfg = await loadConfig();
      if (!isConfigured(cfg)) return textResult(notConfigured(), undefined, true);
      try {
        const msg = await togglePublic(cfg, ctx.cwd, params.path, true, params.slug);
        return textResult(msg, { path: params.path, published: true });
      } catch (err) {
        return textResult(errorText('Publish failed', err), undefined, true);
      }
    },
  };

  const unpublishTool: ToolDefinition<ReturnType<typeof unpublishParams>> = {
    name: 'atpsync_unpublish',
    label: 'ATProto Sync Unpublish',
    description: 'Mark a public vault note private again (re-encrypted, key rotated) and sync.',
    parameters: unpublishParams(),
    annotations: { readOnlyHint: false, openWorldHint: true },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cfg = await loadConfig();
      if (!isConfigured(cfg)) return textResult(notConfigured(), undefined, true);
      try {
        const msg = await togglePublic(cfg, ctx.cwd, params.path, false);
        return textResult(msg, { path: params.path, published: false });
      } catch (err) {
        return textResult(errorText('Unpublish failed', err), undefined, true);
      }
    },
  };

  const watchTool: ToolDefinition<ReturnType<typeof watchParams>> = {
    name: 'atpsync_watch',
    label: 'ATProto Sync Watch',
    description:
      'Start or stop background auto-sync of the ATProto Sync vault (file changes + periodic interval). ' +
      'The watcher lives only for the duration of this pi session.',
    parameters: watchParams(),
    annotations: { readOnlyHint: false },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (params.enabled) {
        const cfg = await loadConfig();
        if (!isConfigured(cfg)) return textResult(notConfigured(), undefined, true);
        if (watcher?.isRunning) {
          return textResult(`Watcher is already running for ${watcher.root}.`, { watching: true });
        }
        try {
          const vaultDir = startWatcher(cfg, ctx);
          return textResult(
            `ATProto Sync watcher started for ${vaultDir} (file changes + every ${cfg.syncIntervalMinutes} min).`,
            { watching: true, vaultDir }
          );
        } catch (err) {
          return textResult(errorText('Could not start watcher', err), undefined, true);
        }
      }
      const dir = stopWatcher(ctx);
      return dir
        ? textResult(`ATProto Sync watcher stopped (was watching ${dir}).`, { watching: false })
        : textResult('ATProto Sync watcher is not running.', { watching: false });
    },
  };

  pi.registerTool(syncTool);
  pi.registerTool(statusTool);
  pi.registerTool(publishTool);
  pi.registerTool(unpublishTool);
  pi.registerTool(watchTool);

  pi.registerCommand('atpsync', {
    description: 'ATProto Sync vault sync: /atpsync [setup [folder]|status|sync|publish <path> [slug]|unpublish <path>|watch [on|off]|logout|help]',
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const cmd = parts[0]?.toLowerCase() ?? 'help';
      try {
        switch (cmd) {
          case '':
          case 'help':
          case 'h': {
            ctx.ui.notify([
              'ATProto Sync usage:',
              '  /atpsync setup [folder]   one-time login + vault folder + passphrase (default: prompt)',
              '  /atpsync status           account, vault, counts, watcher',
              '  /atpsync sync             sync now',
              '  /atpsync publish <path> [slug]',
              '  /atpsync unpublish <path>',
              '  /atpsync watch [on|off]   background auto-sync',
              '  /atpsync logout           clear stored credentials',
            ].join('\n'), 'info');
            return;
          }
          case 'sync': {
            const cfg = await loadConfig();
            if (!isConfigured(cfg)) throw new Error(notConfigured());
            ctx.ui.notify('ATProto Sync: syncing…');
            const summary = await runSync(cfg, ctx.cwd);
            ctx.ui.notify(formatSummary(summary), summary.warnings.length ? 'warning' : 'info');
            return;
          }
          case 'status': {
            const cfg = await loadConfig();
            if (!isConfigured(cfg)) {
              ctx.ui.notify(notConfigured(), 'warning');
              return;
            }
            const st = await getVaultStatus(cfg, ctx.cwd);
            ctx.ui.notify(statusLines(st).join('\n'), 'info');
            return;
          }
          case 'publish':
          case 'unpublish': {
            const rel = parts[1];
            if (!rel) throw new Error('usage: /atpsync ' + cmd + ' <path> [slug]');
            const cfg = await loadConfig();
            if (!isConfigured(cfg)) throw new Error(notConfigured());
            const msg = await togglePublic(cfg, ctx.cwd, rel, cmd === 'publish', parts[2]);
            ctx.ui.notify(msg, 'info');
            return;
          }
          case 'watch': {
            const arg = parts[1]?.toLowerCase() ?? 'toggle';
            const wantOn = arg === 'on' ? true : arg === 'off' ? false : !(watcher?.isRunning);
            if (wantOn) {
              const cfg = await loadConfig();
              if (!isConfigured(cfg)) throw new Error(notConfigured());
              const vaultDir = startWatcher(cfg, ctx);
              ctx.ui.notify(`ATProto Sync watcher: on (${vaultDir})`, 'info');
            } else {
              stopWatcher(ctx);
              ctx.ui.notify('ATProto Sync watcher: off', 'info');
            }
            return;
          }
          case 'logout': {
            const cfg = await loadConfig();
            if (!(await ctx.ui.confirm('Log out of ATProto Sync?', 'This removes the stored app password and cached master key from this machine. Your PDS data is unaffected.'))) return;
            clearPdsCache();
            stopWatcher(ctx);
            await saveConfig({ ...cfg, appPassword: '', masterKeyB64: '' });
            ctx.ui.notify('ATProto Sync: logged out. Run /atpsync setup to sign back in.', 'info');
            return;
          }
          case 'setup':
            await runSetup({
              cwd: ctx.cwd,
              hasUI: ctx.hasUI,
              vaultDir: parts.slice(1).join(' ') || undefined,
              input: (title, placeholder) => ctx.ui.input(title, placeholder),
              select: (title, options) => ctx.ui.select(title, options),
              notify: (m, t) => ctx.ui.notify(m, t),
            });
            clearPdsCache();
            return;
          default:
            throw new Error(`Unknown subcommand "${cmd}". Try /atpsync help.`);
        }
      } catch (err) {
        ctx.ui.notify(errorText('ATProto Sync error', err), 'error');
      }
    },
  });

  pi.on('session_shutdown', () => {
    watcher?.stop();
    watcher = null;
  });
}

function emptyParams() {
  return Type.Object({});
}
function syncParams() {
  return Type.Object({
    vaultDir: Type.Optional(
      Type.String({ description: 'Vault directory. Defaults to the vault bound by /atpsync setup.' })
    ),
  });
}
function publishParams() {
  return Type.Object({
    path: Type.String({ description: 'Vault-relative path of the markdown note, e.g. "blog/my-post.md".' }),
    slug: Type.Optional(Type.String({ description: 'Public URL slug. Defaults to the note title.' })),
  });
}
function unpublishParams() {
  return Type.Object({
    path: Type.String({ description: 'Vault-relative path of the markdown note to unpublish.' }),
  });
}
function watchParams() {
  return Type.Object({
    enabled: Type.Boolean({ description: 'true to start watching, false to stop.' }),
  });
}
