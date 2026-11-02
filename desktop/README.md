# Companion Planning desktop

The desktop app for Companion Planning, built with Tauri 2. It is the web client bundled into a native app for macOS, Windows and Linux. It keeps the last data it saw for when the server cannot be reached, and it sends its requests to the server you choose.

## How it works

- **The client is bundled.** The window loads `client/dist`, the same build the phone shells use (`pnpm --filter client build:mobile`). Nothing is loaded from the network to start.
- **Requests go through the native HTTP plugin.** The app's own pages are served from inside the app, so a request to the user's server is cross-origin, and a self-hosted server allows no foreign origin by default. `client/src/lib/desktop-shell.ts` sends every http(s) request through `@tauri-apps/plugin-http`, which is not subject to CORS and keeps the session cookie in its own jar, persisted between launches. The phone shells use Capacitor's native HTTP for the same reason. No server change is needed for it.
- **Offline reads.** Reads are kept in a local SQLite database, `offline-cache.sqlite` in the app's data folder (`src-tauri/src/cache.rs`). When a read cannot reach the server, the last answer is returned, marked with the response header `x-offline-cache: 1`. The sync cursor and the session are never kept. If the cache file cannot be opened (damaged, or its folder is not writable), the app keeps the cache in memory for that session instead of failing to start.
- **Offline writes.** Writes are not cached. They go through the client's existing offline op-log (`client/src/lib/oplog.ts`), which holds them until the server answers.
- **The cache is cleared** on a successful sign-in or sign-out, and when the server changes, so one person's data is never shown to the next.
- **Live updates** use polling, as in the phone shells.
- **Hidden in the app:** the controls the shells cannot run (JSON export, the calendar export, the push-notification switch, creating accounts, invite codes), and the Companion Portal and Google sign-in buttons, which need a redirect. All of this follows `isNativeShell()`, which is true in the desktop app.

## Sign-in

The chosen approach is the system browser, as Companion Memory's desktop does it: the app opens the server's sign-in page in the default browser with PKCE, and the server hands a one-time code back through a `companion-planning://` link. That needs a native code-exchange endpoint on the server, which this change does not add. Until it exists, the desktop app signs in with a username and password, the same as the phone shells. Google refuses sign-in from embedded web views, so Google sign-in waits for the system-browser flow.

## Build and run

You need Node 22 or newer, pnpm 11, Rust 1.90 or newer (install it with `rustup`), and on macOS the Xcode command line tools. From the repo root:

```bash
pnpm install --frozen-lockfile
pnpm --filter client build:mobile                              # the bundle the app ships (client/dist)
pnpm --filter desktop dev                                      # run the app (tauri dev)
pnpm --filter desktop build                                    # release bundles (tauri build; builds the client first)
pnpm --filter desktop exec tauri build --debug --bundles app   # an unsigned debug .app
cargo test --manifest-path desktop/src-tauri/Cargo.toml        # needs client/dist to exist first
```

The bundles are not code-signed or notarised, so a bundle copied to another Mac needs the usual Gatekeeper approval.

## CI

`.github/workflows/desktop-build.yml` builds the macOS, Windows and Linux bundles. It is manual only (`gh workflow run desktop-build.yml --repo companionintelligence/CI-Planning --ref <branch>`), and it publishes nothing.

## Icons

`icon-source/icon-1024-rounded.png` is the 1024 px source. `pnpm --filter desktop icons` regenerates `src-tauri/icons` from it. The command also writes Android, iOS and Windows Store variants that the bundle does not use, so remove `src-tauri/icons/android`, `src-tauri/icons/ios`, the `Square*.png` and `StoreLogo.png` files, and `64x64.png` after running it.

## Not built or not checked yet

- An offline indicator in the UI. The client does not show when it is serving kept answers.
- Typing into the app and the other UI: no UI automation was run, because macOS blocks keystrokes from scripts without Accessibility access. The launch check was a process check and a clean start, not a screenshot.
- Windows and Linux builds. The workflow has not been dispatched.
- Companion Portal sign-in, and offline use against a real server beyond the unit tests of the routing.
- File uploads through the native path (FormData request bodies). They are not tested.

## Layout

- `client/src/lib/desktop-shell.ts`: the routing and the cache rules (tests in `desktop-shell.test.ts`).
- `client/src/lib/desktop-cache.ts` and `client/src/lib/tauri-shell.ts`: the cache calls and shell detection.
- `client/src/shell-boot.ts`: installs the shell's fetch before the app loads. `main.tsx` imports it first, because the stores start their requests as their modules load.
- `src-tauri/src/main.rs`: the window, the menu (Reload), the three cache commands, and the HTTP plugin.
- `src-tauri/src/cache.rs`: the SQLite cache, with tests.
- `src-tauri/capabilities/default.json`: the main window's permissions, including the HTTP scope (any http or https URL).
- `src-tauri/tauri.conf.json`: the bundled client, the content-security policy, and the bundle metadata.
