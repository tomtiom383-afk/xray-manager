use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    Manager,
};
use tauri_plugin_shell::ShellExt;
use tokio::sync::watch;

#[derive(Clone)]
struct AppState {
    port_tx: Arc<watch::Sender<Option<u16>>>,
    port_rx: watch::Receiver<Option<u16>>,
}

#[derive(Serialize)]
struct HealthStatus {
    status: String,
}

#[tauri::command]
async fn get_backend_port(state: tauri::State<'_, AppState>) -> Result<u16, String> {
    let mut rx = state.port_rx.clone();
    // Wait up to 30 seconds for the backend to report its port
    for _ in 0..300 {
        if let Some(port) = *rx.borrow() {
            return Ok(port);
        }
        rx.changed().await.map_err(|e| e.to_string())?;
    }
    Err("Backend failed to start within 30 seconds".into())
}

pub fn run() {
    let (port_tx, port_rx) = watch::channel(None);

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(AppState {
            port_tx: Arc::new(port_tx),
            port_rx,
        })
        .invoke_handler(tauri::generate_handler![get_backend_port])
        .setup(|app| {
            let app_handle = app.handle().clone();
            let port_tx = app.state::<AppState>().port_tx.clone();

            // Spawn sidecar
            tauri::async_runtime::spawn(async move {
                let sidecar = app_handle
                    .shell()
                    .sidecar("xray-manager-server")
                    .expect("failed to find sidecar binary");

                let (mut rx, _child) = sidecar
                    .args(["--desktop"])
                    .spawn()
                    .expect("failed to spawn sidecar");

                while let Some(event) = rx.recv().await {
                    match event {
                        tauri_plugin_shell::process::CommandEvent::Stdout(line) => {
                            let line = String::from_utf8_lossy(&line);
                            eprintln!("[sidecar] {}", line.trim());
                            if let Some(port_str) = line.trim().strip_prefix("__XRAY_MANAGER_PORT__:") {
                                if let Ok(port) = port_str.trim().parse::<u16>() {
                                    let _ = port_tx.send(Some(port));
                                }
                            }
                        }
                        tauri_plugin_shell::process::CommandEvent::Stderr(line) => {
                            let line = String::from_utf8_lossy(&line);
                            eprintln!("[sidecar:err] {}", line.trim());
                        }
                        tauri_plugin_shell::process::CommandEvent::Terminated(payload) => {
                            eprintln!("[sidecar] terminated: {:?}", payload);
                            break;
                        }
                        _ => {}
                    }
                }
            });

            // Build tray menu
            let show_item = MenuItemBuilder::with_id("show", "显示窗口").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = MenuBuilder::new(app)
                .item(&show_item)
                .separator()
                .item(&quit_item)
                .build()?;

            // Build tray icon
            let icon = Image::from_bytes(include_bytes!("../icons/icon.png"))
                .unwrap_or_else(|_| Image::from_bytes(include_bytes!("../icons/32x32.png")).unwrap());

            TrayIconBuilder::new()
                .icon(icon)
                .tooltip("Xray Manager")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "quit" => {
                        app.exit(0);
                    }
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Minimize to tray on window close
            let window = app.get_webview_window("main").unwrap();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if let Some(window) = api.webview().and_then(|w| w.get_webview_window("main")) {
                        let _ = window.hide();
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
