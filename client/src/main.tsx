import { render } from 'solid-js/web';
import { App } from './App.js';
import { applyTheme, theme } from './lib/theme.js';
import './index.css';

// Keep <html> in sync with the persisted theme. The inline script in index.html
// sets the initial class pre-render (no flash); this reconciles the signal state.
applyTheme(theme());

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');
render(() => <App />, root);
