import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: 'dist/atpsync.cjs',
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
});
