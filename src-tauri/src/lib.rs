use std::io::{BufRead, BufReader};
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    Manager,
};
use tokio::sync::watch;

const CREATE_NO_WINDOW: u32 = 0x08000000;

static SIDECAR_PID: AtomicU32 = AtomicU32::new(0);

fn find_sidecar() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let installed = dir.join("xray-manager-server-x86_64-pc-windows-msvc.exe");
    if installed.exists() {
        return Some(installed.to_string_lossy().into());
    }
    let dev = std::env::current_dir()
        .ok()?
        .join("../binaries/xray-manager-server-x86_64-pc-windows-msvc.exe");
    if dev.exists() {
        return Some(dev.to_string_lossy().into());
    }
    None
}

fn kill_sidecar() {
    let pid = SIDECAR_PID.load(Ordering::Relaxed);
    if pid != 0 {
        let _ = Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

struct AppState {
    port_tx: Arc<watch::Sender<Option<u16>>>,
    port_rx: watch::Receiver<Option<u16>>,
}

#[tauri::command]
async fn get_backend_port(state: tauri::State<'_, AppState>) -> Result<u16, String> {
    let mut rx = state.port_rx.clone();
    for _ in 0..300 {
        if let Some(port) = *rx.borrow() {
            return Ok(port);
        }
        rx.changed().await.map_err(|e| e.to_string())?;
    }
    Err("Backend timeout".into())
}

pub fn run() {
    kill_sidecar();
    std::thread::sleep(std::time::Duration::from_millis(300));

    let (port_tx, port_rx) = watch::channel(None);
    let port_tx = Arc::new(port_tx);

    tauri::Builder::default()
        .manage(AppState {
            port_tx: port_tx.clone(),
            port_rx,
        })
        .invoke_handler(tauri::generate_handler![get_backend_port])
        .setup(|app| {
            let path = find_sidecar().expect("sidecar binary not found");
            let mut child = Command::new(&path)
                .arg("--desktop")
                .creation_flags(CREATE_NO_WINDOW)
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .expect("failed to spawn sidecar");

            SIDECAR_PID.store(child.id(), Ordering::Relaxed);

            let stdout = child.stdout.take().unwrap();
            let reader = BufReader::new(stdout);
            let pt = app.state::<AppState>().port_tx.clone();
            std::thread::spawn(move || {
                for line in reader.lines() {
                    if let Ok(line) = line {
                        if let Some(ps) = line.trim().strip_prefix("__XRAY_MANAGER_PORT__:") {
                            if let Ok(p) = ps.trim().parse::<u16>() {
                                let _ = pt.send(Some(p));
                                break;
                            }
                        }
                    }
                }
            });

            let show = MenuItemBuilder::with_id("show", "Show").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let menu = MenuBuilder::new(app).item(&show).separator().item(&quit).build()?;
            let icon = app.default_window_icon().unwrap().clone();
            TrayIconBuilder::new()
                .icon(icon)
                .tooltip("Xray Manager")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "quit" => {
                        kill_sidecar();
                        app.exit(0);
                    }
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            let window = app.get_webview_window("main").unwrap();
            window.on_window_event(|event| {
                if let tauri::WindowEvent::CloseRequested { .. } = event {
                    kill_sidecar();
                    std::process::exit(0);
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed");
}
