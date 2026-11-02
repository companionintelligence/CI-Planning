//! The desktop window onto a CI-Planning server.
//!
//! The window shows the server's own web app, so every request is same-origin and the session
//! cookie and live updates behave as they do in a browser. The only page this app ships is the
//! connect page in `web/`: it asks for the server's address the first time, and the Server menu
//! brings it back. The address rules and the reachability check are in `server.rs`.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod server;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const MAIN: &str = "main";
const CHANGE_SERVER: &str = "change-server";
const RELOAD: &str = "reload";

/// The connect page's own address, as the webview names it on this platform.
struct ConnectPage(Url);

fn main_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window(MAIN)
        .ok_or_else(|| String::from("The window is no longer open."))
}

#[tauri::command]
fn saved_server(app: AppHandle) -> Option<String> {
    server::load_saved(&app)
}

#[tauri::command]
async fn connect_server(app: AppHandle, input: String) -> Result<(), String> {
    let url = server::normalize(&input).ok_or_else(|| server::Problem::Invalid.message())?;
    server::probe(&url)
        .await
        .map_err(|problem| problem.message())?;
    server::save(&app, &url)?;
    let target = Url::parse(&url).map_err(|error| error.to_string())?;
    main_window(&app)?
        .navigate(target)
        .map_err(|error| error.to_string())
}

fn show_connect_page(app: &AppHandle) {
    let page = app.state::<ConnectPage>().0.clone();
    if let Ok(window) = main_window(app) {
        let _ = window.navigate(page);
    }
}

fn build_menu(app: &tauri::App) -> tauri::Result<Menu<tauri::Wry>> {
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
    // The Edit items carry the standard shortcuts (copy, paste, undo) into the web view.
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
    let server_menu = Submenu::with_items(
        app,
        "Server",
        true,
        &[&MenuItem::with_id(
            app,
            CHANGE_SERVER,
            "Change Server…",
            true,
            Some("CmdOrCtrl+Shift+O"),
        )?],
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
    Menu::with_items(
        app,
        &[
            &app_menu,
            &edit_menu,
            &view_menu,
            &server_menu,
            &window_menu,
        ],
    )
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let window = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
                .title("Companion Planning")
                .inner_size(1280.0, 860.0)
                .min_inner_size(480.0, 600.0)
                .build()?;
            // Read the connect page's address before anything navigates away from it.
            app.manage(ConnectPage(window.url()?));
            if let Some(server_url) = server::load_saved(app.handle()) {
                window.navigate(Url::parse(&server_url)?)?;
            }
            app.handle().set_menu(build_menu(app)?)?;
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            CHANGE_SERVER => show_connect_page(app),
            RELOAD => {
                if let Ok(window) = main_window(app) {
                    let _ = window.reload();
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![saved_server, connect_server])
        .run(tauri::generate_context!())
        .expect("error while running Companion Planning");
}
