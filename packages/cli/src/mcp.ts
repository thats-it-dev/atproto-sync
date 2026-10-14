/** MCP server over stdio exposing the same command functions as the CLI. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { CommandDeps } from './commands/context';
import { startCommand, stopCommand, type StartDeps } from './commands/daemon-control';
import { publishCommand } from './commands/publish';
import { statusCommand } from './commands/status';
import { syncCommand } from './commands/sync';
import { toAtpsyncError } from './errors';
import { renderPublish, renderStatus, renderSync } from './render';
import { VERSION } from './version';

export const MCP_INSTRUCTIONS =
  'atpsync keeps a local vault folder in sync with the user\'s ATProto PDS (end-to-end encrypted). ' +
  'When the atpsync daemon is running it syncs edits automatically: just edit files in the vault. ' +
  'Call atpsync_sync only when a sync must happen right now, and atpsync_status to check the vault and daemon.';

type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

async function respond<T extends object>(fn: () => Promise<T>, render: (r: T) => string): Promise<ToolResult> {
  try {
    const r = await fn();
    return { content: [{ type: 'text', text: render(r) }], structuredContent: r as unknown as Record<string, unknown> };
  } catch (err) {
    const e = toAtpsyncError(err);
    return {
      content: [{ type: 'text', text: `${e.code}: ${e.message}` }],
      structuredContent: { ok: false, error: { code: e.code, message: e.message } },
      isError: true,
    };
  }
}

export function createMcpServer(deps: CommandDeps, ctl: StartDeps): McpServer {
  const server = new McpServer({ name: 'atpsync', version: VERSION }, { instructions: MCP_INSTRUCTIONS });

  server.registerTool(
    'atpsync_status',
    {
      description:
        'Show atpsync state: account, vault, local vs remote note/attachment counts, last sync time, and whether the background daemon is running.',
      annotations: { readOnlyHint: true },
    },
    () => respond(() => statusCommand(deps), renderStatus)
  );

  server.registerTool(
    'atpsync_sync',
    {
      description:
        'Sync the vault folder with the PDS now (E2E-encrypted, bidirectional). Usually unnecessary while the daemon runs; use it when a sync must happen immediately.',
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    () => respond(() => syncCommand(deps), renderSync)
  );

  server.registerTool(
    'atpsync_publish',
    {
      description:
        'Mark a vault note as public (plaintext on the PDS, addressable by slug) and sync. Public notes and the attachments they embed become visible to anyone with the link.',
      inputSchema: {
        path: z.string().describe('Vault-relative path of the markdown note, e.g. "blog/my-post.md".'),
        slug: z.string().optional().describe('Public URL slug. Defaults to the note title.'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    ({ path, slug }) => respond(() => publishCommand(deps, { path, slug, makePublic: true }), renderPublish)
  );

  server.registerTool(
    'atpsync_unpublish',
    {
      description: 'Mark a public vault note private again (re-encrypted, key rotated) and sync.',
      inputSchema: { path: z.string().describe('Vault-relative path of the markdown note to unpublish.') },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    ({ path }) => respond(() => publishCommand(deps, { path, makePublic: false }), renderPublish)
  );

  server.registerTool(
    'atpsync_daemon',
    {
      description: 'Start or stop the atpsync background daemon that keeps the vault synced automatically.',
      inputSchema: { action: z.enum(['start', 'stop']) },
      annotations: { readOnlyHint: false },
    },
    ({ action }) =>
      action === 'start'
        ? respond(() => startCommand(deps, ctl), (r) => `atpsync daemon started (pid ${r.pid}).`)
        : respond(() => stopCommand(), (r) => (r.wasRunning ? `atpsync daemon stopped (pid ${r.pid}).` : 'atpsync daemon is not running.'))
  );

  return server;
}

export async function runMcp(deps: CommandDeps, ctl: StartDeps): Promise<void> {
  await createMcpServer(deps, ctl).connect(new StdioServerTransport());
}
