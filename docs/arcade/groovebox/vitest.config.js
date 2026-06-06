import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  // Resolve the bare `import 'tone'` to the prebundled vendor file, mirroring the
  // browser importmap (index.html). The published `tone` npm package ships an ESM
  // build with extensionless internal specifiers that Vite's resolver rejects.
  resolve: {
    alias: { tone: fileURLToPath(new URL('./vendor/tone.js', import.meta.url)) },
  },
  test: { environment: 'node', include: ['tests/**/*.test.js'] },
});
