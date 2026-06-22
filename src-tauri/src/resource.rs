/// sindri-resource:// custom protocol handler (ADR-0031).
///
/// Extensions request their bundled assets via `sindri-resource://<ext_id>/<rel_path>`.
/// Sources may be an exploded directory (dev-mode) or a `.sinxt` zip archive (installed).
use std::collections::HashMap;
use std::io::Read as _;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::Manager;

/// Where an extension's assets live. Either an exploded directory (dev-mode) or
/// a `.sinxt` zip archive (installed via marketplace / local file picker).
pub(crate) enum ExtBundleSource {
    /// Path to the directory containing `bundle.js` and sibling assets (ADR-0031, dev path).
    Dir(PathBuf),
    /// Path to a `.sinxt` zip; assets are read from entries on demand.
    Sinxt(PathBuf),
}

/// ext-id → asset source, populated during ext_activate / ext_activate_sinxt.
pub(crate) type ExtBundleSources = Arc<Mutex<HashMap<String, ExtBundleSource>>>;

/// Reject any path component that could escape the bundle directory.
/// Disallows '..', absolute roots, and '%'-encoded sequences (bypass guard).
pub(crate) fn is_safe_resource_path(path: &str) -> bool {
    use std::path::{Component, Path};
    if path.contains('%') {
        return false;
    }
    Path::new(path)
        .components()
        .all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
}

pub(crate) fn mime_for_ext(ext: Option<&str>) -> &'static str {
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

pub(crate) fn sindri_resource_response(
    status: u16,
    content_type: &'static str,
    body: Vec<u8>,
) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("content-type", content_type)
        .body(body)
        // Builder only fails on invalid header values; content_type is a &'static str
        // constant we control, so this invariant holds at all call sites.
        .expect("static content-type header is always a valid header value")
}

/// Read a single named entry from a `.sinxt` zip archive, decompressing into memory.
pub(crate) fn read_sinxt_entry(sinxt_path: &PathBuf, entry_name: &str) -> Result<Vec<u8>, String> {
    let file = std::fs::File::open(sinxt_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut entry = archive
        .by_name(entry_name)
        .map_err(|_| format!("entry '{entry_name}' not found in archive"))?;
    let mut buf = Vec::with_capacity(entry.size() as usize);
    entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

pub(crate) fn handle_sindri_resource<R: tauri::Runtime>(
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

/// Simple Either type to avoid a dependency for the two-branch resource handler.
enum Either<L, R> {
    Left(L),
    Right(R),
}
