//! Tree-sitter syntax engine — Tauri commands + background worker (ADR-0041).
//!
//! All parse state lives on a dedicated std::thread (`worker::SyntaxWorker`).
//! These Tauri commands are thin async wrappers: they enqueue a request on the
//! worker channel and await the oneshot reply.

mod worker;
mod grammars;
#[cfg(test)]
mod tests;

pub use worker::SyntaxWorker;
pub use grammars::register_builtins as register_builtin_grammars;
use worker::WorkerRequest;

use tokio::sync::oneshot;

// ── Wire types ────────────────────────────────────────────────────────────────

/// A single syntax highlight span, serialized camelCase to JS.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Highlight {
    pub start: u32,
    pub end: u32,
    pub token: String,
}

/// One incremental document edit, carrying both tree-sitter metadata and the
/// replacement text so the Rust side can maintain the document bytes.
///
/// All byte offsets are in the **pre-change** coordinate space.
/// JS sends camelCase; serde maps the fields accordingly.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputEditDelta {
    pub start_byte: u32,
    pub old_end_byte: u32,
    pub new_end_byte: u32,
    pub start_row: u32,
    pub start_col: u32,
    pub old_end_row: u32,
    pub old_end_col: u32,
    pub new_end_row: u32,
    pub new_end_col: u32,
    /// New text for the replaced byte range `[start_byte, old_end_byte)`.
    pub replacement: String,
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Open a document: full parse + return highlights.
///
/// For docs below 128 KiB the entire document is highlighted; for larger docs
/// only the supplied viewport range is queried (ADR-0041 §4 addendum). The
/// CM6 bridge always passes the initial visible viewport so large files get an
/// accurate first paint without producing a 50k-span payload.
#[tauri::command]
pub async fn ts_open(
    worker: tauri::State<'_, SyntaxWorker>,
    doc_id: String,
    language_id: String,
    text: String,
    viewport_start: u32,
    viewport_end: u32,
) -> Result<Vec<Highlight>, String> {
    send_recv(&worker, |reply| WorkerRequest::Open {
        doc_id,
        language_id,
        text,
        viewport_start,
        viewport_end,
        reply,
    })
    .await
}

/// Apply incremental edits and return highlights for the current viewport.
#[tauri::command]
pub async fn ts_edit(
    worker: tauri::State<'_, SyntaxWorker>,
    doc_id: String,
    edits: Vec<InputEditDelta>,
    viewport_start: u32,
    viewport_end: u32,
) -> Result<Vec<Highlight>, String> {
    send_recv(&worker, |reply| WorkerRequest::Edit {
        doc_id,
        edits,
        viewport_start,
        viewport_end,
        reply,
    })
    .await
}

/// Re-query highlights for a new viewport without applying any edits.
#[tauri::command]
pub async fn ts_highlight(
    worker: tauri::State<'_, SyntaxWorker>,
    doc_id: String,
    viewport_start: u32,
    viewport_end: u32,
) -> Result<Vec<Highlight>, String> {
    send_recv(&worker, |reply| WorkerRequest::Highlight {
        doc_id,
        viewport_start,
        viewport_end,
        reply,
    })
    .await
}

/// Drop a document's parse state (tree + parser + store).
#[tauri::command]
pub async fn ts_close(
    worker: tauri::State<'_, SyntaxWorker>,
    doc_id: String,
) -> Result<(), String> {
    worker
        .tx
        .send(WorkerRequest::Close { doc_id })
        .map_err(|_| "syntax worker offline".to_string())
}

/// Register a grammar into the worker registry.
///
/// Called at startup for built-in grammars (item 3) and at extension activation
/// for contributed grammars (item 4, ADR-0041 §5). Extension-contributed grammars
/// override a built-in of the same `language_id`.
#[tauri::command]
pub async fn ts_register_grammar(
    worker: tauri::State<'_, SyntaxWorker>,
    language_id: String,
    wasm: Vec<u8>,
    highlights_scm: String,
    extensions: Vec<String>,
) -> Result<(), String> {
    worker
        .tx
        .send(WorkerRequest::RegisterGrammar { language_id, wasm, highlights_scm, extensions })
        .map_err(|_| "syntax worker offline".to_string())
}

// ── Helper ────────────────────────────────────────────────────────────────────

async fn send_recv<F>(
    worker: &tauri::State<'_, SyntaxWorker>,
    make_req: F,
) -> Result<Vec<Highlight>, String>
where
    F: FnOnce(oneshot::Sender<Result<Vec<Highlight>, String>>) -> WorkerRequest,
{
    let (tx, rx) = oneshot::channel();
    worker
        .tx
        .send(make_req(tx))
        .map_err(|_| "syntax worker offline".to_string())?;
    rx.await.map_err(|_| "syntax worker dropped reply".to_string())?
}
