# Companion Planning desktop

A native window onto a Companion Planning server you run. The window shows the server's own web app, so sign-in, live updates and everything else behave as they do in a browser. Nothing is bundled from `client/`. The one page this app ships is the connect page in `web/`, which asks for the server's address.

Why the server's own app and not a bundled copy: the phone shells send requests natively because their page is cross-origin to the server. A window that loads the server's app is same-origin, so the session cookie and live updates need no CORS or cookie changes on the server.

## Build and run

You need Node 22 or newer, pnpm 11, Rust 1.90 or newer (install it with `rustup`), and on macOS the Xcode command line tools. Install the workspace once from the repo root with `pnpm install --frozen-lockfile`.

```bash
pnpm --filter desktop dev                                      # run the window (tauri dev)
pnpm --filter desktop build                                    # release bundles (tauri build)
pnpm --filter desktop exec tauri build --debug --bundles app   # an unsigned debug .app
```

The bundles are not code-signed or notarised, so a bundle copied to another Mac needs the usual Gatekeeper approval. Windows and Linux bundles have not been built yet.

## First run and the Server menu

- On first run the window shows the connect page. Enter the server's address. Before anything is saved, the app checks that a Companion Planning server answers there (`/api/health` and `/api/auth/config`), then opens the server in the window.
- The saved address is in the app's settings folder, `~/Library/Application Support/com.companionintelligence.planning/server.json` on macOS. Delete that file to forget it.
- Server, then Change Server (⌘⇧O), goes back to the connect page with the saved address filled in. View, then Reload (⌘R), reloads the window.

## Address rules

These mirror `client/src/lib/server-config.ts`, so the desktop app and the phone shells accept the same addresses:

- An address with no scheme on your own network connects over http: an IP address, a single-label name, `localhost`, or a name ending `.local`, `.lan` or `.home.arpa`. For example, `192.168.1.20:3848` becomes `http://192.168.1.20:3848`.
- Any other address with no scheme connects over https. For example, `planning.example.com` becomes `https://planning.example.com`.
- Only http and https are accepted. A query string or fragment is dropped. An address with a username or password is refused.

## Network access on macOS

`src-tauri/Info.plist` sets `NSAllowsLocalNetworking`, the same exemption the iOS shell uses. It covers IP addresses, unqualified hostnames and `.local` names. It does not cover `.lan` or `.home.arpa` names, so a server reached by one of those over plain http is refused. Use the IP address, a `.local` name or https. Whether `.lan` and `.home.arpa` should be exempted is open, and it is the same question as on iOS.

The exemption is read from the built bundle. `tauri dev` runs the bare binary, so plain-http addresses may be refused there.

## Icons

The icons in `src-tauri/icons` are placeholders, generated from the iOS app icon (`mobile/ios/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png`) with `pnpm --filter desktop icons`. To replace them, change the source and run that command again, then remove the iOS, Android and Windows Store variants it also writes. The bundle uses only the files listed in `src-tauri/tauri.conf.json`.

## Not yet checked

- Companion Portal sign-in, and the Google connection in the server's Settings. Google does not allow sign-in from embedded web views, so expect the Google step to be refused in this window. Check it before relying on it.
- Typing into the connect form, and the Change Server menu item. The last check did not drive either one, because macOS blocks keystrokes from scripts without Accessibility access.
- Windows and Linux builds.

## Layout

- `web/`: the connect page, plain HTML, CSS and JavaScript with no build step.
- `src-tauri/src/main.rs`: the window, the menu, and the two commands the connect page calls (`saved_server` and `connect_server`).
- `src-tauri/src/server.rs`: the address rules, the reachability check, and the saved address, with unit tests.
- `src-tauri/capabilities/default.json`: the permissions for the main window. It names local pages only, so nothing grants the server's pages, which are remote content, access to the connect commands.

## Tests

```bash
cargo test --manifest-path desktop/src-tauri/Cargo.toml
```

These cover the address rules, the reachability check against a loopback stand-in server, and the saved address round trip.
