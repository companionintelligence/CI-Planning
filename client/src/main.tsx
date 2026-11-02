import { render } from 'solid-js/web';
import { App } from './App.js';
import { applyTheme, theme } from './lib/theme.js';
import { registerSW } from './sw/register.js';
import { initTelemetry } from './lib/telemetry.js';
import './index.css';
// Manrope is bundled, not fetched from Google Fonts, so the app makes no third-party requests.
import '@fontsource/manrope/200.css';
import '@fontsource/manrope/400.css';
import '@fontsource/manrope/500.css';
import '@fontsource/manrope/600.css';
import '@fontsource/manrope/700.css';

// Error reporting — opt-out, on by default once configured: reports when
// VITE_SENTRY_DSN was baked in at BUILD time *and* the server confirms reporting has
// not been switched off. Inert without either
// (docs/operations/error-reporting.md). Started first so it races the initial mount
// rather than following it, but deliberately NOT awaited: first paint must not wait on
// a network round trip, and initTelemetry never rejects.
void initTelemetry();

// Keep <html> in sync with the persisted theme. The inline script in index.html
// sets the initial class pre-render (no flash); this reconciles the signal state.
applyTheme(theme());

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');
render(() => <App />, root);

// Additive: register the service worker (Web Push, Phase H). Never throws; the app
// is already mounted above, so a failure here can't affect rendering.
void registerSW();
