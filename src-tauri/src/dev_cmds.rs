/// Tauri command handlers: dev-extension watch and V8 inspector (ADR-0037).
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::State;

use crate::exthost::ExtHost;

/// Background watch processes spawned by `ext_load_from_source`.
/// Keyed by ext_id; killed on window close and on `ext_stop_dev_watch`.
pub(crate) type WatchProcesses = Arc<Mutex<HashMap<String, std::process::Child>>>;

/// Locate the bundled `sindri` CLI binary.
///
/// Resolution order:
///   1. Sibling of the current executable (production install / app bundle)
///   2. `SINDRI_CLI` environment variable
///   3. `CARGO_MANIFEST_DIR/target/debug/sindri` (dev workspace build)
fn find_sindri_cli() -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in &[
                if cfg!(windows) { "sindri-ext.exe" } else { "sindri-ext" },
                if cfg!(windows) { "sindri.exe" } else { "sindri" },
            ] {
                let bin = dir.join(name);
                if bin.is_file() {
                    return Some(bin);
                }
            }
        }
    }
    if let Ok(p) = std::env::var("SINDRI_CLI") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let debug = manifest.join("target/debug/sindri");
    if debug.is_file() {
        return Some(debug);
    }
    None
}

/// Locate the sindri-ide root directory (needed for `@sindri/api` resolution during builds).
fn find_ide_root() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("SINDRI_IDE_ROOT") {
        let p = PathBuf::from(p);
        if p.is_dir() {
            return Some(p);
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.to_path_buf())
        .filter(|p| p.is_dir())
}

/// Copy a freshly-built extension bundle into `dev_dir` and touch `.watch`.
fn copy_ext_to_dev_dir(ext_dir: &PathBuf, dev_dir: &PathBuf) -> Result<(), String> {
    std::fs::create_dir_all(dev_dir).map_err(|e| e.to_string())?;
    std::fs::copy(ext_dir.join("manifest.json"), dev_dir.join("manifest.json"))
        .map_err(|e| format!("copy manifest.json: {e}"))?;
    for name in &["extension.js", "extension.js.map", "webview.js", "webview.js.map", "webview.css"] {
        let src = ext_dir.join("dist").join(name);
        if src.is_file() {
            std::fs::copy(&src, dev_dir.join(name))
                .map_err(|e| format!("copy {name}: {e}"))?;
        }
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_default();
    std::fs::write(dev_dir.join(".watch"), ts).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(serde::Serialize)]
pub struct LoadFromSourceResult {
    pub manifest_json: String,
    pub dev_dir: String,
}

/// Build an extension from its TypeScript source directory and start a background
/// watch process. Returns the manifest JSON and the dev dir path.
#[tauri::command]
pub async fn ext_load_from_source(
    watch_processes: State<'_, WatchProcesses>,
    dir: String,
) -> Result<LoadFromSourceResult, String> {
    let ext_dir = PathBuf::from(&dir);
    let manifest_raw = std::fs::read_to_string(ext_dir.join("manifest.json"))
        .map_err(|e| format!("cannot read manifest.json: {e}"))?;
    let manifest: sindri_core::Manifest = serde_json::from_str(&manifest_raw)
        .map_err(|e| format!("invalid manifest.json: {e}"))?;
    let ext_id = manifest.id.clone();

    let sindri = find_sindri_cli().ok_or_else(|| {
        "sindri CLI not found — set SINDRI_CLI env var or build the workspace".to_string()
    })?;
    let ide_root = find_ide_root().ok_or_else(|| {
        "IDE root not found — set SINDRI_IDE_ROOT env var".to_string()
    })?;

    let sindri2 = sindri.clone();
    let ide2 = ide_root.clone();
    let dir2 = dir.clone();
    let status = tokio::task::spawn_blocking(move || {
        std::process::Command::new(&sindri2)
            .args(["ext", "build", &dir2, "--dev-sourcemaps", "--ide-root", ide2.to_str().unwrap_or("")])
            .status()
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
    .map_err(|e| format!("failed to run sindri ext build: {e}"))?;

    if !status.success() {
        return Err(format!("sindri ext build failed (exit {:?})", status.code()));
    }

    let dev_dir = sindri_core::extension_dev_dir(&ext_id)
        .map_err(|e| format!("cannot resolve dev dir: {e}"))?;
    copy_ext_to_dev_dir(&ext_dir, &dev_dir)?;

    match std::process::Command::new(&sindri)
        .args(["ext", "watch", &dir, "--ide-root", ide_root.to_str().unwrap_or("")])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(child) => {
            watch_processes.lock().unwrap().insert(ext_id.clone(), child);
        }
        Err(e) => {
            eprintln!("[sindri] warning: failed to spawn watch process for {ext_id}: {e}");
        }
    }

    Ok(LoadFromSourceResult {
        manifest_json: manifest_raw,
        dev_dir: dev_dir.to_string_lossy().into_owned(),
    })
}

/// Re-attach a background watch process for a dev extension after app restart.
#[tauri::command]
pub async fn ext_restart_watch(
    watch_processes: State<'_, WatchProcesses>,
    ext_id: String,
    folder_path: String,
) -> Result<String, String> {
    let dev_dir = sindri_core::extension_dev_dir(&ext_id)
        .map_err(|e| e.to_string())?;

    if !dev_dir.join("extension.js").is_file() {
        return Err("dev bundle missing — please re-load from source".to_string());
    }

    if let Some(sindri) = find_sindri_cli() {
        if let Some(ide_root) = find_ide_root() {
            match std::process::Command::new(&sindri)
                .args(["ext", "watch", &folder_path, "--ide-root", ide_root.to_str().unwrap_or("")])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
            {
                Ok(child) => { watch_processes.lock().unwrap().insert(ext_id, child); }
                Err(e) => eprintln!("[sindri] warning: failed to restart watch for {ext_id}: {e}"),
            }
        }
    }

    Ok(dev_dir.to_string_lossy().into_owned())
}

/// Stop the background watch process for a dev extension.
#[tauri::command]
pub async fn ext_stop_dev_watch(
    watch_processes: State<'_, WatchProcesses>,
    ext_id: String,
) -> Result<(), String> {
    if let Some(mut child) = watch_processes.lock().unwrap().remove(&ext_id) {
        let _ = child.kill();
    }
    Ok(())
}

// ── V8 Inspector / debugger (ADR-0037) ───────────────────────────────────────

/// Start the CDP gateway (lazily) and return the WebSocket debugger URL for the extension.
#[tauri::command]
pub async fn ext_attach_debugger(host: State<'_, ExtHost>, ext_id: String) -> Result<String, String> {
    host.attach_debugger(&ext_id)
        .ok_or_else(|| format!("extension '{ext_id}' not loaded or inspector not available"))
}

/// Return all loaded extension ids for the "Attach Debugger" quick-pick.
#[tauri::command]
pub async fn ext_list_loaded_extensions(host: State<'_, ExtHost>) -> Result<Vec<String>, String> {
    Ok(host.loaded_extension_ids().into_iter().map(|(id, _)| id).collect())
}

/// Exit debug mode for `ext_id`, closing all active inspector sessions.
#[tauri::command]
pub async fn ext_stop_debugger(host: State<'_, ExtHost>, ext_id: String) -> Result<(), String> {
    if !host.stop_debugger(&ext_id) {
        return Err(format!("extension '{ext_id}' not loaded"));
    }
    Ok(())
}
