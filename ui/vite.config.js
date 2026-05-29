import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    svelte(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      manifest: {
        name: 'Companion Planning',
        short_name: 'Companion',
        description: 'Private, local-first, MCP-native personal todo app',
        theme_color: '#0f1115',
        background_color: '#0f1115',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/?source=pwa',
        categories: ['productivity'],
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          { name: 'Today', url: '/#today' },
          { name: 'Capacity', url: '/#capacity' },
          { name: 'Review', url: '/#review' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        // Take control of open clients as soon as a new SW activates — this is
        // what prevents the stale-shell problem (old nav after a deploy).
        clientsClaim: true,
        skipWaiting: true,
        cleanupOutdatedCaches: true,
        // Offline SPA routing: serve the cached app shell for navigations,
        // except API/MCP/SSE which must hit the network.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/mcp/],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname === '/api/file',
            handler: 'NetworkFirst',
            options: { cacheName: 'cp-files-v1', expiration: { maxEntries: 60, maxAgeSeconds: 86400 } },
          },
          {
            // Live endpoints must never be served stale.
            urlPattern: ({ url }) => ['/api/events', '/api/reminders'].includes(url.pathname) || url.pathname.startsWith('/mcp'),
            handler: 'NetworkOnly',
          },
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
            handler: 'NetworkFirst',
            options: { cacheName: 'cp-api-v1', expiration: { maxEntries: 30, maxAgeSeconds: 3600 } },
          },
        ],
      },
    }),
  ],
  base: '/',
  build: {
    outDir: '../public',
    emptyOutDir: false,  // preserve icons/ and other static assets
    sourcemap: false,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3847',
    },
  },
});
