import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

// Parse a positive-integer env var, falling back when it's unset, blank, or non-numeric
// (e.g. "abc", "5173 ") — a NaN port would break Vite startup.
function portFromEnv(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export default defineConfig({
  plugins: [solid()],
  server: {
    port: portFromEnv(process.env.VITE_PORT, 5173),
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://localhost:3848',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../server/public',
    emptyOutDir: true,
  },
});
