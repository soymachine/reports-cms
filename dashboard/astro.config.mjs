import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwind from '@astrojs/tailwind';
import node from '@astrojs/node';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [react(), tailwind()],
  vite: {
    resolve: {
      alias: { '@': path.resolve(__dirname, 'src') },
      dedupe: ['react', 'react-dom'],
    },
    ssr: {
      external: ['better-sqlite3'],
    },
  },
});
