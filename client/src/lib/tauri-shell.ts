/**
 * Whether this page runs inside the Tauri desktop shell (`desktop/`). Tauri puts its internals on
 * the global object and a browser never does, so the web app is unchanged. Kept in its own module
 * so server-config.ts and the desktop cache can both ask without importing each other.
 */
export function isTauriShell(): boolean {
  try {
    return '__TAURI_INTERNALS__' in globalThis;
  } catch {
    return false;
  }
}
