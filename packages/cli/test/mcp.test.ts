import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FakePds } from '@atproto-sync/core/sync/fake-pds';
import { DEFAULT_CONFIG, saveConfig, type AtpsyncConfig } from '../src/config';
import { createMcpServer } from '../src/mcp';
import { clearAtpsyncEnv, configuredCfg, tempEnv } from './helpers';

afterEach(clearAtpsyncEnv);

async function connected(cfg: AtpsyncConfig, pds = new FakePds()) {
  const server = createMcpServer(
    {
      loadConfig: async () => cfg,
      connect: async () => ({ pds, did: 'did:plc:me', pdsUrl: 'http://fake' }),
      lock: { wait: true, timeoutMs: 1000 },
    },
    { execPath: process.execPath, cliPath: '/nonexistent' }
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  return client;
}

describe('MCP server', () => {
  it('lists the five tools and tells agents the daemon syncs automatically', async () => {
    await tempEnv();
    const client = await connected({ ...DEFAULT_CONFIG });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'atpsync_daemon', 'atpsync_publish', 'atpsync_status', 'atpsync_sync', 'atpsync_unpublish',
    ]);
    expect(tools.find((t) => t.name === 'atpsync_status')?.annotations?.readOnlyHint).toBe(true);
    expect(client.getInstructions()).toMatch(/automatically/);
  });

  it('returns structured results and text', async () => {
    const { vaultDir } = await tempEnv();
    const cfg = await configuredCfg(vaultDir);
    await saveConfig(cfg);
    const pds = new FakePds();
    await fs.writeFile(path.join(vaultDir, 'post.md'), 'hello world');
    const client = await connected(cfg, pds);

    const pub = await client.callTool({ name: 'atpsync_publish', arguments: { path: 'post.md', slug: 'hi' } });
    expect(pub.isError).toBeFalsy();
    expect(pub.structuredContent).toMatchObject({ ok: true, published: true, changed: true });
    expect(JSON.stringify(pub.content)).toMatch(/now public/);

    const st = await client.callTool({ name: 'atpsync_status', arguments: {} });
    expect(st.structuredContent).toMatchObject({ ok: true, localNotes: 1, daemon: { running: false } });
    expect(JSON.stringify(st)).not.toContain(cfg.appPassword);
  });

  it('reports errors with their code', async () => {
    await tempEnv();
    const client = await connected({ ...DEFAULT_CONFIG });
    const r = await client.callTool({ name: 'atpsync_sync', arguments: {} });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ ok: false, error: { code: 'NOT_CONFIGURED' } });
  });
});
