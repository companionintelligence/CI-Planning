import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor config for the iOS shell of Companion Planning.
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
  ios: {
    // Lay the page out inside the safe area. The default ('never') runs the web view under
    // the status bar / Dynamic Island and the home indicator, and the app's header and
    // bottom bar do not pad for them (client/index.html has no viewport-fit=cover).
    contentInset: 'always',
    // What shows in the inset strips and when over-scrolling: the app's dark theme colour
    // (the same #041620 as client/index.html's theme-color).
    backgroundColor: '#041620',
  },
  plugins: {
    // Send fetch / XHR through the native HTTP stack (URLSession) instead of WKWebView's.
    // The page origin is capacitor://localhost, so a call to the user's server is
    // cross-origin and WKWebView would enforce CORS on it — and a self-hosted server
    // allows no foreign origin by default (CORS_ALLOWED_ORIGINS is empty). Native HTTP
    // is not subject to CORS, and keeps the session cookie in the native cookie jar.
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
