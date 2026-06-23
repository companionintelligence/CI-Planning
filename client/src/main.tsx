import { render } from 'solid-js/web';
import { App } from './App.js';
import { applyTheme, theme } from './lib/theme.js';
import { registerSW } from './sw/register.js';
import './index.css';

// Keep <html> in sync with the persisted theme. The inline script in index.html
// sets the initial class pre-render (no flash); this reconciles the signal state.
applyTheme(theme());

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');
render(() => <App />, root);

// Additive: register the service worker (Web Push, Phase H). Never throws; the app
// is already mounted above, so a failure here can't affect rendering.
void registerSW();
