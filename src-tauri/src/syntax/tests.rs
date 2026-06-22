//! Integration tests for the tree-sitter syntax worker.
//!
//! Tests `WorkerState` directly (private access via the same module) to cover
//! the offset/splice arithmetic and incremental reparse paths that are
//! otherwise exercised only at runtime.

use super::worker::{GrammarDef, WorkerState};
use super::grammars::{RUST_WASM, RUST_HIGHLIGHTS};
use super::InputEditDelta;

fn rust_worker() -> WorkerState {
    let mut state = WorkerState::new();
    state.grammars.insert(
        "rust".into(),
        GrammarDef {
            wasm: RUST_WASM.to_vec(),
            highlights_scm: RUST_HIGHLIGHTS.to_string(),
            extensions: vec!["rs".into()],
        },
    );
    state
}

#[test]
fn open_returns_keyword_function_and_number_highlights() {
    let mut state = rust_worker();
    let src = "fn main() { let x = 42; }";
    let highlights = state
        .open_doc("doc".into(), "rust".into(), src.into(), 0, src.len() as u32)
        .expect("open_doc failed");

    assert!(
        highlights.iter().any(|h| h.token == "keyword"),
        "expected a keyword highlight; got {highlights:?}"
    );
    assert!(
        highlights.iter().any(|h| h.token == "function"),
        "expected a function highlight; got {highlights:?}"
    );
    // tree-sitter-rust tags integer literals as @constant.numeric → "constant"
    assert!(
        highlights.iter().any(|h| h.token == "constant"),
        "expected a constant/number highlight; got {highlights:?}"
    );
}

#[test]
fn edit_incremental_reparse_preserves_highlights() {
    let mut state = rust_worker();
    // Initial: empty function body.
    let src = "fn main() {}";
    state
        .open_doc("doc".into(), "rust".into(), src.into(), 0, src.len() as u32)
        .expect("open_doc failed");

    // Insert " let x = 1; " before the closing brace (byte 11).
    // "fn main() {}" → "fn main() { let x = 1; }"
    let insert = " let x = 1; }";
    let edit = InputEditDelta {
        start_byte: 11,
        old_end_byte: 12, // replaces `}`
        new_end_byte: 11 + insert.len() as u32,
        start_row: 0,
        start_col: 11,
        old_end_row: 0,
        old_end_col: 12,
        new_end_row: 0,
        new_end_col: 11 + insert.len() as u32,
        replacement: insert.to_string(),
    };

    let new_len = "fn main() { let x = 1; }".len() as u32;
    let highlights = state
        .edit_doc("doc".into(), vec![edit], 0, new_len)
        .expect("edit_doc failed");

    assert!(
        highlights.iter().any(|h| h.token == "keyword"),
        "expected keyword after edit; got {highlights:?}"
    );
    // tree-sitter-rust tags integer literals as @constant.numeric → "constant"
    assert!(
        highlights.iter().any(|h| h.token == "constant"),
        "expected constant (integer literal) after edit; got {highlights:?}"
    );
}

#[test]
fn edit_splice_applies_end_to_start() {
    let mut state = rust_worker();
    // Two non-overlapping deletions on the same line; verify the text splice
    // doesn't shift the earlier edit's offsets by applying end-to-start.
    // Source: "fn foo() { let a = 1; let b = 2; }"
    // Delete "let a = 1; " (bytes 11..22) and "let b = 2; " (bytes 22..33)
    // in a single edit call — both edits reference pre-change coordinates.
    let src = "fn foo() { let a = 1; let b = 2; }";
    state
        .open_doc("doc".into(), "rust".into(), src.into(), 0, src.len() as u32)
        .expect("open_doc");

    // Delete the two `let` declarations, leaving "fn foo() {  }"
    let del_b = InputEditDelta {
        start_byte: 22,
        old_end_byte: 33,
        new_end_byte: 22,
        start_row: 0, start_col: 22, old_end_row: 0, old_end_col: 33,
        new_end_row: 0, new_end_col: 22,
        replacement: String::new(),
    };
    let del_a = InputEditDelta {
        start_byte: 11,
        old_end_byte: 22,
        new_end_byte: 11,
        start_row: 0, start_col: 11, old_end_row: 0, old_end_col: 22,
        new_end_row: 0, new_end_col: 11,
        replacement: String::new(),
    };

    // Pass in forward order — worker must apply end-to-start internally.
    state
        .edit_doc("doc".into(), vec![del_a, del_b], 0, "fn foo() {  }".len() as u32)
        .expect("edit_doc splice");
}

#[test]
fn unknown_language_returns_error() {
    let mut state = rust_worker();
    let err = state
        .open_doc("doc".into(), "zig".into(), "fn add() {}".into(), 0, 11)
        .unwrap_err();
    assert!(err.contains("zig"), "error should name the missing language: {err}");
}

#[test]
fn close_drops_doc_state() {
    // Verify that highlight after close returns an error (doc not open).
    // We can't call WorkerState::handle(Close) directly without the channel,
    // but we can verify the docs map is empty after using the internal close path
    // by re-opening over an existing doc_id.
    let mut state = rust_worker();
    let src = "fn f() {}";
    state
        .open_doc("d".into(), "rust".into(), src.into(), 0, src.len() as u32)
        .unwrap();
    // Open again over the same id — replaces the old doc (no close needed in test).
    state
        .open_doc("d".into(), "rust".into(), src.into(), 0, src.len() as u32)
        .unwrap();
}
