/**
 * Puts the desktop shell's fetch in place. main.tsx imports this before anything else in the app,
 * because the stores start their requests as their modules load, and a request made before this
 * runs goes straight from the web view, where the content-security policy refuses it. Outside the
 * shell this does nothing.
 */
import { installTauriShell } from './lib/desktop-shell.js';

installTauriShell();
