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
    // Pinch-to-zoom stays on: WCAG 1.4.4. Capacitor's default is OFF, and it is independent
    // of the page's viewport tag (client/index.html carries no maximum-scale), so both have
    // to allow it. Fields stay at 16px or more on touch devices (client/src/index.css), so
    // focusing one does not zoom the page.
    zoomEnabled: true,
    // The oldest WebView the bundle can run on: Vite 8 builds for Chrome 111 / Safari 16.4
    // by default, and Tailwind 4 (cascade layers, @property, color-mix, oklch) needs the
    // same. Capacitor's own floor is 60. Below this number Capacitor writes to Logcat and,
    // unless server.errorPath is set (below), loads the app anyway, which on a WebView that
    // cannot read its CSS opens unstyled and broken. Lowering the build target instead is not
    // an option: Tailwind 4's CSS cannot be downleveled. minSdk (24) stays: the WebView
    // updates through Google Play independently of the OS, so a phone that old can still
    // meet this floor.
    minWebViewVersion: 111,
    // No allowMixedContent. The page is https://localhost and the user's server is often
    // plain http on their LAN, but nothing here loads http from the page: fetch and XHR
    // go through native HTTP (CapacitorHttp below), which mixed-content rules do not cover,
    // and live updates poll through the same stack (lib/live-poll.ts) rather than holding
    // an EventSource, which stays in the WebView and would have been blocked. Capacitor
    // marks the setting as not for production.
  },
  server: {
    // Serve the bundle from https://localhost (the default since Capacitor 6, stated so
    // it cannot drift): a secure context for the page, and a stable origin to name in a
    // server's CORS_ALLOWED_ORIGINS should an operator want one.
    androidScheme: 'https',
    // What shows instead of the app when the WebView is below minWebViewVersion (and when
    // the app's own page fails to load): client/public/cannot-start.html, which says to
    // update Android System WebView. Without it the floor above only reaches Logcat.
    errorPath: 'cannot-start.html',
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
