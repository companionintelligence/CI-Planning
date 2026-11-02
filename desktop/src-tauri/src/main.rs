//! The Companion Planning desktop app.
//!
//! The web client is bundled into the app (the `client/dist` build), so the window needs no
//! server to start. The client reaches the user's server through the native HTTP plugin, and keeps
//! the server's reads in a local SQLite cache (`cache.rs`), so the last data it saw is still there
//! when the server is not. See `desktop/README.md`.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cache;

use std::path::PathBuf;

use cache::Cache;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{App, AppHandle, Manager, State, WebviewWindow};

const CACHE_FILE: &str = "offline-cache.sqlite";
const RELOAD: &str = "reload";

// Async commands run off the main thread, so SQLite work never stalls the window. A sync command
// would run on the main thread.
#[tauri::command]
async fn cache_put(cache: State<'_, Cache>, key: String, body: String) -> Result<(), String> {
    cache.put(&key, &body)
}

#[tauri::command]
async fn cache_get(cache: State<'_, Cache>, key: String) -> Result<Option<String>, String> {
    cache.get(&key)
}

#[tauri::command]
async fn cache_clear(cache: State<'_, Cache>) -> Result<(), String> {
    cache.clear()
}

fn build_menu(app: &App) -> tauri::Result<Menu<tauri::Wry>> {
    let app_menu = Submenu::with_items(
        app,
        "Companion Planning",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    // Edit carries the standard shortcuts (copy, paste, undo) into the web view.
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &MenuItem::with_id(app, RELOAD, "Reload", true, Some("CmdOrCtrl+R"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &edit_menu, &view_menu, &window_menu])
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            let path: PathBuf = app.path().app_data_dir()?.join(CACHE_FILE);
            // A cache file that cannot be opened (damaged, or its folder is not writable) must not
            // stop the app from starting. The app keeps its cache in memory for this session instead.
            let cache = Cache::open(&path).or_else(|error| {
                eprintln!("offline cache file unavailable, keeping the cache in memory: {error}");
                Cache::in_memory()
            })?;
            app.manage(cache);
            app.handle().set_menu(build_menu(app)?)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == RELOAD {
                if let Some(window) = main_window(app) {
                    let _ = window.reload();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![cache_put, cache_get, cache_clear])
        .run(tauri::generate_context!())
        .expect("error while running Companion Planning");
}
