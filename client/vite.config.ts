import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

// Parse a positive-integer env var, falling back when it's unset, blank, or non-numeric
// (e.g. "abc", "5173 ") — a NaN port would break Vite startup.
function portFromEnv(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// Hostnames Vite will answer to, comma-separated (VITE_ALLOWED_HOSTS). Vite rejects
// requests whose Host header it doesn't recognise (DNS-rebinding protection), which
// blocks reaching a dev server by name — e.g. a Tailscale MagicDNS host. Bare IPs are
// always allowed, so this is only needed for named access. Unset ⇒ localhost only.
function allowedHostsFromEnv(value: string | undefined): string[] | undefined {
  const hosts = (value ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  return hosts.length > 0 ? hosts : undefined;
}

export default defineConfig({
  plugins: [solid()],
  server: {
    port: portFromEnv(process.env.VITE_PORT, 5173),
    allowedHosts: allowedHostsFromEnv(process.env.VITE_ALLOWED_HOSTS),
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
