// Bundles the server (including the shared game engine) into dist/index.js, and the bug report
// export (dist/export-reports.js). npm packages stay external and are installed in the runtime image.
import { build } from 'esbuild';

await build({
  entryPoints: { index: 'src/index.ts', 'export-reports': 'src/exportReports.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  tsconfig: 'tsconfig.json',
  logLevel: 'info',
});
