import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor config for the Android shell of Companion Planning.
 *
 * The app ships the `client/` Vite build (webDir) and is a thin client of a CI-Planning
 * server the user runs themselves. Build the bundle with `pnpm build:web` (which runs
 * `client`'s `build:mobile`, output `client/dist`) before `cap sync`.
 *
 * Nothing about the server is configured here: the bundle asks for its address on first
 * run and keeps it on the device (client/src/lib/server-config.ts).
 */
const config: CapacitorConfig = {
  appId: 'com.companionintelligence.planning',
  appName: 'Companion Planning',
  webDir: '../../client/dist',
  android: {
    // The WebView's own background (shown before first paint and when over-scrolling): the
    // app's dark theme colour, the same #041620 as client/index.html's theme-color.
    backgroundColor: '#041620',
    // The page is https://localhost; the user's server is often plain http on their LAN. fetch
    // and XHR avoid the mixed-content rule by going through native HTTP (CapacitorHttp below),
    // but the live-update stream is an EventSource, which stays in the WebView and would be
    // blocked outright. Only the bundled, local page runs here, and it loads nothing else
    // over http.
    allowMixedContent: true,
  },
  server: {
    // Serve the bundle from https://localhost (the default since Capacitor 6, stated so
    // it cannot drift): a secure context for the page, and a stable origin to name in a
    // server's CORS_ALLOWED_ORIGINS should an operator want one.
    androidScheme: 'https',
  },
  plugins: {
    // Light status/navigation-bar glyphs. The bars sit over the dark window background set in
    // res/values/styles.xml, and "DARK" in Capacitor's vocabulary means light content on a
    // dark background. The default follows the phone's light/dark setting, which on a
    // light-mode phone paints dark clock and battery icons onto the dark app: invisible.
    SystemBars: {
      style: 'DARK',
    },
    // Send fetch / XHR through the native HTTP stack instead of the WebView's. The page
    // origin is https://localhost, so a call to the user's server is cross-origin and the
    // WebView would enforce CORS on it (and block plain-http targets as mixed content) —
    // and a self-hosted server allows no foreign origin by default (CORS_ALLOWED_ORIGINS
    // is empty). Native HTTP is not subject to either, and keeps the session cookie in
    // the native cookie jar.
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
