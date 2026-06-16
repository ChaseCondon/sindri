mod env;
pub mod exthost;
mod inspector_gateway;

use std::collections::HashMap;
use std::io::Read as _;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use env::{Environment, LocalEnvironment};
use exthost::ExtHost;
use tauri::{Emitter, Manager, State};

type ActiveEnv = Arc<dyn Environment>;
type WorkspaceRoot = Arc<Mutex<Option<String>>>;

/// Where an extension's assets live. Either an exploded directory (dev-mode) or
/// a `.sinxt` zip archive (installed via marketplace / local file picker).
enum ExtBundleSource {
    /// Path to the directory containing `bundle.js` and sibling assets (ADR-0031, dev path).
    Dir(PathBuf),
    /// Path to a `.sinxt` zip; assets are read from entries on demand.
    Sinxt(PathBuf),
}

/// ext-id → asset source, populated during ext_activate / ext_activate_sinxt.
type ExtBundleSources = Arc<Mutex<HashMap<String, ExtBundleSource>>>;

/// Return the last-modified time of `path` as Unix seconds.
/// Used by `dev-watcher.ts` to detect when `sindri ext watch` has rebuilt a bundle.
#[tauri::command]
async fn file_mtime(path: String) -> Result<u64, String> {
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
async fn ext_dev_dir(ext_id: String) -> Result<String, String> {
    sindri_core::extension_dev_dir(&ext_id)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_file(env: State<'_, ActiveEnv>, path: String) -> Result<String, String> {
    env.fs_read(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn write_file(
    env: State<'_, ActiveEnv>,
    path: String,
    contents: String,
) -> Result<(), String> {
    env.fs_write(&path, &contents).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_dir(
    env: State<'_, ActiveEnv>,
    path: String,
) -> Result<Vec<env::DirEntry>, String> {
    env.list_dir(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_file(
    env: State<'_, ActiveEnv>,
    path: String,
) -> Result<(), String> {
    env.fs_create_file(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_dir(
    env: State<'_, ActiveEnv>,
    path: String,
) -> Result<(), String> {
    env.fs_create_dir(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_workspace_root(
    workspace_root: State<'_, WorkspaceRoot>,
    path: String,
) -> Result<(), String> {
    *workspace_root.lock().unwrap() = Some(path);
    Ok(())
}

#[tauri::command]
async fn ext_activate(
    host: State<'_, ExtHost>,
    env: State<'_, ActiveEnv>,
    workspace_root: State<'_, WorkspaceRoot>,
    ext_bundle_sources: State<'_, ExtBundleSources>,
    bundle_path: String,
    bundle_dir: Option<String>,
    ext_id: Option<String>,
) -> Result<(), String> {
    // Register bundle dir so sindri-resource:// can serve files from it (ADR-0031).
    if let (Some(id), Some(dir)) = (&ext_id, &bundle_dir) {
        ext_bundle_sources
            .lock()
            .unwrap()
            .insert(id.clone(), ExtBundleSource::Dir(PathBuf::from(dir)));
    }

    // Build bundled-binary path map and l10n bundle from manifest.
    // For dev/source extensions, bundle_dir is the directory containing extension.js.
    // Binaries and l10n dir are declared relative to the extension root (parent of bundle_dir).
    let bin_paths = resolve_dev_bin_paths(bundle_dir.as_deref());
    let l10n_bundle = resolve_dev_l10n_bundle(bundle_dir.as_deref());

    let wr = workspace_root.lock().unwrap().clone();
    host.activate(&bundle_path, ext_id.as_deref(), wr.as_deref(), (*env).clone(), bin_paths, l10n_bundle)
        .await
        .map_err(|e| e.to_string())
}

/// Activate an extension from an installed `.sinxt` archive.
/// Reads the `main` entry and any declared `contributes.wasm` files out of the zip;
/// writes them to a per-extension temp subdirectory so the exthost runtime can load
/// them by path. Registers the sinxt path as the asset source for `sindri-resource://`
/// so webview asset requests are served directly from zip entries without extraction.
#[tauri::command]
async fn ext_activate_sinxt(
    host: State<'_, ExtHost>,
    env: State<'_, ActiveEnv>,
    workspace_root: State<'_, WorkspaceRoot>,
    ext_bundle_sources: State<'_, ExtBundleSources>,
    sinxt_path: String,
    ext_id: String,
) -> Result<(), String> {
    let sinxt = PathBuf::from(&sinxt_path);

    // Resolve the bundle path from manifest.json's `main` field.
    let manifest_bytes = read_sinxt_entry(&sinxt, "manifest.json")
        .map_err(|e| format!("failed to read manifest.json from .sinxt: {e}"))?;
    let manifest: sindri_core::Manifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| format!("invalid manifest.json in .sinxt: {e}"))?;
    let bundle_entry = manifest.main.as_deref().unwrap_or("dist/extension.js");

    let bundle_js = read_sinxt_entry(&sinxt, bundle_entry)
        .map_err(|e| format!("failed to read {bundle_entry} from .sinxt: {e}"))?;
    let bundle_js = String::from_utf8(bundle_js)
        .map_err(|_| format!("{bundle_entry} is not valid UTF-8"))?;

    // Per-extension temp subdirectory preserves relative paths so __sindri_bundle_dir
    // is consistent between dev (filesystem) and sinxt (extracted temp) activation paths.
    // Layout: $TMPDIR/sindri-sinxt-bundles/<ext_id>/<bundle_entry>
    //   e.g.: $TMPDIR/sindri-sinxt-bundles/sindri.token-counter/dist/extension.js
    //         $TMPDIR/sindri-sinxt-bundles/sindri.token-counter/dist/tokenizer.wasm
    let tmp_dir = std::env::temp_dir().join("sindri-sinxt-bundles");
    let ext_tmp_dir = tmp_dir.join(&ext_id);
    let tmp_bundle = ext_tmp_dir.join(bundle_entry);
    if let Some(parent) = tmp_bundle.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&tmp_bundle, &bundle_js).map_err(|e| e.to_string())?;

    let contributes = manifest.contributes.as_ref();

    // Extract declared WASM files (ADR-0035 §5) so op_wasm_load can read them.
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

    // Extract declared native binaries (ADR-0036 §2) and build the name→absolute-path map.
    let mut bin_paths = std::collections::HashMap::<String, String>::new();
    let empty_bins = std::collections::HashMap::new();
    let binaries = contributes.map(|c| &c.binaries).unwrap_or(&empty_bins);
    for (name, rel_path) in binaries {
        match read_sinxt_entry(&sinxt, rel_path) {
            Ok(bytes) => {
                let dest = ext_tmp_dir.join(rel_path);
                if let Some(parent) = dest.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if std::fs::write(&dest, &bytes).is_ok() {
                    // Set executable bit on Unix.
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

    // Load locale bundle from sinxt (1.5j). Tries en-US then en; falls back to None.
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
        .insert(ext_id.clone(), ExtBundleSource::Sinxt(sinxt));

    let wr = workspace_root.lock().unwrap().clone();
    host.activate(
        tmp_bundle.to_str().unwrap(),
        Some(&ext_id),
        wr.as_deref(),
        (*env).clone(),
        bin_paths,
        l10n_bundle,
    )
    .await
    .map_err(|e| e.to_string())
}

/// Install a `.sinxt` bundle from raw bytes into `app_data_dir/extensions/<id>/<version>/`.
/// Returns the absolute path to the installed `.sinxt` file.
/// Called from the TypeScript download pipeline after fetching the archive bytes.
#[tauri::command]
async fn install_sinxt(
    ext_id: String,
    version: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    // ADR-0033 §3: resolve via sindri-core so the app and CLI share one impl.
    let install_dir = sindri_core::extension_install_dir(&ext_id, &version)
        .map_err(|e| format!("cannot resolve app_data_dir: {e}"))?;
    std::fs::create_dir_all(&install_dir).map_err(|e| e.to_string())?;

    // Verify the bytes are a valid zip before writing.
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
struct SinxtInstallResult {
    sinxt_path: String,
    manifest_json: String,
}

/// Install a `.sinxt` bundle from a local file path chosen via the OS file dialog.
/// Reads the file, extracts manifest.json to discover id/version, installs, and returns
/// both the installed path and raw manifest JSON for the TypeScript activation layer.
#[tauri::command]
async fn install_sinxt_from_path(
    path: String,
) -> Result<SinxtInstallResult, String> {
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

    // ADR-0033 §3: resolve via sindri-core so the app and CLI share one impl.
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

#[tauri::command]
async fn ext_execute_command(host: State<'_, ExtHost>, command_id: String) -> Result<String, String> {
    host.execute_command(&command_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn ext_dispatch_event(
    host: State<'_, ExtHost>,
    id: String,
    payload: String,
) -> Result<(), String> {
    host.dispatch_event(&id, &payload).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn ext_tree_view_get_children(
    host: State<'_, ExtHost>,
    id: String,
    element: Option<String>,
) -> Result<String, String> {
    host.tree_view_get_children(&id, element.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Deliver a message from the webview iframe to the extension JS provider.
/// Called by the frontend's WebviewPanelHost when the iframe fires postMessage.
/// Routes to `provider.onMessage` via `sindri.events.on("__sindri.ui.webviewInboundMessage:{id}")`.
#[tauri::command]
async fn ext_webview_panel_message(
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
/// Called by the frontend after the user accepts or dismisses the overlay.
/// `item` is the chosen QuickPickItem serialised as JSON, or null if cancelled.
#[tauri::command]
async fn ext_quick_pick_result(
    host: State<'_, ExtHost>,
    request_id: String,
    item: Option<String>,
) -> Result<(), String> {
    host.quick_pick_result(&request_id, item);
    Ok(())
}

/// Deliver the webview's response to a sindri.editor async proxy read.
/// Called by the webview after computing getText/lineAt/… from the active CM6 view.
/// `result` is a JSON-encoded string (or null if no active view). Signals op_editor_request.
#[tauri::command]
async fn ext_editor_read_result(
    host: State<'_, ExtHost>,
    request_id: String,
    result: Option<String>,
) -> Result<(), String> {
    host.editor_read_result(&request_id, result);
    Ok(())
}

/// Call `provide(ctx)` on the JS decoration provider registered under `provider_id`.
/// `ext_id` routes the call to the correct V8 isolate (ADR-0025 §2).
/// Returns a JSON-encoded `DecorationDatum[]` to the webview.
#[tauri::command]
async fn ext_editor_provide_decorations(
    host: State<'_, ExtHost>,
    ext_id: String,
    provider_id: String,
    ctx_json: String,
) -> Result<String, String> {
    host.provide_decorations(&ext_id, &provider_id, &ctx_json)
        .await
        .map_err(|e| e.to_string())
}

// ── sindri-resource:// protocol (ADR-0031) ────────────────────────────────────

/// Resolve bundled binary paths for dev/source extensions (ADR-0036 §2).
///
/// `bundle_dir` is the directory containing `extension.js` (typically `<ext_root>/dist/`).
/// The manifest is expected one level up at `<ext_root>/manifest.json`. Returns a map of
/// logical binary name → absolute path. Returns an empty map if `bundle_dir` is None or
/// the manifest cannot be read / parsed.
/// Load the locale bundle JSON from a dev/source extension's l10n directory.
/// Reads `contributes.l10n` from the manifest adjacent to `bundle_dir`; tries
/// `bundle.l10n.en-US.json` then `bundle.l10n.en.json` in that dir.
/// Returns the raw JSON string or `None` if not found / invalid.
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

fn resolve_dev_bin_paths(bundle_dir: Option<&str>) -> std::collections::HashMap<String, String> {
    let Some(dir) = bundle_dir else { return std::collections::HashMap::new() };
    let ext_root = std::path::Path::new(dir).parent().unwrap_or(std::path::Path::new(dir));
    let manifest_path = ext_root.join("manifest.json");
    let Ok(raw) = std::fs::read_to_string(&manifest_path) else { return std::collections::HashMap::new() };
    let Ok(manifest) = serde_json::from_str::<sindri_core::Manifest>(&raw) else { return std::collections::HashMap::new() };
    let mut map = std::collections::HashMap::new();
    let empty = std::collections::HashMap::new();
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

/// Reject any path component that could escape the bundle directory.
/// Disallows '..', absolute roots, and '%'-encoded sequences (bypass guard).
fn is_safe_resource_path(path: &str) -> bool {
    use std::path::{Component, Path};
    if path.contains('%') {
        return false;
    }
    Path::new(path)
        .components()
        .all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
}

fn mime_for_ext(ext: Option<&str>) -> &'static str {
    match ext {
        Some("js" | "mjs") => "application/javascript",
        Some("css") => "text/css",
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("wasm") => "application/wasm",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn sindri_resource_response(
    status: u16,
    content_type: &'static str,
    body: Vec<u8>,
) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("content-type", content_type)
        .body(body)
        .unwrap()
}

/// Read a single named entry from a `.sinxt` zip archive, decompressing into memory.
fn read_sinxt_entry(sinxt_path: &PathBuf, entry_name: &str) -> Result<Vec<u8>, String> {
    let file = std::fs::File::open(sinxt_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut entry = archive
        .by_name(entry_name)
        .map_err(|_| format!("entry '{entry_name}' not found in archive"))?;
    let mut buf = Vec::with_capacity(entry.size() as usize);
    entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

fn handle_sindri_resource<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let err = |status: u16| sindri_resource_response(status, "text/plain", vec![]);

    let uri = request.uri();
    let ext_id = match uri.host() {
        Some(h) if !h.is_empty() => h.to_owned(),
        _ => return err(400),
    };
    let rel = uri.path().trim_start_matches('/');
    if rel.is_empty() {
        return err(400);
    }
    if !is_safe_resource_path(rel) {
        return err(403);
    }

    let source = {
        let sources = app.state::<ExtBundleSources>();
        let guard = sources.lock().unwrap();
        match guard.get(&ext_id) {
            Some(ExtBundleSource::Dir(dir)) => Either::Left(dir.join(rel)),
            Some(ExtBundleSource::Sinxt(sinxt)) => Either::Right(sinxt.clone()),
            None => return err(404),
        }
    };

    let file_ext = std::path::Path::new(rel)
        .extension()
        .and_then(|e| e.to_str());
    let mime = mime_for_ext(file_ext);

    match source {
        Either::Left(file_path) => match std::fs::read(&file_path) {
            Ok(bytes) => sindri_resource_response(200, mime, bytes),
            Err(_) => err(404),
        },
        Either::Right(sinxt_path) => match read_sinxt_entry(&sinxt_path, rel) {
            Ok(bytes) => sindri_resource_response(200, mime, bytes),
            Err(_) => err(404),
        },
    }
}

// Simple Either type to avoid a dependency for the two-branch resource handler.
enum Either<L, R> {
    Left(L),
    Right(R),
}

// ── Dev-source watch management ───────────────────────────────────────────────

/// Background watch processes spawned by `ext_load_from_source`.
/// Each entry is a `sindri ext watch <dir>` child process keyed by ext_id.
/// Killed on window close (see `setup` closure) and on `ext_stop_dev_watch`.
type WatchProcesses = Arc<Mutex<HashMap<String, std::process::Child>>>;

/// Locate the bundled `sindri` CLI binary.
///
/// Resolution order:
///   1. Sibling of the current executable (production install / app bundle)
///   2. `SINDRI_CLI` environment variable
///   3. `CARGO_MANIFEST_DIR/target/debug/sindri` (dev workspace build)
fn find_sindri_cli() -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // "sindri-ext" is the bundled sidecar name (avoids Tauri package-name collision).
            // Fall back to plain "sindri" for dev environments where the CLI is on PATH.
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
    // Dev workspace: src-tauri/target/debug/sindri
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let debug = manifest.join("target/debug/sindri");
    if debug.is_file() {
        return Some(debug);
    }
    None
}

/// Locate the sindri-ide root directory (needed for `@sindri/api` resolution during builds).
///
/// Resolution order:
///   1. `SINDRI_IDE_ROOT` environment variable
///   2. Parent of `CARGO_MANIFEST_DIR` (i.e. the workspace sibling `sindri-ide/`)
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
/// Mirrors `copy_dev_files` in `sindri-cli/src/ext.rs`.
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
struct LoadFromSourceResult {
    manifest_json: String,
    dev_dir: String,
}

/// Build an extension from its TypeScript source directory and start a background
/// watch process. Returns the manifest JSON and the dev dir path so the TypeScript
/// activation layer can activate via `activateExtensionWithManifest`.
///
/// Workflow:
///   1. Read manifest → validate.
///   2. Shell out to `sindri ext build <dir>` (blocking, via spawn_blocking).
///   3. Copy dist/ → `app_data_dir/extensions/<id>/dev/` + touch `.watch`.
///   4. Spawn `sindri ext watch <dir>` in the background (stored for later kill).
#[tauri::command]
async fn ext_load_from_source(
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

    // Build (blocking — may take a few seconds)
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

    // Copy to dev dir
    let dev_dir = sindri_core::extension_dev_dir(&ext_id)
        .map_err(|e| format!("cannot resolve dev dir: {e}"))?;
    copy_ext_to_dev_dir(&ext_dir, &dev_dir)?;

    // Spawn background watcher (stdout/stderr suppressed — app is the UI)
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
/// Does NOT rebuild — just spawns `sindri ext watch` against the stored source dir.
/// Returns the dev dir path so the TS layer can activate the last-built bundle.
#[tauri::command]
async fn ext_restart_watch(
    watch_processes: State<'_, WatchProcesses>,
    ext_id: String,
    folder_path: String,
) -> Result<String, String> {
    let dev_dir = sindri_core::extension_dev_dir(&ext_id)
        .map_err(|e| e.to_string())?;

    // If the dev dir doesn't exist yet, the extension needs a full load-from-source.
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
async fn ext_stop_dev_watch(
    watch_processes: State<'_, WatchProcesses>,
    ext_id: String,
) -> Result<(), String> {
    if let Some(mut child) = watch_processes.lock().unwrap().remove(&ext_id) {
        let _ = child.kill();
    }
    Ok(())
}

/// ADR-0037: start the CDP gateway (lazily) and return the WebSocket debugger URL
/// for the given extension. Only available in debug builds or when SINDRI_INSPECT=1.
///
/// Frontend flow: quick-pick from `ext_list_loaded_extensions`, call this command
/// with the chosen id, then display the returned `ws://` URL so the author can
/// paste it into VS Code's `attach` launch config or open `chrome://inspect`.
#[tauri::command]
async fn ext_attach_debugger(host: State<'_, ExtHost>, ext_id: String) -> Result<String, String> {
    host.attach_debugger(&ext_id)
        .ok_or_else(|| format!("extension '{ext_id}' not loaded or inspector not available"))
}

/// Return all loaded extension ids and display names for the "Attach Debugger" quick-pick.
#[tauri::command]
async fn ext_list_loaded_extensions(host: State<'_, ExtHost>) -> Result<Vec<String>, String> {
    Ok(host.loaded_extension_ids().into_iter().map(|(id, _)| id).collect())
}

/// Exit debug mode for `ext_id`, closing all active inspector sessions.
#[tauri::command]
async fn ext_stop_debugger(host: State<'_, ExtHost>, ext_id: String) -> Result<(), String> {
    if !host.stop_debugger(&ext_id) {
        return Err(format!("extension '{ext_id}' not loaded"));
    }
    Ok(())
}

/// Deactivate (unload) a running extension by id. Drops the V8 isolate thread.
/// Called by the frontend when uninstalling an extension.
/// Gracefully shuts down the JS runtime (calls deactivate() + disposes subscriptions)
/// before dropping the isolate, so cleanup events fire on the frontend.
#[tauri::command]
async fn ext_deactivate(host: State<'_, ExtHost>, ext_id: String) -> Result<(), String> {
    // Clone the Arc so we can await outside the mutex.
    let rt = host.get_runtime(&ext_id);
    if let Some(rt) = rt {
        // Best-effort: ignore errors (runtime may already be gone).
        let _ = rt.deactivate_gracefully().await;
    }
    host.deactivate(&ext_id);
    Ok(())
}

#[tauri::command]
#[cfg(debug_assertions)]
async fn toggle_devtools(window: tauri::WebviewWindow) {
    if window.is_devtools_open() {
        window.close_devtools();
    } else {
        window.open_devtools();
    }
}

// ─────────────────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let active_env: ActiveEnv = Arc::new(LocalEnvironment);
    let workspace_root: WorkspaceRoot = Arc::new(Mutex::new(None));
    let ext_bundle_sources: ExtBundleSources = Arc::new(Mutex::new(HashMap::new()));
    let watch_processes: WatchProcesses = Arc::new(Mutex::new(HashMap::new()));
    let (ext_host, event_rx) = ExtHost::new();
    build_app(active_env, workspace_root, ext_bundle_sources, watch_processes, ext_host, event_rx)
        .run(tauri::generate_context!())
        .expect("error while running Sindri");
}

/// Assemble the Tauri builder. Split out of [`run`] so tests can build a mock
/// app (or just exercise the context) without launching the event loop.
fn build_app(
    active_env: ActiveEnv,
    workspace_root: WorkspaceRoot,
    ext_bundle_sources: ExtBundleSources,
    watch_processes: WatchProcesses,
    ext_host: ExtHost,
    event_rx: tokio::sync::mpsc::UnboundedReceiver<(String, String)>,
) -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(active_env)
        .manage(workspace_root)
        .manage(ext_bundle_sources)
        .manage(watch_processes.clone())
        .manage(ext_host)
        .register_uri_scheme_protocol("sindri-resource", |ctx, request| {
            handle_sindri_resource(ctx.app_handle(), request)
        })
        .on_window_event({
            let watch_for_exit = Arc::clone(&watch_processes);
            move |_window, event| {
                if let tauri::WindowEvent::Destroyed = event {
                    if let Ok(mut procs) = watch_for_exit.try_lock() {
                        for (_, mut child) in procs.drain() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut rx = event_rx;
                while let Some((id, payload)) = rx.recv().await {
                    let _ = handle.emit("ext-event", serde_json::json!({ "id": id, "payload": payload }));
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_file, write_file, list_dir, create_file, create_dir,
            set_workspace_root,
            ext_activate, ext_activate_sinxt, install_sinxt, install_sinxt_from_path,
            ext_execute_command, ext_dispatch_event,
            ext_tree_view_get_children, ext_quick_pick_result,
            ext_webview_panel_message,
            ext_editor_read_result, ext_editor_provide_decorations,
            file_mtime, ext_dev_dir,
            ext_load_from_source, ext_restart_watch, ext_stop_dev_watch,
            ext_attach_debugger, ext_list_loaded_extensions, ext_stop_debugger, ext_deactivate,
            #[cfg(debug_assertions)]
            toggle_devtools,
        ])
}

#[cfg(test)]
mod path_parity {
    //! ADR-0033 §3: the CLI computes data dirs without a Tauri runtime, so a
    //! Tauri-verified test guards against drift. If a future Tauri version
    //! changes its path convention, this fails loudly rather than the CLI
    //! silently writing to the wrong place.
    use tauri::Manager;

    #[test]
    fn core_app_data_dir_matches_tauri() {
        // `generate_context!()` can only expand once per crate (it embeds the
        // Info.plist symbol, already taken by `run`), so build a mock context and
        // inject the real bundle identifier. The path plugin then resolves exactly
        // as the shipping app would, making this a true comparison of Tauri's
        // resolver against sindri-core's.
        let mut ctx = tauri::test::mock_context(tauri::test::noop_assets());
        ctx.config_mut().identifier = sindri_core::IDENTIFIER.to_string();
        let app = tauri::test::mock_builder().build(ctx).expect("mock app");

        let tauri_dir = app.path().app_data_dir().expect("tauri app_data_dir");
        let core_dir = sindri_core::app_data_dir().expect("core app_data_dir");
        assert_eq!(
            core_dir, tauri_dir,
            "sindri_core::app_data_dir() must equal Tauri's app_data_dir()"
        );
    }
}
