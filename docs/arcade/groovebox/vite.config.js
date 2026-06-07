import { defineConfig } from 'vite';

// Dev-only: the share registry lives on the production worker — proxy API
// calls there so /?s=<id> links load real registry items on localhost.
export default defineConfig({
  server: {
    proxy: {
      '/api': { target: 'https://groovebox.oyster.to', changeOrigin: true },
    },
  },
});
