import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Types-only package: tests of src/obsidian/* run against a small runtime stub.
      obsidian: fileURLToPath(new URL('./tests/obsidian/obsidian-stub.ts', import.meta.url)),
    },
  },
});
