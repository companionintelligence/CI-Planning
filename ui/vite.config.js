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
        scope: '/v2/',
        start_url: '/v2/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname === '/api/file',
            handler: 'NetworkFirst',
            options: { cacheName: 'cp-files-v1', expiration: { maxEntries: 60, maxAgeSeconds: 86400 } },
          },
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/api/') && url.pathname !== '/api/events',
            handler: 'NetworkFirst',
            options: { cacheName: 'cp-api-v1', expiration: { maxEntries: 30, maxAgeSeconds: 3600 } },
          },
        ],
      },
    }),
  ],
  base: '/v2/',
  build: {
    outDir: '../public/v2',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3847',
    },
  },
});
