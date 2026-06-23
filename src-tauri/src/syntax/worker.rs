//! Single-threaded tree-sitter syntax worker (ADR-0041 §3).
//!
//! All parse state (Engine, WasmStore, Parser, Tree, compiled Query) lives on a
//! dedicated std::thread. Tauri commands communicate with it via an unbounded
//! mpsc channel; replies come back on per-request oneshot channels.
//!
//! WasmStore is !Send, so the worker MUST be a std::thread (not a tokio task).

use std::collections::HashMap;

use streaming_iterator::StreamingIterator;
use tokio::sync::{mpsc, oneshot};
use tree_sitter::{InputEdit, Parser, Point, Query, QueryCursor, Tree, WasmStore};

use super::{Highlight, InputEditDelta};

/// Documents below this byte length receive a full-doc initial highlight query.
/// At or above this threshold the query is viewport-ranged (ADR-0041 §4 addendum).
const FULL_DOC_THRESHOLD: usize = 128 * 1024;

// ── Public handle ─────────────────────────────────────────────────────────────

/// Cheap-to-clone handle to the background syntax worker thread.
pub struct SyntaxWorker {
    pub(super) tx: mpsc::UnboundedSender<WorkerRequest>,
}

impl SyntaxWorker {
    /// Spawn the background thread and return a handle.
    pub fn spawn() -> Self {
        let (tx, rx) = mpsc::unbounded_channel::<WorkerRequest>();
        std::thread::Builder::new()
            .name("sindri-syntax".into())
            .spawn(move || run_worker(rx))
            .expect("failed to spawn syntax worker thread");
        Self { tx }
    }

    /// Register (or replace) a grammar. Fire-and-forget; the worker processes it
    /// before the next document open so activation-time registration is safe.
    pub fn register_grammar(
        &self,
        language_id: String,
        wasm: Vec<u8>,
        highlights_scm: String,
        extensions: Vec<String>,
    ) {
        let _ = self.tx.send(WorkerRequest::RegisterGrammar {
            language_id,
            wasm,
            highlights_scm,
            extensions,
        });
    }
}

// ── Message protocol ──────────────────────────────────────────────────────────

pub(super) enum WorkerRequest {
    Open {
        doc_id: String,
        language_id: String,
        text: String,
        viewport_start: u32,
        viewport_end: u32,
        reply: oneshot::Sender<Result<Vec<Highlight>, String>>,
    },
    Edit {
        doc_id: String,
        edits: Vec<InputEditDelta>,
        viewport_start: u32,
        viewport_end: u32,
        reply: oneshot::Sender<Result<Vec<Highlight>, String>>,
    },
    Highlight {
        doc_id: String,
        viewport_start: u32,
        viewport_end: u32,
        reply: oneshot::Sender<Result<Vec<Highlight>, String>>,
    },
    Close {
        doc_id: String,
    },
    RegisterGrammar {
        language_id: String,
        wasm: Vec<u8>,
        highlights_scm: String,
        extensions: Vec<String>,
    },
}

// ── Worker loop ───────────────────────────────────────────────────────────────

fn run_worker(mut rx: mpsc::UnboundedReceiver<WorkerRequest>) {
    let mut state = WorkerState::new();
    while let Some(msg) = rx.blocking_recv() {
        state.handle(msg);
    }
}

// ── Worker state ──────────────────────────────────────────────────────────────

pub(super) struct GrammarDef {
    pub(super) wasm: Vec<u8>,
    pub(super) highlights_scm: String,
    #[allow(dead_code)] // reserved for Phase 8 file→languageId mapping (ADR-0041 §5)
    pub(super) extensions: Vec<String>,
}

struct DocState {
    parser: Parser,
    tree: Option<Tree>,
    text: Vec<u8>,
    /// Compiled highlight query — avoids re-parsing the .scm on every call.
    query: Query,
}

pub(super) struct WorkerState {
    pub(super) engine: tree_sitter::wasmtime::Engine,
    pub(super) grammars: HashMap<String, GrammarDef>,
    docs: HashMap<String, DocState>,
}

impl WorkerState {
    pub(super) fn new() -> Self {
        Self {
            engine: tree_sitter::wasmtime::Engine::default(),
            grammars: HashMap::new(),
            docs: HashMap::new(),
        }
    }

    fn handle(&mut self, req: WorkerRequest) {
        match req {
            WorkerRequest::Open { doc_id, language_id, text, viewport_start, viewport_end, reply } => {
                let _ = reply.send(self.open_doc(doc_id, language_id, text, viewport_start, viewport_end));
            }
            WorkerRequest::Edit { doc_id, edits, viewport_start, viewport_end, reply } => {
                let _ = reply.send(self.edit_doc(doc_id, edits, viewport_start, viewport_end));
            }
            WorkerRequest::Highlight { doc_id, viewport_start, viewport_end, reply } => {
                let _ = reply.send(self.highlight_doc(&doc_id, viewport_start, viewport_end));
            }
            WorkerRequest::Close { doc_id } => {
                self.docs.remove(&doc_id);
            }
            WorkerRequest::RegisterGrammar { language_id, wasm, highlights_scm, extensions } => {
                self.grammars.insert(language_id, GrammarDef { wasm, highlights_scm, extensions });
            }
        }
    }

    // ── Commands ──────────────────────────────────────────────────────────────

    pub(super) fn open_doc(
        &mut self,
        doc_id: String,
        language_id: String,
        text: String,
        viewport_start: u32,
        viewport_end: u32,
    ) -> Result<Vec<Highlight>, String> {
        let grammar = self.grammars.get(&language_id)
            .ok_or_else(|| format!("no grammar registered for '{language_id}'"))?;

        let mut store = WasmStore::new(&self.engine)
            .map_err(|e| format!("WasmStore::new: {e}"))?;
        let language = store.load_language(&language_id, &grammar.wasm)
            .map_err(|e| format!("load_language '{language_id}': {e}"))?;

        let query = Query::new(&language, &grammar.highlights_scm)
            .map_err(|e| format!("Query::new for '{language_id}': {e}"))?;

        let mut parser = Parser::new();
        parser.set_wasm_store(store)
            .map_err(|e| format!("set_wasm_store: {e}"))?;
        parser.set_language(&language)
            .map_err(|e| format!("set_language: {e}"))?;

        let text_bytes = text.into_bytes();
        let tree = parser.parse(&text_bytes, None);

        // Full-doc highlights for small files; viewport-ranged for large ones
        // (ADR-0041 §4 addendum: T = 128 KiB).
        let highlights = if let Some(ref t) = tree {
            let (hl_start, hl_end) = if text_bytes.len() < FULL_DOC_THRESHOLD {
                (0, text_bytes.len() as u32)
            } else {
                (viewport_start, viewport_end)
            };
            query_highlights(&query, t, &text_bytes, hl_start, hl_end)
        } else {
            vec![]
        };

        self.docs.insert(doc_id, DocState {
            parser,
            tree,
            text: text_bytes,
            query,
        });

        Ok(highlights)
    }

    pub(super) fn edit_doc(
        &mut self,
        doc_id: String,
        edits: Vec<InputEditDelta>,
        viewport_start: u32,
        viewport_end: u32,
    ) -> Result<Vec<Highlight>, String> {
        let doc = self.docs.get_mut(&doc_id)
            .ok_or_else(|| format!("doc '{doc_id}' not open"))?;

        // Apply tree edits (uses pre-change byte offsets).
        if let Some(ref mut tree) = doc.tree {
            for d in &edits {
                tree.edit(&InputEdit {
                    start_byte: d.start_byte as usize,
                    old_end_byte: d.old_end_byte as usize,
                    new_end_byte: d.new_end_byte as usize,
                    start_position: Point::new(d.start_row as usize, d.start_col as usize),
                    old_end_position: Point::new(d.old_end_row as usize, d.old_end_col as usize),
                    new_end_position: Point::new(d.new_end_row as usize, d.new_end_col as usize),
                });
            }
        }

        // Apply text mutations end-to-start to preserve earlier offsets.
        let mut sorted = edits;
        sorted.sort_unstable_by(|a, b| b.start_byte.cmp(&a.start_byte));
        for d in &sorted {
            let start = d.start_byte as usize;
            let old_end = (d.old_end_byte as usize).min(doc.text.len());
            doc.text.splice(start..old_end, d.replacement.bytes());
        }

        // Reparse incrementally.
        let old_tree = doc.tree.take();
        doc.tree = doc.parser.parse(&doc.text, old_tree.as_ref());

        let Some(ref tree) = doc.tree else {
            return Ok(vec![]);
        };
        Ok(query_highlights(&doc.query, tree, &doc.text, viewport_start, viewport_end))
    }

    fn highlight_doc(
        &self,
        doc_id: &str,
        viewport_start: u32,
        viewport_end: u32,
    ) -> Result<Vec<Highlight>, String> {
        let doc = self.docs.get(doc_id)
            .ok_or_else(|| format!("doc '{doc_id}' not open"))?;
        let tree = doc.tree.as_ref().ok_or("no parse tree")?;

        Ok(query_highlights(&doc.query, tree, &doc.text, viewport_start, viewport_end))
    }
}

// ── Highlight query ───────────────────────────────────────────────────────────

fn query_highlights(
    query: &Query,
    tree: &Tree,
    text: &[u8],
    viewport_start: u32,
    viewport_end: u32,
) -> Vec<Highlight> {
    let mut cursor = QueryCursor::new();
    cursor.set_byte_range(viewport_start as usize..viewport_end as usize);

    let capture_names = query.capture_names();
    let mut highlights = Vec::new();

    let mut iter = cursor.matches(query, tree.root_node(), text);
    while let Some(m) = iter.next() {
        for cap in m.captures {
            let name = &capture_names[cap.index as usize];
            if let Some(token) = sindri_core::capture_to_token(name) {
                let node = cap.node;
                highlights.push(Highlight {
                    start: node.start_byte() as u32,
                    end: node.end_byte() as u32,
                    token: token.to_string(),
                });
            }
        }
    }

    highlights
}

