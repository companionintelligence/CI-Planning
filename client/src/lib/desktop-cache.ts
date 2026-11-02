/**
 * The desktop shell's offline cache as the client sees it: three commands on the Rust side
 * (`desktop/src-tauri/src/cache.rs`). Outside the Tauri shell every call does nothing, and a cache
 * failure is never allowed to fail the request it was meant to help. The Tauri API is imported
 * only when it is needed, so the web bundle does not carry it.
 */

import { isTauriShell } from './tauri-shell.js';

async function command<T>(name: string, args?: Record<string, string>): Promise<T | undefined> {
  if (!isTauriShell()) return undefined;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<T>(name, args);
  } catch {
    return undefined;
  }
}

/** Keep the body of a read under its full URL. */
export async function cachePut(key: string, body: string): Promise<void> {
  await command('cache_put', { key, body });
}

/** The body kept for a read, or null when there is none. */
export async function cacheGet(key: string): Promise<string | null> {
  return (await command<string | null>('cache_get', { key })) ?? null;
}

/** Forget every kept read: on sign-in, on sign-out and when the server changes. */
export async function cacheClear(): Promise<void> {
  await command('cache_clear');
}
