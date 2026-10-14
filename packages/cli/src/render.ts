/** Human-readable renderings of command results (the --json form is the raw object). */
import type { PublishResult } from './commands/publish';
import type { StatusResult } from './commands/status';
import type { SyncSummary } from './session';

export function renderSync(r: SyncSummary): string {
  const lines = [`Sync complete: ${r.opsExecuted} operation(s) at ${r.lastSyncAt}.`];
  if (r.warnings.length) {
    lines.push('Warnings:');
    for (const w of r.warnings) lines.push(`  - ${w}`);
  }
  if (r.skippedPaths.length) lines.push(`Skipped (too large for PDS): ${r.skippedPaths.join(', ')}`);
  return lines.join('\n');
}

export function renderStatus(r: StatusResult): string {
  const d = r.daemon;
  const daemon = d.running
    ? `running (pid ${d.pid}, ${d.connection ?? 'starting'})${d.lastError ? ` — last error: ${d.lastError}` : ''}`
    : `not running${d.lastExit ? ` (last exit: ${d.lastExit})` : ''}`;
  const remote = r.remote
    ? `${r.remote.notes} notes · ${r.remote.attachments} attachments`
    : `unavailable (${r.remoteError ?? 'unknown error'})`;
  return [
    `atpsync: ${r.vaultName ?? '(unknown vault)'} (${r.vaultRkey})`,
    `  account: ${r.identifier} @ ${r.pdsUrl ?? '(resolved from handle)'}`,
    `  vault dir: ${r.vaultDir}`,
    `  local: ${r.localNotes} notes`,
    `  remote: ${remote}`,
    `  last sync: ${d.lastSyncAt ?? r.lastSyncAt ?? 'never'}`,
    `  daemon: ${daemon}`,
  ].join('\n');
}

export function renderPublish(r: PublishResult): string {
  return r.sync ? `${r.message}\n${renderSync(r.sync)}` : r.message;
}
