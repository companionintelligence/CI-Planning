import { render } from 'solid-js/web';
import { App } from './App.js';
import './index.css';

const savedTheme = localStorage.getItem('theme') || 'dark';
if (savedTheme === 'light') {
  document.documentElement.classList.add('light');
} else {
  document.documentElement.classList.add('dark');
}

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');
render(() => <App />, root);
