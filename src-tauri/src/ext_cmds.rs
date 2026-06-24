/// Tauri command handlers: filesystem bridge + extension lifecycle / IPC.
use std::collections::HashMap;
use std::io::Read as _;
use std::path::PathBuf;

use tauri::State;

use crate::exthost::ExtHost;
use crate::resource::{read_sinxt_entry, ExtBundleSource, ExtBundleSources};
use crate::{ActiveEnv, WorkspaceRoot};

// ── Filesystem bridge ─────────────────────────────────────────────────────────

/// Return the last-modified time of `path` as Unix seconds.
/// Used by `dev-watcher.ts` to detect when `sindri ext watch` has rebuilt a bundle.
#[tauri::command]
pub async fn file_mtime(path: String) -> Result<u64, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    let mtime = meta.modified().map_err(|e| e.to_string())?;
    Ok(mtime
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0))
}

/// Return the absolute path to the dev-reload directory for an extension.
/// `app_data_dir/extensions/<ext_id>/dev/` — written by `sindri ext watch`.
#[tauri::command]
pub async fn ext_dev_dir(ext_id: String) -> Result<String, String> {
    sindri_core::extension_dev_dir(&ext_id)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn read_file(env: State<'_, ActiveEnv>, path: String) -> Result<String, String> {
    env.fs_read(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn write_file(
    env: State<'_, ActiveEnv>,
    path: String,
    contents: String,
) -> Result<(), String> {
    env.fs_write(&path, &contents).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_dir(
    env: State<'_, ActiveEnv>,
    path: String,
) -> Result<Vec<crate::env::DirEntry>, String> {
    env.list_dir(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_file(
    env: State<'_, ActiveEnv>,
    path: String,
) -> Result<(), String> {
    env.fs_create_file(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_dir(
    env: State<'_, ActiveEnv>,
    path: String,
) -> Result<(), String> {
    env.fs_create_dir(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_workspace_root(
    workspace_root: State<'_, WorkspaceRoot>,
    path: String,
) -> Result<(), String> {
    *workspace_root.lock().unwrap() = Some(path);
    Ok(())
}

// ── Extension activation ──────────────────────────────────────────────────────

/// Load the locale bundle JSON from a dev/source extension's l10n directory.
fn resolve_dev_l10n_bundle(bundle_dir: Option<&str>) -> Option<String> {
    let dir = bundle_dir?;
    let ext_root = std::path::Path::new(dir).parent().unwrap_or(std::path::Path::new(dir));
    let manifest_path = ext_root.join("manifest.json");
    let raw = std::fs::read_to_string(&manifest_path).ok()?;
    let manifest: sindri_core::Manifest = serde_json::from_str(&raw).ok()?;
    let l10n_dir_rel = manifest.contributes.as_ref()?.l10n.as_deref()?;
    let l10n_dir = ext_root.join(l10n_dir_rel);
    for locale in ["en-US", "en"] {
        let bundle_path = l10n_dir.join(format!("bundle.l10n.{locale}.json"));
        if let Ok(content) = std::fs::read_to_string(&bundle_path) {
            if serde_json::from_str::<serde_json::Value>(&content).is_ok() {
                return Some(content);
            }
        }
    }
    None
}

/// Read `engines.sindri` from the manifest of a dev/source extension (ADR-0040).
fn resolve_dev_engines(bundle_dir: Option<&str>) -> Option<String> {
    let dir = bundle_dir?;
    let ext_root = std::path::Path::new(dir).parent().unwrap_or(std::path::Path::new(dir));
    let raw = std::fs::read_to_string(ext_root.join("manifest.json")).ok()?;
    let manifest: sindri_core::Manifest = serde_json::from_str(&raw).ok()?;
    manifest.engines?.sindri
}

/// Load grammar definitions from a dev/source extension for seeding the syntax worker.
/// Grammar paths in the manifest are relative to the extension root.
fn resolve_dev_grammars(bundle_dir: Option<&str>) -> Vec<(String, Vec<u8>, String, Vec<String>)> {
    let Some(dir) = bundle_dir else { return Vec::new() };
    let ext_root = std::path::Path::new(dir).parent().unwrap_or(std::path::Path::new(dir));
    let Ok(raw) = std::fs::read_to_string(ext_root.join("manifest.json")) else { return Vec::new() };
    let Ok(manifest) = serde_json::from_str::<sindri_core::Manifest>(&raw) else { return Vec::new() };
    let Some(contributes) = manifest.contributes else { return Vec::new() };
    let mut result = Vec::new();
    for g in &contributes.grammars {
        let wasm = match std::fs::read(ext_root.join(&g.path)) {
            Ok(b) => b,
            Err(e) => { eprintln!("[sindri] grammar '{}': failed to read '{}': {e}", g.language, g.path); continue; }
        };
        let scm = match std::fs::read_to_string(ext_root.join(&g.highlights)) {
            Ok(s) => s,
            Err(e) => { eprintln!("[sindri] grammar '{}': failed to read '{}': {e}", g.language, g.highlights); continue; }
        };
        result.push((g.language.clone(), wasm, scm, g.extensions.clone()));
    }
    result
}

/// Resolve bundled binary paths for dev/source extensions (ADR-0036 §2).
fn resolve_dev_bin_paths(bundle_dir: Option<&str>) -> HashMap<String, String> {
    let Some(dir) = bundle_dir else { return HashMap::new() };
    let ext_root = std::path::Path::new(dir).parent().unwrap_or(std::path::Path::new(dir));
    let manifest_path = ext_root.join("manifest.json");
    let Ok(raw) = std::fs::read_to_string(&manifest_path) else { return HashMap::new() };
    let Ok(manifest) = serde_json::from_str::<sindri_core::Manifest>(&raw) else { return HashMap::new() };
    let mut map = HashMap::new();
    let empty = HashMap::new();
    let binaries = manifest.contributes.as_ref().map(|c| &c.binaries).unwrap_or(&empty);
    for (name, rel_path) in binaries {
        let abs = ext_root.join(rel_path);
        if abs.is_file() {
            if let Some(s) = abs.to_str() {
                map.insert(name.clone(), s.to_owned());
            }
        }
    }
    map
}

#[tauri::command]
pub async fn ext_activate(
    host: State<'_, ExtHost>,
    syntax_worker: State<'_, crate::syntax::SyntaxWorker>,
    env: State<'_, ActiveEnv>,
    workspace_root: State<'_, WorkspaceRoot>,
    ext_bundle_sources: State<'_, ExtBundleSources>,
    bundle_path: String,
    bundle_dir: Option<String>,
    ext_id: Option<String>,
    config_snapshot: Option<String>,
) -> Result<(), String> {
    if let (Some(id), Some(dir)) = (&ext_id, &bundle_dir) {
        // bundleDir is the parent of extension.js (typically dist/).
        // sindri-resource:// paths are relative to the extension ROOT (parent of dist/),
        // matching sinxt archive layout where dist/webview.js is the entry path.
        let bundle_path_obj = PathBuf::from(dir);
        let resource_root = bundle_path_obj
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or(bundle_path_obj);
        ext_bundle_sources
            .lock()
            .unwrap()
            .insert(id.clone(), ExtBundleSource::Dir(resource_root));
    }
    let bin_paths = resolve_dev_bin_paths(bundle_dir.as_deref());
    let l10n_bundle = resolve_dev_l10n_bundle(bundle_dir.as_deref());
    let engines = resolve_dev_engines(bundle_dir.as_deref());
    let grammars = resolve_dev_grammars(bundle_dir.as_deref());
    let wr = workspace_root.lock().unwrap().clone();
    host.activate(&bundle_path, ext_id.as_deref(), wr.as_deref(), (*env).clone(), bin_paths, l10n_bundle, config_snapshot, engines.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    for (language_id, wasm, highlights_scm, extensions) in grammars {
        syntax_worker.register_grammar(language_id, wasm, highlights_scm, extensions);
    }
    Ok(())
}

/// Activate an extension from an installed `.sinxt` archive.
#[tauri::command]
pub async fn ext_activate_sinxt(
    host: State<'_, ExtHost>,
    syntax_worker: State<'_, crate::syntax::SyntaxWorker>,
    env: State<'_, ActiveEnv>,
    workspace_root: State<'_, WorkspaceRoot>,
    ext_bundle_sources: State<'_, ExtBundleSources>,
    sinxt_path: String,
    ext_id: String,
    config_snapshot: Option<String>,
) -> Result<(), String> {
    let sinxt = PathBuf::from(&sinxt_path);

    let manifest_bytes = read_sinxt_entry(&sinxt, "manifest.json")
        .map_err(|e| format!("failed to read manifest.json from .sinxt: {e}"))?;
    let manifest: sindri_core::Manifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| format!("invalid manifest.json in .sinxt: {e}"))?;
    let bundle_entry = manifest.main.as_deref().unwrap_or("dist/extension.js");

    let bundle_js = read_sinxt_entry(&sinxt, bundle_entry)
        .map_err(|e| format!("failed to read {bundle_entry} from .sinxt: {e}"))?;
    let bundle_js = String::from_utf8(bundle_js)
        .map_err(|_| format!("{bundle_entry} is not valid UTF-8"))?;

    let tmp_dir = std::env::temp_dir().join("sindri-sinxt-bundles");
    let ext_tmp_dir = tmp_dir.join(&ext_id);
    let tmp_bundle = ext_tmp_dir.join(bundle_entry);
    if let Some(parent) = tmp_bundle.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&tmp_bundle, &bundle_js).map_err(|e| e.to_string())?;

    let contributes = manifest.contributes.as_ref();

    for wasm_entry in contributes.map(|c| c.wasm.as_slice()).unwrap_or(&[]) {
        match read_sinxt_entry(&sinxt, wasm_entry) {
            Ok(bytes) => {
                let dest = ext_tmp_dir.join(wasm_entry);
                if let Some(parent) = dest.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::write(&dest, &bytes);
            }
            Err(e) => {
                eprintln!("[sindri] warning: could not extract WASM entry '{wasm_entry}' from {ext_id}: {e}");
            }
        }
    }

    let mut bin_paths = HashMap::<String, String>::new();
    let empty_bins = HashMap::new();
    let binaries = contributes.map(|c| &c.binaries).unwrap_or(&empty_bins);
    for (name, rel_path) in binaries {
        match read_sinxt_entry(&sinxt, rel_path) {
            Ok(bytes) => {
                let dest = ext_tmp_dir.join(rel_path);
                if let Some(parent) = dest.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if std::fs::write(&dest, &bytes).is_ok() {
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755));
                    }
                    if let Some(abs) = dest.to_str() {
                        bin_paths.insert(name.clone(), abs.to_owned());
                    }
                }
            }
            Err(e) => {
                eprintln!("[sindri] warning: could not extract binary '{name}' from {ext_id}: {e}");
            }
        }
    }

    let l10n_bundle = (|| -> Option<String> {
        let l10n_dir = contributes?.l10n.as_deref()?;
        for locale in ["en-US", "en"] {
            let entry = format!("{l10n_dir}/bundle.l10n.{locale}.json");
            if let Ok(bytes) = read_sinxt_entry(&sinxt, &entry) {
                if let Ok(content) = String::from_utf8(bytes) {
                    if serde_json::from_str::<serde_json::Value>(&content).is_ok() {
                        return Some(content);
                    }
                }
            }
        }
        None
    })();

    ext_bundle_sources
        .lock()
        .unwrap()
        .insert(ext_id.clone(), ExtBundleSource::Sinxt(sinxt.clone()));

    let wr = workspace_root.lock().unwrap().clone();
    // B9: use ok_or_else instead of unwrap so a non-UTF-8 temp path returns an error.
    let tmp_bundle_str = tmp_bundle
        .to_str()
        .ok_or_else(|| "non-UTF-8 tmp bundle path".to_string())?;
    host.activate(
        tmp_bundle_str,
        Some(&ext_id),
        wr.as_deref(),
        (*env).clone(),
        bin_paths,
        l10n_bundle,
        config_snapshot,
        manifest.engines.as_ref().and_then(|e| e.sindri.as_deref()),
    )
    .await
    .map_err(|e| e.to_string())?;

    for g in contributes.map(|c| c.grammars.as_slice()).unwrap_or(&[]) {
        let wasm = match read_sinxt_entry(&sinxt, &g.path) {
            Ok(b) => b,
            Err(e) => { eprintln!("[sindri] grammar '{}': failed to read '{}': {e}", g.language, g.path); continue; }
        };
        let scm_bytes = match read_sinxt_entry(&sinxt, &g.highlights) {
            Ok(b) => b,
            Err(e) => { eprintln!("[sindri] grammar '{}': failed to read '{}': {e}", g.language, g.highlights); continue; }
        };
        let scm = match String::from_utf8(scm_bytes) {
            Ok(s) => s,
            Err(_) => { eprintln!("[sindri] grammar '{}': highlights '{}' is not valid UTF-8", g.language, g.highlights); continue; }
        };
        syntax_worker.register_grammar(g.language.clone(), wasm, scm, g.extensions.clone());
    }
    Ok(())
}

/// Check whether an extension's `engines.sindri` range is compatible with this
/// host (ADR-0040). Returns a JSON object with `ok: bool` and, when not ok,
/// `reason` (`"host_too_old"` | `"host_too_new"` | `"bad_range"`) + `message`.
/// Non-blocking — callers show a warning but may proceed anyway.
#[tauri::command]
pub async fn ext_check_compat(engines: Option<String>) -> Result<serde_json::Value, String> {
    let result = match sindri_core::check_engine(
        engines.as_deref(),
        sindri_core::HOST_API_VERSION,
    ) {
        sindri_core::Compat::Ok => serde_json::json!({ "ok": true }),
        sindri_core::Compat::HostTooOld { required, host } => serde_json::json!({
            "ok": false,
            "reason": "host_too_old",
            "message": format!(
                "Extension requires Sindri engine {required} but this host is {host}. \
                 Please upgrade Sindri."
            ),
        }),
        sindri_core::Compat::HostTooNew { required, host } => serde_json::json!({
            "ok": false,
            "reason": "host_too_new",
            "message": format!(
                "Extension requires Sindri engine {required} but this host is {host}. \
                 The extension may need an update."
            ),
        }),
        sindri_core::Compat::BadRange(msg) => serde_json::json!({
            "ok": false,
            "reason": "bad_range",
            "message": format!("Extension has invalid engines.sindri range: {msg}"),
        }),
    };
    Ok(result)
}

// ── Extension install ─────────────────────────────────────────────────────────

/// Install a `.sinxt` bundle from raw bytes into `app_data_dir/extensions/<id>/<version>/`.
#[tauri::command]
pub async fn install_sinxt(
    ext_id: String,
    version: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    let install_dir = sindri_core::extension_install_dir(&ext_id, &version)
        .map_err(|e| format!("cannot resolve app_data_dir: {e}"))?;
    std::fs::create_dir_all(&install_dir).map_err(|e| e.to_string())?;
    zip::ZipArchive::new(std::io::Cursor::new(&bytes))
        .map_err(|e| format!("invalid .sinxt archive: {e}"))?;
    let filename = format!("{ext_id}-{version}.sinxt");
    let dest = install_dir.join(&filename);
    std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    dest.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "non-UTF-8 install path".to_string())
}

#[derive(serde::Serialize)]
pub struct SinxtInstallResult {
    pub sinxt_path: String,
    pub manifest_json: String,
}

/// Install a `.sinxt` bundle from a local file path chosen via the OS file dialog.
#[tauri::command]
pub async fn install_sinxt_from_path(path: String) -> Result<SinxtInstallResult, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("cannot read file: {e}"))?;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(&bytes))
        .map_err(|e| format!("invalid .sinxt archive: {e}"))?;
    let manifest_json = {
        let mut f = archive
            .by_name("manifest.json")
            .map_err(|_| "manifest.json not found in .sinxt".to_string())?;
        let mut s = String::new();
        f.read_to_string(&mut s).map_err(|e| e.to_string())?;
        s
    };
    let manifest_val: serde_json::Value = serde_json::from_str(&manifest_json)
        .map_err(|e| format!("invalid manifest.json: {e}"))?;
    let ext_id = manifest_val["id"]
        .as_str()
        .ok_or_else(|| "manifest.json missing 'id'".to_string())?
        .to_string();
    let version = manifest_val["version"]
        .as_str()
        .ok_or_else(|| "manifest.json missing 'version'".to_string())?
        .to_string();
    let install_dir = sindri_core::extension_install_dir(&ext_id, &version)
        .map_err(|e| format!("cannot resolve app_data_dir: {e}"))?;
    std::fs::create_dir_all(&install_dir).map_err(|e| e.to_string())?;
    let filename = format!("{ext_id}-{version}.sinxt");
    let dest = install_dir.join(&filename);
    std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    let sinxt_path = dest
        .to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "non-UTF-8 install path".to_string())?;
    Ok(SinxtInstallResult { sinxt_path, manifest_json })
}

// ── Extension IPC ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn ext_execute_command(host: State<'_, ExtHost>, command_id: String) -> Result<String, String> {
    host.execute_command(&command_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ext_dispatch_event(
    host: State<'_, ExtHost>,
    id: String,
    payload: String,
) -> Result<(), String> {
    host.dispatch_event(&id, &payload).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ext_tree_view_get_children(
    host: State<'_, ExtHost>,
    id: String,
    element: Option<String>,
) -> Result<String, String> {
    host.tree_view_get_children(&id, element.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Deliver a message from the webview iframe to the extension JS provider.
#[tauri::command]
pub async fn ext_webview_panel_message(
    host: State<'_, ExtHost>,
    panel_id: String,
    payload: String,
) -> Result<(), String> {
    host.dispatch_event(
        &format!("__sindri.ui.webviewInboundMessage:{panel_id}"),
        &payload,
    )
    .await
    .map_err(|e| e.to_string())
}

/// Deliver the user's quick-pick selection (or cancellation) to the awaiting JS op.
#[tauri::command]
pub async fn ext_quick_pick_result(
    host: State<'_, ExtHost>,
    request_id: String,
    item: Option<String>,
) -> Result<(), String> {
    host.quick_pick_result(&request_id, item);
    Ok(())
}

/// Deliver the webview's response to a sindri.editor async proxy read.
#[tauri::command]
pub async fn ext_editor_read_result(
    host: State<'_, ExtHost>,
    request_id: String,
    result: Option<String>,
) -> Result<(), String> {
    host.editor_read_result(&request_id, result);
    Ok(())
}

/// Call `provide(ctx)` on the JS decoration provider registered under `provider_id`.
#[tauri::command]
pub async fn ext_editor_provide_decorations(
    host: State<'_, ExtHost>,
    ext_id: String,
    provider_id: String,
    ctx_json: String,
) -> Result<String, String> {
    host.provide_decorations(&ext_id, &provider_id, &ctx_json)
        .await
        .map_err(|e| e.to_string())
}

/// Deactivate (unload) a running extension by id.
#[tauri::command]
pub async fn ext_deactivate(host: State<'_, ExtHost>, ext_id: String) -> Result<(), String> {
    let rt = host.get_runtime(&ext_id);
    if let Some(rt) = rt {
        let _ = rt.deactivate_gracefully().await;
    }
    host.deactivate(&ext_id);
    Ok(())
}
