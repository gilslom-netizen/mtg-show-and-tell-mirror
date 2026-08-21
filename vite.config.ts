import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * Serves /api from the dev and preview servers, in-process.
 *
 * Without this, `npm run dev` had no API at all: the client's probe fell through
 * to a WebSocket server that is not running, and two tabs sat on "waiting for the
 * other player" forever. Dev now runs the same handlers Vercel runs, so online
 * play works with one command and on one code path.
 */
function devApi(): Plugin {
  const middleware = async (req: never, res: never, next: () => void): Promise<void> => {
    const { handleApiRequest } = await import('./src/server/node-api');
    if (!(await handleApiRequest(req, res))) next();
  };
  return {
    name: 'show-and-tell-dev-api',
    configureServer(server) {
      server.middlewares.use(middleware as never);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware as never);
    },
  };
}

export default defineConfig({
  plugins: [react(), devApi()],
  resolve: {
    alias: {
      '@engine': fileURLToPath(new URL('./src/engine', import.meta.url)),
      '@protocol': fileURLToPath(new URL('./src/protocol', import.meta.url)),
      '@client': fileURLToPath(new URL('./src/client', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // Only used when someone deliberately runs the socket server alongside dev.
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
} as never);
