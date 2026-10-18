import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export default defineConfig({
  resolve: { preserveSymlinks: true },
  plugins: [{
    name: 'offline-shell',
    generateBundle(_options, bundle) {
      const source = readFileSync('src/web/service-worker.js', 'utf8');
      const version = createHash('sha256').update(source + Object.values(bundle).map(item => item.type === 'chunk' ? item.code : String(item.source)).join('')).digest('hex').slice(0, 16);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: source.replace('__BUILD_ID__', version) });
    },
  }],
  test: { include: ['web-test/**/*.test.ts'], environment: 'node' },
});
