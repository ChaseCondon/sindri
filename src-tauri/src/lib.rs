mod env;
pub mod exthost;

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
    let wr = workspace_root.lock().unwrap().clone();
    host.activate(&bundle_path, ext_id.as_deref(), wr.as_deref(), (*env).clone())
        .await
        .map_err(|e| e.to_string())
}

/// Activate an extension from an installed `.sinxt` archive.
/// Reads `dist/bundle.js` out of the zip in-memory; registers the sinxt path as
/// the asset source for `sindri-resource://` so subsequent asset requests are
/// served directly from zip entries without disk extraction.
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

    // Read bundle.js from the zip in memory.
    let bundle_js = read_sinxt_entry(&sinxt, "dist/bundle.js")
        .map_err(|e| format!("failed to read bundle.js from .sinxt: {e}"))?;
    let bundle_js = String::from_utf8(bundle_js)
        .map_err(|_| "bundle.js is not valid UTF-8".to_string())?;

    // Write bundle.js to a temp file so deno_core can load it (deno_core needs a
    // path, not raw bytes). Temp file is keyed on ext_id to avoid collisions.
    let tmp_dir = std::env::temp_dir().join("sindri-sinxt-bundles");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
    let tmp_bundle = tmp_dir.join(format!("{ext_id}.bundle.js"));
    std::fs::write(&tmp_bundle, &bundle_js).map_err(|e| e.to_string())?;

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
    )
    .await
    .map_err(|e| e.to_string())
}

/// Install a `.sinxt` bundle from raw bytes into `app_data_dir/extensions/<id>/<version>/`.
/// Returns the absolute path to the installed `.sinxt` file.
/// Called from the TypeScript download pipeline after fetching the archive bytes.
#[tauri::command]
async fn install_sinxt(
    app: tauri::AppHandle,
    ext_id: String,
    version: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app_data_dir: {e}"))?;

    let install_dir = base.join("extensions").join(&ext_id).join(&version);
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

// ── sindri-resource:// protocol (ADR-0031) ────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let active_env: ActiveEnv = Arc::new(LocalEnvironment);
    let workspace_root: WorkspaceRoot = Arc::new(Mutex::new(None));
    let ext_bundle_sources: ExtBundleSources = Arc::new(Mutex::new(HashMap::new()));
    let (ext_host, event_rx) = ExtHost::new();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(active_env)
        .manage(workspace_root)
        .manage(ext_bundle_sources)
        .manage(ext_host)
        .register_uri_scheme_protocol("sindri-resource", |ctx, request| {
            handle_sindri_resource(ctx.app_handle(), request)
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
            ext_activate, ext_activate_sinxt, install_sinxt,
            ext_execute_command, ext_dispatch_event,
            ext_tree_view_get_children, ext_quick_pick_result,
            ext_webview_panel_message,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Sindri");
}
