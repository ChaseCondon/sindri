//! Built-in tree-sitter grammars bundled at compile time (ADR-0041 §item3).
//!
//! WASM bytes and highlights.scm are embedded via include_bytes!/include_str!.
//! Called once at app startup; the worker caches compiled WASM so subsequent
//! document opens pay only instantiation cost, not JIT cost.

use super::worker::WorkerRequest;
use super::SyntaxWorker;

pub(crate) static RUST_WASM: &[u8] =
    include_bytes!("../../assets/grammars/rust/tree-sitter-rust.wasm");
pub(crate) static RUST_HIGHLIGHTS: &str =
    include_str!("../../assets/grammars/rust/highlights.scm");

static TYPESCRIPT_WASM: &[u8] =
    include_bytes!("../../assets/grammars/typescript/tree-sitter-typescript.wasm");
static TYPESCRIPT_HIGHLIGHTS: &str =
    include_str!("../../assets/grammars/typescript/highlights.scm");

/// Seed the syntax worker with the two bootstrap grammars.
///
/// Call once after `SyntaxWorker::spawn()`. The worker processes these
/// synchronously on its thread before any document opens arrive.
pub fn register_builtins(worker: &SyntaxWorker) -> Result<(), String> {
    let send = |req: WorkerRequest| {
        worker.tx.send(req).map_err(|_| "syntax worker offline".to_string())
    };

    send(WorkerRequest::RegisterGrammar {
        language_id: "rust".into(),
        wasm: RUST_WASM.to_vec(),
        highlights_scm: RUST_HIGHLIGHTS.to_string(),
        extensions: vec!["rs".into()],
    })?;

    send(WorkerRequest::RegisterGrammar {
        language_id: "typescript".into(),
        wasm: TYPESCRIPT_WASM.to_vec(),
        highlights_scm: TYPESCRIPT_HIGHLIGHTS.to_string(),
        extensions: vec!["ts".into()],
    })?;

    Ok(())
}
