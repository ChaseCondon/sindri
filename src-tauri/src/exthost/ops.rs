use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use deno_core::{extension, op2, OpState};
use deno_error::JsErrorBox;
use tokio::sync::{mpsc, oneshot};

pub(super) fn env_err(e: crate::env::EnvError) -> JsErrorBox {
    use crate::env::EnvError::*;
    let code = match &e {
        NotFound(_) => "NOT_FOUND",
        AlreadyExists(_) => "ALREADY_EXISTS",
        InvalidSpec(_) => "INVALID_SPEC",
        Glob(_) => "GLOB_ERROR",
        Io { .. } => "IO",
        Spawn { .. } => "SPAWN_FAILED",
    };
    JsErrorBox::generic(format!("{code}\x00{e}"))
}

#[op2]
#[string]
async fn op_fs_read(
    state: Rc<RefCell<OpState>>,
    #[string] path: String,
) -> Result<String, JsErrorBox> {
    let env: Arc<dyn crate::env::Environment> =
        state.borrow().borrow::<Arc<dyn crate::env::Environment>>().clone();
    env.fs_read(&path).await.map_err(env_err)
}

#[op2]
async fn op_fs_write(
    state: Rc<RefCell<OpState>>,
    #[string] path: String,
    #[string] content: String,
) -> Result<(), JsErrorBox> {
    let env: Arc<dyn crate::env::Environment> =
        state.borrow().borrow::<Arc<dyn crate::env::Environment>>().clone();
    env.fs_write(&path, &content).await.map_err(env_err)
}

#[op2]
async fn op_fs_exists(
    state: Rc<RefCell<OpState>>,
    #[string] path: String,
) -> Result<bool, JsErrorBox> {
    let env: Arc<dyn crate::env::Environment> =
        state.borrow().borrow::<Arc<dyn crate::env::Environment>>().clone();
    env.fs_exists(&path).await.map_err(env_err)
}

#[op2]
#[serde]
async fn op_fs_glob(
    state: Rc<RefCell<OpState>>,
    #[string] pattern: String,
) -> Result<Vec<String>, JsErrorBox> {
    let env: Arc<dyn crate::env::Environment> =
        state.borrow().borrow::<Arc<dyn crate::env::Environment>>().clone();
    env.fs_glob(&pattern).await.map_err(env_err)
}

/// Result returned by `sindri.env.exec` to extension JS.
#[derive(Debug, serde::Serialize)]
pub(super) struct ExecResult {
    stdout: String,
    stderr: String,
    /// Exit code, or -1 if the process was terminated by a signal.
    code: i32,
}

/// Run a process to completion and return its captured stdout/stderr/code.
/// `cmd` is the program; `args` are the remaining argv elements.
/// This is the JS-facing impl of `sindri.env.exec(cmd, args, cwd?)`.
/// `cwd` defaults to the workspace root injected at activation; pass `null` to omit.
#[op2]
#[serde]
async fn op_env_exec(
    state: Rc<RefCell<OpState>>,
    #[string] cmd: String,
    #[serde] args: Vec<String>,
    #[string] cwd: Option<String>,
) -> Result<ExecResult, JsErrorBox> {
    let env: Arc<dyn crate::env::Environment> =
        state.borrow().borrow::<Arc<dyn crate::env::Environment>>().clone();
    let spec = crate::env::ProcessSpec {
        argv: std::iter::once(cmd).chain(args).collect(),
        cwd,
        env: std::collections::HashMap::new(),
        stdin: crate::env::StdinMode::Null,
    };
    let out = env.exec(&spec).await.map_err(env_err)?;
    Ok(ExecResult {
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        code: out.code.unwrap_or(-1),
    })
}

/// Emitted by `sindri.events.emit(id, payload)` in extension JS.
/// Delivers the event to the `UnboundedSender` stored in `OpState` (if present).
/// The op is synchronous (fire-and-forget) — no round-trip to the event loop needed.
#[op2(fast)]
fn op_event_emit(
    state: &OpState,
    #[string] id: String,
    #[string] payload: String,
) -> Result<(), JsErrorBox> {
    if let Some(tx) = state.try_borrow::<mpsc::UnboundedSender<(String, String)>>() {
        let _ = tx.send((id, payload));
    }
    Ok(())
}

/// Pending showQuickPick requests: requestId → oneshot sender for the chosen item JSON (or None for cancel).
/// Shared between the op (JS thread) and ExtensionRuntime (Tauri command thread) via Arc<Mutex>.
pub type PendingQuickPicks = Arc<Mutex<HashMap<String, oneshot::Sender<Option<String>>>>>;

/// Pending sindri.editor async proxy reads: requestId → oneshot sender for the JSON result string.
/// Newtype wrapper so OpState can hold both PendingQuickPicks and PendingEditorReads simultaneously
/// (OpState keys by TypeId; a type alias would collide with PendingQuickPicks).
pub struct PendingEditorReads(pub Arc<Mutex<HashMap<String, oneshot::Sender<Option<String>>>>>);

impl PendingEditorReads {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(HashMap::new())))
    }
    pub fn clone_inner(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

/// Blocks until the frontend delivers a quick-pick result for `request_id`.
/// Emits `__sindri.ui.quickPickShow` to the frontend (fire-and-forget via event_tx),
/// then awaits the oneshot that `ExtensionRuntime::resolve_quick_pick` will signal.
/// Returns the chosen item as a JSON string, or "null" if cancelled.
#[op2]
#[string]
async fn op_ui_show_quick_pick(
    state: Rc<RefCell<OpState>>,
    #[string] request_id: String,
    #[string] payload_json: String,
) -> Result<String, JsErrorBox> {
    let event_tx: EventTx = state.borrow().borrow::<EventTx>().clone();
    let pending: PendingQuickPicks = state.borrow().borrow::<PendingQuickPicks>().clone();

    let (tx, rx) = oneshot::channel::<Option<String>>();
    pending.lock().unwrap().insert(request_id.clone(), tx);

    let _ = event_tx.send(("__sindri.ui.quickPickShow".to_string(), payload_json));

    match rx.await {
        Ok(Some(item_json)) => Ok(item_json),
        _ => Ok("null".to_string()),
    }
}

/// Async proxy read for sindri.editor document methods (getText, lineAt, positionAt, offsetAt).
/// Emits "__sindri.editor.readReq" to the webview via the event bus; blocks until the webview
/// responds via ext_editor_read_result (Tauri command), exactly mirroring op_ui_show_quick_pick.
#[op2]
#[string]
async fn op_editor_request(
    state: Rc<RefCell<OpState>>,
    #[string] request_id: String,
    #[string] req_json: String,
) -> Result<String, JsErrorBox> {
    let event_tx: EventTx = state.borrow().borrow::<EventTx>().clone();
    let pending = state.borrow().borrow::<PendingEditorReads>().clone_inner();

    let (tx, rx) = oneshot::channel::<Option<String>>();
    pending.0.lock().unwrap().insert(request_id.clone(), tx);

    let payload = format!(
        r#"{{"requestId":{},"req":{}}}"#,
        serde_json::to_string(&request_id).unwrap_or_else(|_| format!("{request_id:?}")),
        req_json,
    );
    let _ = event_tx.send(("__sindri.editor.readReq".to_string(), payload));

    match rx.await {
        Ok(Some(result)) => Ok(result),
        _ => Ok("null".to_string()),
    }
}

/// Read a file as raw bytes and return it as a Uint8Array.
/// Used by sindri.wasm.load() to get WASM module bytes into the isolate (ADR-0035).
/// Path must be absolute; resolving relative-to-bundle-dir happens in the JS bootstrap.
#[op2]
#[buffer]
async fn op_wasm_load(#[string] path: String) -> Result<Vec<u8>, JsErrorBox> {
    tokio::fs::read(&path).await.map_err(|e| JsErrorBox::generic(e.to_string()))
}

/// Sleep for `ms` milliseconds. Used by the JS bootstrap to implement setTimeout/setInterval.
#[op2]
async fn op_sleep_ms(#[smi] ms: u32) -> Result<(), JsErrorBox> {
    tokio::time::sleep(std::time::Duration::from_millis(u64::from(ms))).await;
    Ok(())
}

extension!(sindri_ext, ops = [op_fs_read, op_fs_write, op_fs_exists, op_fs_glob, op_event_emit, op_env_exec, op_ui_show_quick_pick, op_editor_request, op_wasm_load, op_sleep_ms]);

/// Sender half of the extension-event channel.
/// Extensions call `sindri.events.emit(id, payload)` → `op_event_emit` → this sender.
/// The receiver is held by the caller (e.g. `ExtHost`) to forward events to Tauri.
pub type EventTx = mpsc::UnboundedSender<(String, String)>;
