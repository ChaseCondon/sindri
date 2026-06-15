/// Per-extension Deno/V8 runtime (ADR-0025: uniform per-isolate, lean-configured).
///
/// `JsRuntime` is `!Send` — each extension runtime lives on a dedicated std thread
/// running a single-threaded tokio executor. `ExtensionRuntime` is a `Send` handle
/// backed by tokio mpsc/oneshot channels so callers remain fully async.
///
/// Thread teardown: when `ExtensionRuntime` is dropped the mpsc sender closes,
/// `rx.recv()` returns `None`, the runtime loop exits, and the std thread finishes.
///
/// Source maps (Step 5): when a bundle is loaded, the adjacent `.js.map` file is read
/// and stored keyed by bundle path. JS errors from that bundle have their V8 stack
/// frames translated back to the original TypeScript positions before surfacing.
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::Path;
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use deno_core::v8;
use deno_core::{
    extension, op2, InspectorSessionProxy, JsRuntime, OpState, PollEventLoopOptions,
    RuntimeOptions,
};
use deno_error::JsErrorBox;
use tokio::sync::{mpsc, oneshot};

#[derive(Debug, thiserror::Error)]
pub enum ExthostError {
    #[error("JS: {0}")]
    Js(String),
    #[error("command not found: {0}")]
    CommandNotFound(String),
    #[error("command failed: {0}")]
    CommandFailed(String),
    #[error("IO: {0}")]
    Io(#[from] std::io::Error),
    #[error("runtime channel closed")]
    RuntimeGone,
}

// ── sindri ops ───────────────────────────────────────────────────────────────
//
// Each op extracts the env Arc from OpState before every await so the Rc borrow
// does not cross the await point (required for the future to satisfy deno_core).
// Error type is JsErrorBox — what deno_core 0.403 requires for op error propagation.
//
// Structured errors: encoded as "{CODE}\x00{message}" so the JS bootstrap can
// split on \x00 and construct a SindriError with .code — without depending on
// deno_core's error class registry.

fn env_err(e: crate::env::EnvError) -> JsErrorBox {
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
struct ExecResult {
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

// Bootstrap injected into every isolate before any extension code runs.
// Exposes console, sindri.commands, sindri.env.fs, and sindri.ui wired to ops.
// Async ops are reachable via Deno.core.ops.<name>() which returns Promises.
//
// Error encoding: ops encode structured errors as "{CODE}\x00{message}".
// _wrapEnvOp parses that and re-throws as SindriError so extensions can branch
// on e.code (e.g. e.code === 'NOT_FOUND') without parsing raw strings.
const SINDRI_BOOTSTRAP: &str = r#"
globalThis.__sindri_registry = new Map();
globalThis.__sindri_events = new Map();
globalThis.__sindri_tree_views = new Map();
globalThis.__sindri_status_items = new Map();
globalThis.__sindri_webview_panels = new Map();
globalThis.__sindri_decoration_providers = new Map();
globalThis.__sindri_qp_counter = 0;
globalThis.__sindri_ext_id = "unknown";
globalThis.__sindri_editor_req_counter = 0;
globalThis.__sindri_active_editor = null;
globalThis.__sindri_visible_editors = [];
// Injected at activation: absolute path of the directory containing extension.js (ADR-0035).
globalThis.__sindri_bundle_dir = null;
// Injected at activation: map of logical binary name → absolute path for bundled binaries (ADR-0036).
globalThis.__sindri_bin_paths = {};
// Injected at activation: flat { key: translated } map from the extension's locale bundle (1.5j).
// Falls back to an empty object; sindri.l10n.t() returns the key itself when no translation found.
globalThis.__sindri_l10n_bundle = {};
globalThis.__sindri_locale = "en-US";
// ADR-0030: console lines are routed to the Extension Logs panel via __sindri.output.line.
// __sindri_ext_id is injected just before the bundle runs (do_load_and_activate) so all
// console calls during activate() carry the correct extension id.
function _emit_log(level, args) {
    const msg = args.map(function(v) {
        if (v === null) return 'null';
        if (v === undefined) return 'undefined';
        if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
        return String(v);
    }).join(" ");
    Deno.core.ops.op_event_emit("__sindri.output.line", JSON.stringify({
        extId: globalThis.__sindri_ext_id,
        channelId: "console",
        level: level,
        msg: msg,
        ts: Date.now()
    }));
}
globalThis.console = {
    log:   (...a) => _emit_log("log",   a),
    warn:  (...a) => _emit_log("warn",  a),
    error: (...a) => _emit_log("error", a),
    info:  (...a) => _emit_log("info",  a),
};

class SindriError extends Error {
    constructor(message, code) {
        super(message);
        this.name = "SindriError";
        this.code = code;
    }
}
globalThis.SindriError = SindriError;

function _wrapEnvOp(op) {
    return async function(...args) {
        try {
            return await op(...args);
        } catch (raw) {
            const msg = (raw && raw.message) ? raw.message : String(raw);
            const sep = msg.indexOf("\x00");
            if (sep !== -1) {
                throw new SindriError(msg.slice(sep + 1), msg.slice(0, sep));
            }
            throw raw;
        }
    };
}

// ── sindri.editor helpers (ADR-0034) ─────────────────────────────────────────
// _makeTextDocument / _makeTextEditor are closures over the info snapshot
// pushed by the webview via __sindri.editor.* events.
function _makeTextDocument(info) {
    if (!info) return undefined;
    return {
        get path() { return info.path; },
        get languageId() { return info.languageId; },
        get version() { return info.version; },
        get lineCount() { return info.lineCount; },
        async getText(range) {
            const reqId = 'er:' + (++globalThis.__sindri_editor_req_counter);
            const raw = await Deno.core.ops.op_editor_request(reqId, JSON.stringify({ op: 'getText', range: range ?? null }));
            return JSON.parse(raw);
        },
        async lineAt(line) {
            const reqId = 'er:' + (++globalThis.__sindri_editor_req_counter);
            const raw = await Deno.core.ops.op_editor_request(reqId, JSON.stringify({ op: 'lineAt', line }));
            return JSON.parse(raw);
        },
        async positionAt(offset) {
            const reqId = 'er:' + (++globalThis.__sindri_editor_req_counter);
            const raw = await Deno.core.ops.op_editor_request(reqId, JSON.stringify({ op: 'positionAt', offset }));
            return JSON.parse(raw);
        },
        async offsetAt(position) {
            const reqId = 'er:' + (++globalThis.__sindri_editor_req_counter);
            const raw = await Deno.core.ops.op_editor_request(reqId, JSON.stringify({ op: 'offsetAt', position }));
            return JSON.parse(raw);
        },
    };
}
function _makeTextEditor(info) {
    if (!info) return undefined;
    return {
        document: _makeTextDocument(info),
        selections: info.selections ?? [],
        visibleRanges: info.visibleRanges ?? [],
    };
}

globalThis.sindri = {
    commands: {
        register(id, cb) {
            __sindri_registry.set(id, cb);
            return { dispose: () => __sindri_registry.delete(id) };
        }
    },
    env: {
        fs: {
            read:   _wrapEnvOp((p)    => Deno.core.ops.op_fs_read(p)),
            write:  _wrapEnvOp((p, c) => Deno.core.ops.op_fs_write(p, c)),
            exists: _wrapEnvOp((p)    => Deno.core.ops.op_fs_exists(p)),
            glob:   _wrapEnvOp((p)    => Deno.core.ops.op_fs_glob(p)),
        },
        get workspaceRoot() { return globalThis.__sindri_workspace_root ?? null; },
        exec: _wrapEnvOp(async (cmd, ...args) => {
            const cwd = globalThis.__sindri_workspace_root ?? null;
            // Resolve bundled binary: substitute absolute path if declared in contributes.binaries (ADR-0036).
            const resolved = (globalThis.__sindri_bin_paths ?? {})[cmd] ?? cmd;
            return Deno.core.ops.op_env_exec(resolved, args, cwd);
        }),
    },
    events: {
        on(id, handler) {
            let handlers = __sindri_events.get(id);
            if (!handlers) { handlers = []; __sindri_events.set(id, handlers); }
            handlers.push(handler);
            return { dispose() {
                const hs = __sindri_events.get(id);
                if (hs) __sindri_events.set(id, hs.filter(h => h !== handler));
            }};
        },
        emit(id, payload) {
            const p = (payload === undefined || payload === null) ? ''
                      : typeof payload === 'string' ? payload
                      : JSON.stringify(payload);
            Deno.core.ops.op_event_emit(id, p);
        }
    },
    ui: {
        createStatusBarItem(id, options) {
            const text = (options && options.text) ? String(options.text) : '';
            const tooltip = (options && options.tooltip) ? String(options.tooltip) : '';
            const item = {
                _text: text,
                _tooltip: tooltip,
                _visible: false,
                get text() { return this._text; },
                set text(v) {
                    this._text = String(v);
                    sindri.events.emit("__sindri.ui.statusBarItemUpdated", JSON.stringify({id, text: this._text}));
                },
                get tooltip() { return this._tooltip; },
                set tooltip(v) {
                    this._tooltip = String(v);
                    sindri.events.emit("__sindri.ui.statusBarItemUpdated", JSON.stringify({id, tooltip: this._tooltip}));
                },
                show() {
                    this._visible = true;
                    sindri.events.emit("__sindri.ui.statusBarItemUpdated", JSON.stringify({id, visible: true}));
                },
                hide() {
                    this._visible = false;
                    sindri.events.emit("__sindri.ui.statusBarItemUpdated", JSON.stringify({id, visible: false}));
                },
                dispose() {
                    __sindri_status_items.delete(id);
                    sindri.events.emit("__sindri.ui.statusBarItemDisposed", id);
                }
            };
            __sindri_status_items.set(id, item);
            sindri.events.emit("__sindri.ui.statusBarItemCreated", JSON.stringify({id, text, tooltip}));
            return item;
        },
        // title/icon/defaultDock come from contributes.treeViews in the manifest (ADR-0026).
        // This call only supplies the data provider.
        registerTreeView(id, options) {
            const provider = options.treeDataProvider;
            const itemCache = new Map();
            __sindri_tree_views.set(id, {
                async getChildren(elementId) {
                    const element = (elementId !== null && elementId !== undefined)
                        ? itemCache.get(elementId)
                        : undefined;
                    const raw = await provider.getChildren(element);
                    const items = Array.isArray(raw) ? raw : [];
                    let idx = 0;
                    for (const item of items) {
                        if (!item.id) item.id = id + ":" + (elementId ?? "root") + ":" + idx;
                        itemCache.set(item.id, item);
                        idx++;
                    }
                    return JSON.stringify(items);
                }
            });
            sindri.events.emit("__sindri.ui.treeViewRegistered", id);
            return { dispose() { __sindri_tree_views.delete(id); itemCache.clear(); } };
        },
        // ADR-0026 §3 Tier 1 — blocking quick-pick backed by op_ui_show_quick_pick.
        // Frontend handles filtering; resolves with the chosen QuickPickItem or undefined.
        async showQuickPick(items, options) {
            const requestId = "qp:" + (++__sindri_qp_counter);
            const payload = JSON.stringify({
                requestId,
                items: Array.isArray(items) ? items : [],
                placeholder: (options && options.placeholder) ? String(options.placeholder) : null,
                title: (options && options.title) ? String(options.title) : null,
            });
            const raw = await Deno.core.ops.op_ui_show_quick_pick(requestId, payload);
            if (!raw || raw === "null") return undefined;
            try { return JSON.parse(raw); } catch { return undefined; }
        },
        // ADR-0026 §3 Tier 1 — event-driven quick-pick; non-blocking.
        // Commands return immediately; accept/hide events arrive via dispatch_event.
        createQuickPick() {
            const requestId = "qp:" + (++__sindri_qp_counter);
            let _items = [];
            let _placeholder = '';
            let _title = '';
            let _selectedItems = [];
            let _visible = false;
            const _acceptHandlers = [];
            const _hideHandlers = [];
            const _changeValueHandlers = [];

            function _handleResult(rawPayload) {
                const data = rawPayload
                    ? (typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload)
                    : null;
                if (!data) { _visible = false; _hideHandlers.forEach(h => h()); return; }
                if (data.type === 'accept') {
                    _selectedItems = data.items || [];
                    _acceptHandlers.forEach(h => h());
                } else if (data.type === 'valueChange') {
                    _changeValueHandlers.forEach(h => h(data.value || ''));
                } else {
                    _visible = false;
                    _hideHandlers.forEach(h => h());
                }
            }

            return {
                get items() { return _items; },
                set items(v) {
                    _items = Array.isArray(v) ? v : [];
                    if (_visible) sindri.events.emit("__sindri.ui.quickPickUpdate", JSON.stringify({ requestId, items: _items }));
                },
                get placeholder() { return _placeholder; },
                set placeholder(v) { _placeholder = String(v || ''); },
                get title() { return _title; },
                set title(v) { _title = String(v || ''); },
                get selectedItems() { return _selectedItems; },
                onDidAccept(handler) {
                    _acceptHandlers.push(handler);
                    return { dispose() { const i = _acceptHandlers.indexOf(handler); if (i >= 0) _acceptHandlers.splice(i, 1); } };
                },
                onDidHide(handler) {
                    _hideHandlers.push(handler);
                    return { dispose() { const i = _hideHandlers.indexOf(handler); if (i >= 0) _hideHandlers.splice(i, 1); } };
                },
                onDidChangeValue(handler) {
                    _changeValueHandlers.push(handler);
                    return { dispose() { const i = _changeValueHandlers.indexOf(handler); if (i >= 0) _changeValueHandlers.splice(i, 1); } };
                },
                show() {
                    if (_visible) return;
                    _visible = true;
                    sindri.events.on("__sindri.ui.quickPickResult:" + requestId, _handleResult);
                    sindri.events.emit("__sindri.ui.quickPickShow", JSON.stringify({
                        requestId,
                        items: _items,
                        placeholder: _placeholder || null,
                        title: _title || null,
                        streaming: true,
                    }));
                },
                hide() {
                    if (!_visible) return;
                    sindri.events.emit("__sindri.ui.quickPickHide", requestId);
                },
                dispose() {
                    if (_visible) this.hide();
                }
            };
        },
        // ADR-0030 — explicit named output channels.
        // Channels appear in the Extension Logs panel alongside the auto-captured Console channel.
        // No permission gate: logging is a basic developer right (ADR-0030 §4).
        output: {
            createOutputChannel(name) {
                const channelId = String(name);
                const extId = globalThis.__sindri_ext_id;
                // Partial-line buffer: text accumulated via append() until a newline or appendLine().
                let _pending = '';
                function _flush(extra) {
                    const line = _pending + (extra || '');
                    _pending = '';
                    if (line === '') return;
                    Deno.core.ops.op_event_emit("__sindri.output.line", JSON.stringify({
                        extId, channelId, level: "info", msg: line, ts: Date.now()
                    }));
                }
                sindri.events.emit("__sindri.output.channelCreated",
                    JSON.stringify({ extId, channelId, name: channelId }));
                return {
                    appendLine(value) {
                        _flush(String(value));
                    },
                    append(value) {
                        const s = String(value);
                        const parts = s.split('\n');
                        // All but last are complete lines; last is a new pending fragment.
                        for (let i = 0; i < parts.length - 1; i++) {
                            _flush(parts[i]);
                        }
                        _pending += parts[parts.length - 1];
                    },
                    clear() {
                        _pending = '';
                        sindri.events.emit("__sindri.output.channelClear",
                            JSON.stringify({ extId, channelId }));
                    },
                    show() {
                        sindri.events.emit("__sindri.output.channelShow",
                            JSON.stringify({ extId, channelId }));
                    },
                    dispose() {
                        if (_pending) _flush();
                        sindri.events.emit("__sindri.output.channelDisposed",
                            JSON.stringify({ extId, channelId }));
                    }
                };
            }
        },
        // ADR-0026 §4 Tier 2 — webview escape hatch.
        // provider.getHtml(context) returns the full HTML document; the host
        // sandboxes it in a null-origin iframe and injects theme tokens + acquireSindriApi().
        registerWebviewPanel(contribution, provider) {
            const id = contribution.id;
            function _emit(msg) {
                const payload = (msg === null || msg === undefined) ? 'null'
                    : typeof msg === 'string' ? msg
                    : JSON.stringify(msg);
                sindri.events.emit("__sindri.ui.webviewMessage:" + id, payload);
            }
            const context = { postMessage: _emit };
            const html = provider.getHtml(context);
            __sindri_webview_panels.set(id, { provider, html });
            // Route inbound iframe messages to provider.onMessage (if declared).
            // Return the Promise so do_dispatch_event's Promise.all properly awaits async handlers.
            if (typeof provider.onMessage === 'function') {
                sindri.events.on("__sindri.ui.webviewInboundMessage:" + id, function(rawPayload) {
                    let msg = rawPayload;
                    if (rawPayload && typeof rawPayload === 'string') {
                        try { msg = JSON.parse(rawPayload); } catch {}
                    }
                    return provider.onMessage(msg);
                });
            }
            sindri.events.emit("__sindri.ui.webviewPanelRegistered", JSON.stringify({
                id,
                title: contribution.title,
                icon: contribution.icon ?? '',
                extId: globalThis.__sindri_ext_id,
                defaultDock: contribution.defaultDock ?? 'right-top',
                html,
            }));
            return {
                postMessage: _emit,
                dispose() {
                    __sindri_webview_panels.delete(id);
                    sindri.events.emit("__sindri.ui.webviewPanelDisposed", id);
                }
            };
        }
    },
    // ADR-0035: sindri.wasm — load and compile a WASM module bundled with the extension.
    // relPath is relative to __sindri_bundle_dir (parent of extension.js).
    // Returns a compiled WebAssembly.Module; extension instantiates it with its own imports.
    wasm: {
        async load(relPath) {
            const dir = globalThis.__sindri_bundle_dir;
            if (!dir) throw new Error("sindri.wasm: bundle dir not available");
            const sep = (dir.endsWith("/") || dir.endsWith("\\")) ? "" : "/";
            const abs = dir + sep + String(relPath);
            const bytes = await Deno.core.ops.op_wasm_load(abs);
            return WebAssembly.compile(bytes);
        }
    },
    // ADR-0034: sindri.editor — document/text surface for editor-touching extensions.
    // activeEditor / visibleEditors are last-known snapshots pushed by the webview;
    // TextDocument methods are async round-trips via op_editor_request.
    editor: {
        get activeEditor() { return _makeTextEditor(globalThis.__sindri_active_editor); },
        get visibleEditors() {
            return (globalThis.__sindri_visible_editors ?? []).map(_makeTextEditor);
        },
        onDidChangeActiveEditor(fn) {
            return sindri.events.on('__sindri.editor.activeEditorChanged', function(payloadStr) {
                const info = payloadStr ? JSON.parse(String(payloadStr)) : null;
                globalThis.__sindri_active_editor = info;
                fn(_makeTextEditor(info));
            });
        },
        onDidChangeSelection(fn) {
            return sindri.events.on('__sindri.editor.selectionChanged', function(payloadStr) {
                const data = JSON.parse(String(payloadStr));
                if (globalThis.__sindri_active_editor && globalThis.__sindri_active_editor.path === data.path) {
                    globalThis.__sindri_active_editor = Object.assign({}, globalThis.__sindri_active_editor, { selections: data.selections });
                }
                fn({ editor: _makeTextEditor(data), selections: data.selections });
            });
        },
        onDidChangeVisibleRanges(fn) {
            return sindri.events.on('__sindri.editor.viewportChanged', function(payloadStr) {
                const data = JSON.parse(String(payloadStr));
                if (globalThis.__sindri_active_editor && globalThis.__sindri_active_editor.path === data.path) {
                    globalThis.__sindri_active_editor = Object.assign({}, globalThis.__sindri_active_editor, { visibleRanges: data.visibleRanges });
                }
                fn({ editor: _makeTextEditor(data), visibleRanges: data.visibleRanges });
            });
        },
        onDidOpenDocument(fn) {
            return sindri.events.on('__sindri.editor.documentOpened', function(payloadStr) {
                const info = JSON.parse(String(payloadStr));
                fn(_makeTextDocument(info));
            });
        },
        onDidCloseDocument(fn) {
            return sindri.events.on('__sindri.editor.documentClosed', function(payloadStr) {
                const info = JSON.parse(String(payloadStr));
                fn(_makeTextDocument(info));
            });
        },
        onDidChangeDocument(fn) {
            return sindri.events.on('__sindri.editor.documentChanged', function(payloadStr) {
                const data = JSON.parse(String(payloadStr));
                if (globalThis.__sindri_active_editor && globalThis.__sindri_active_editor.path === data.path) {
                    globalThis.__sindri_active_editor = Object.assign({}, globalThis.__sindri_active_editor, { version: data.version, lineCount: data.lineCount });
                }
                fn({ document: _makeTextDocument(data) });
            });
        },
        registerDecorationProvider(id, provider) {
            globalThis.__sindri_decoration_providers.set(id, provider);
            const configKeys = (provider.configKeys && Array.isArray(provider.configKeys)) ? provider.configKeys : [];
            const css = (typeof provider.css === 'string') ? provider.css : '';
            const extId = globalThis.__sindri_ext_id ?? 'unknown';
            sindri.events.emit('__sindri.editor.decorationProviderRegistered', JSON.stringify({id, extId, configKeys, css}));
            return {
                dispose() {
                    globalThis.__sindri_decoration_providers.delete(id);
                    sindri.events.emit('__sindri.editor.decorationProviderDisposed', id);
                }
            };
        },
    },
    // 1.5j: localisation API — translate UI strings contributed by extensions.
    // Bundle file: contributes.l10n directory / bundle.l10n.{locale}.json (flat { key: string } map).
    // Phase 1: locale is always en-US; t() falls back to the key if no translation is found.
    // Args: simple {name} placeholder substitution — pass { name: value } object.
    l10n: {
        t(key, args) {
            let str = (globalThis.__sindri_l10n_bundle ?? {})[key];
            if (str === undefined || str === null) str = String(key);
            if (args && typeof args === 'object') {
                for (const [k, v] of Object.entries(args)) {
                    str = str.split('{' + k + '}').join(String(v));
                }
            }
            return str;
        },
        get bundle() { return Object.assign({}, globalThis.__sindri_l10n_bundle ?? {}); },
        get locale() { return globalThis.__sindri_locale ?? "en-US"; },
    }
};

// ── Web API polyfills ─────────────────────────────────────────────────────────
// These are not included in deno_core's minimal runtime; extensions expect them.

if (typeof TextEncoder === 'undefined') {
    globalThis.TextEncoder = class TextEncoder {
        constructor() { this.encoding = 'utf-8'; }
        encode(s) { return Deno.core.encode(String(s ?? '')); }
        encodeInto(s, u8) {
            const b = Deno.core.encode(String(s ?? ''));
            u8.set(b.subarray(0, u8.length));
            return { read: Math.min(s.length, u8.length), written: Math.min(b.length, u8.length) };
        }
    };
}

if (typeof TextDecoder === 'undefined') {
    globalThis.TextDecoder = class TextDecoder {
        constructor(label) { this.encoding = label || 'utf-8'; }
        decode(b) { return Deno.core.decode(b instanceof Uint8Array ? b : new Uint8Array(b)); }
    };
}

// Timer polyfills backed by op_sleep_ms (tokio::time::sleep).
// Each handle is an object with an `active` flag; clearTimeout/clearInterval deactivates it.
{
    let __timerSeq = 0;
    const __timers = new Map();
    globalThis.setTimeout = function(fn, ms) {
        const id = ++__timerSeq;
        const h = { active: true };
        __timers.set(id, h);
        (async function() {
            await Deno.core.ops.op_sleep_ms(ms >>> 0);
            if (h.active) { __timers.delete(id); fn(); }
        })();
        return id;
    };
    globalThis.clearTimeout = function(id) {
        const h = __timers.get(id);
        if (h) { h.active = false; __timers.delete(id); }
    };
    globalThis.setInterval = function(fn, ms) {
        const id = ++__timerSeq;
        const h = { active: true };
        __timers.set(id, h);
        (async function loop() {
            while (h.active) {
                await Deno.core.ops.op_sleep_ms(ms >>> 0);
                if (h.active) fn();
            }
            __timers.delete(id);
        })();
        return id;
    };
    globalThis.clearInterval = function(id) {
        const h = __timers.get(id);
        if (h) { h.active = false; __timers.delete(id); }
    };
}
"#;

// ── source map translation ────────────────────────────────────────────────────

type SourceMaps = HashMap<String, sourcemap::SourceMap>;

/// Try to load the `.js.map` file adjacent to `bundle_path` and register it.
async fn try_load_source_map(bundle_path: &str, maps: &mut SourceMaps) {
    let map_path = format!("{bundle_path}.map");
    if let Ok(bytes) = tokio::fs::read(&map_path).await {
        if let Ok(sm) = sourcemap::SourceMap::from_reader(bytes.as_slice()) {
            maps.insert(bundle_path.to_string(), sm);
        }
    }
}

/// Translate a V8 stack trace string, remapping any frames that reference a
/// known bundle path back to the original TypeScript source positions.
///
/// V8 frame formats handled:
///   "    at funcName (path:line:col)"
///   "    at path:line:col"  (anonymous frames)
fn translate_stack(raw: &str, maps: &SourceMaps) -> String {
    if maps.is_empty() {
        return raw.to_string();
    }
    raw.lines().map(|line| translate_frame_line(line, maps)).collect::<Vec<_>>().join("\n")
}

fn translate_frame_line(line: &str, maps: &SourceMaps) -> String {
    let trimmed = line.trim_start();
    if !trimmed.starts_with("at ") {
        return line.to_string();
    }

    // Parens form: "    at funcName (path:line:col)"
    if let (Some(open), Some(close)) = (line.rfind('('), line.rfind(')')) {
        if open < close {
            let inner = &line[open + 1..close];
            if let Some(translated) = translate_loc(inner, maps) {
                return format!("{}({translated})", &line[..open]);
            }
        }
    }

    // Bare form: "    at path:line:col"
    if let Some(at_pos) = line.find("at ") {
        let after_at = &line[at_pos + 3..];
        if let Some(translated) = translate_loc(after_at, maps) {
            return format!("{}at {translated}", &line[..at_pos]);
        }
    }

    line.to_string()
}

/// Try to parse `loc` as `path:line:col`, look up the source map for that path,
/// and return the translated `orig_file:orig_line:orig_col` if found.
fn translate_loc(loc: &str, maps: &SourceMaps) -> Option<String> {
    // Split from the right to isolate the col, then line, leaving the path.
    let (rest, col_str) = loc.rsplit_once(':')?;
    let (path, line_str) = rest.rsplit_once(':')?;

    let line_1: u32 = line_str.parse().ok()?;
    let col_1: u32 = col_str.parse().ok()?;

    let sm = maps.get(path)?;

    // V8 stack traces are 1-indexed for both line and column.
    // sourcemap::SourceMap::lookup_token expects 0-indexed.
    let token = sm.lookup_token(line_1.saturating_sub(1), col_1.saturating_sub(1))?;

    let src_rel = token.get_source().unwrap_or(path);
    // Resolve the (typically relative) source path against the bundle's directory.
    let src_file = if src_rel.starts_with('.') {
        let bundle_dir = Path::new(path).parent().unwrap_or(Path::new("."));
        bundle_dir.join(src_rel).to_string_lossy().into_owned()
    } else {
        src_rel.to_string()
    };

    let src_line = token.get_src_line() + 1; // back to 1-indexed
    let src_col = token.get_src_col() + 1;

    Some(format!("{src_file}:{src_line}:{src_col}"))
}

// ── channel messages ──────────────────────────────────────────────────────────

type Reply<T> = oneshot::Sender<Result<T, ExthostError>>;

enum Msg {
    EvalTest(Reply<Vec<String>>),
    LoadAndActivate { path: String, ext_id: Option<String>, workspace_root: Option<String>, bin_paths: HashMap<String, String>, l10n_bundle: Option<String>, reply: Reply<()> },
    DispatchCommand { id: String, reply: Reply<String> },
    DispatchEvent { id: String, payload: String, reply: Reply<()> },
    TreeViewGetChildren { tree_id: String, element_id: Option<String>, reply: Reply<String> },
    ProvideDecorations { provider_id: String, ctx_json: String, reply: Reply<String> },
    /// ADR-0037: a CDP client attached; inject the session into V8 and enter debug mode.
    InspectorConnect { proxy: InspectorSessionProxy },
    /// ADR-0037: user requested debug shutdown — exit debug mode and close all inspector sessions.
    StopDebug,
}

// ── public handle (Send) ──────────────────────────────────────────────────────

pub struct ExtensionRuntime {
    tx: mpsc::UnboundedSender<Msg>,
    pub pending_quick_picks: PendingQuickPicks,
    pub pending_editor_reads: PendingEditorReads,
}

impl ExtensionRuntime {
    pub async fn new(
        env: Arc<dyn crate::env::Environment>,
        event_tx: Option<EventTx>,
    ) -> Result<Self, ExthostError> {
        let (tx, rx) = mpsc::unbounded_channel();
        let pending_quick_picks: PendingQuickPicks = Arc::new(Mutex::new(HashMap::new()));
        let pending_editor_reads = PendingEditorReads::new();
        let pending_qp_for_loop = pending_quick_picks.clone();
        let pending_er_for_loop = pending_editor_reads.clone_inner();
        std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("js thread tokio rt")
                .block_on(runtime_loop(env, event_tx, pending_qp_for_loop, pending_er_for_loop, rx));
        });
        Ok(Self { tx, pending_quick_picks, pending_editor_reads })
    }

    /// Resolve (or cancel) a pending `showQuickPick` request.
    /// Called from the Tauri command thread while the JS thread's event loop is running.
    /// Signals the oneshot channel stored by `op_ui_show_quick_pick` without going
    /// through the mpsc message queue, so there is no deadlock.
    pub fn resolve_quick_pick(&self, request_id: &str, item_json: Option<String>) {
        if let Some(tx) = self.pending_quick_picks.lock().unwrap().remove(request_id) {
            let _ = tx.send(item_json);
        }
    }

    /// Resolve a pending sindri.editor proxy read (getText, lineAt, …).
    /// Same pattern as resolve_quick_pick — signals the oneshot in op_editor_request directly,
    /// without touching the JS message queue, so there is no deadlock.
    pub fn resolve_editor_read(&self, request_id: &str, result: Option<String>) {
        if let Some(tx) = self.pending_editor_reads.0.lock().unwrap().remove(request_id) {
            let _ = tx.send(result);
        }
    }

    /// ADR-0037: deliver an inspector session proxy to the JS thread.
    /// Wakes the thread out of idle `recv()` and switches it to debug mode.
    /// No-op if the channel is closed (runtime already shut down).
    pub fn connect_inspector(&self, proxy: InspectorSessionProxy) {
        let _ = self.tx.send(Msg::InspectorConnect { proxy });
    }

    /// ADR-0037: exit debug mode and close all active inspector sessions.
    /// No-op if not in debug mode or channel is closed.
    pub fn stop_debug(&self) {
        let _ = self.tx.send(Msg::StopDebug);
    }

    /// M0 smoke test: verify console capture and basic JS eval.
    pub async fn eval_test(&self) -> Result<Vec<String>, ExthostError> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(Msg::EvalTest(tx)).map_err(|_| ExthostError::RuntimeGone)?;
        rx.await.map_err(|_| ExthostError::RuntimeGone)?
    }

    /// Execute an IIFE-bundled extension and call its activate(context) export.
    /// `ext_id` is injected as `globalThis.__sindri_ext_id` before the bundle runs
    /// so console output and `sindri.output` channels are attributed correctly (ADR-0030).
    /// `bin_paths` is injected as `globalThis.__sindri_bin_paths` for bundled binary resolution (ADR-0036).
    /// `l10n_bundle` is a JSON string (flat key→translation map) injected as `globalThis.__sindri_l10n_bundle`.
    pub async fn load_and_activate(
        &self,
        bundle_path: &str,
        ext_id: Option<&str>,
        workspace_root: Option<&str>,
        bin_paths: HashMap<String, String>,
        l10n_bundle: Option<String>,
    ) -> Result<(), ExthostError> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Msg::LoadAndActivate {
                path: bundle_path.to_owned(),
                ext_id: ext_id.map(|s| s.to_owned()),
                workspace_root: workspace_root.map(|s| s.to_owned()),
                bin_paths,
                l10n_bundle,
                reply: tx,
            })
            .map_err(|_| ExthostError::RuntimeGone)?;
        rx.await.map_err(|_| ExthostError::RuntimeGone)?
    }

    /// Fire all JS handlers registered for `id` via `sindri.events.on`.
    /// Waits until all async handlers have settled.
    pub async fn dispatch_event(&self, id: &str, payload: &str) -> Result<(), ExthostError> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Msg::DispatchEvent {
                id: id.to_owned(),
                payload: payload.to_owned(),
                reply: tx,
            })
            .map_err(|_| ExthostError::RuntimeGone)?;
        rx.await.map_err(|_| ExthostError::RuntimeGone)?
    }

    /// Dispatch a registered command and return its (stringified) result.
    pub async fn dispatch_command(&self, id: &str) -> Result<String, ExthostError> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Msg::DispatchCommand { id: id.to_owned(), reply: tx })
            .map_err(|_| ExthostError::RuntimeGone)?;
        rx.await.map_err(|_| ExthostError::RuntimeGone)?
    }

    /// Call `getChildren` on the JS tree-view provider registered under `tree_id`.
    /// `element_id` is `None` for the root; otherwise the item's id string.
    /// Returns a JSON-encoded `TreeItem[]`.
    pub async fn tree_view_get_children(
        &self,
        tree_id: &str,
        element_id: Option<&str>,
    ) -> Result<String, ExthostError> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Msg::TreeViewGetChildren {
                tree_id: tree_id.to_owned(),
                element_id: element_id.map(|s| s.to_owned()),
                reply: tx,
            })
            .map_err(|_| ExthostError::RuntimeGone)?;
        rx.await.map_err(|_| ExthostError::RuntimeGone)?
    }

    /// Call `provide(ctx)` on the decoration provider registered under `provider_id`.
    /// `ctx_json` is a JSON-encoded `DecorationContext`. Returns a JSON-encoded `DecorationDatum[]`.
    pub async fn provide_decorations(
        &self,
        provider_id: &str,
        ctx_json: &str,
    ) -> Result<String, ExthostError> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Msg::ProvideDecorations {
                provider_id: provider_id.to_owned(),
                ctx_json: ctx_json.to_owned(),
                reply: tx,
            })
            .map_err(|_| ExthostError::RuntimeGone)?;
        rx.await.map_err(|_| ExthostError::RuntimeGone)?
    }
}

// ── runtime thread ────────────────────────────────────────────────────────────

async fn runtime_loop(
    env: Arc<dyn crate::env::Environment>,
    event_tx: Option<EventTx>,
    pending_quick_picks: PendingQuickPicks,
    pending_editor_reads: PendingEditorReads,
    mut rx: mpsc::UnboundedReceiver<Msg>,
) {
    let inspector_enabled =
        cfg!(debug_assertions) || std::env::var("SINDRI_INSPECT").is_ok();

    let mut rt = {
        let mut rt = JsRuntime::new(RuntimeOptions {
            extensions: vec![sindri_ext::init()],
            inspector: inspector_enabled,
            ..Default::default()
        });
        {
            let op_state_rc = rt.op_state();
            let mut state = op_state_rc.borrow_mut();
            state.put(env);
            state.put(pending_quick_picks);
            state.put(pending_editor_reads);
            if let Some(tx) = event_tx {
                state.put(tx);
            }
        }
        rt.execute_script("<sindri-bootstrap>", SINDRI_BOOTSTRAP)
            .expect("sindri bootstrap failed");
        rt
    };

    // Keyed by absolute bundle path; populated when LoadAndActivate succeeds in
    // reading the adjacent .js.map file. Used to translate V8 stack frames.
    let mut source_maps: SourceMaps = HashMap::new();

    // ADR-0037 §4: dual-mode loop.
    //   Idle mode   — block on rx.recv(); zero V8 polling cost.
    //   Debug mode  — select! over rx and run_event_loop so CDP traffic is serviced.
    // Mode transition: Idle → Debug on InspectorConnect; Debug → Idle when last
    // CDP session disconnects (sessions_state().has_active becomes false).
    'outer: loop {
        let Some(msg) = rx.recv().await else { break };

        if inspector_enabled {
            if let Msg::InspectorConnect { proxy } = msg {
                rt.inspector().get_session_sender().unbounded_send(proxy).ok();
                // Debug mode: keep polling V8 so inspector sessions are serviced.
                // was_ever_active guards against exiting before DevTools completes its
                // initial CDP handshake (Debugger.enable), which can take a round-trip.
                let mut was_ever_active = false;
                loop {
                    tokio::select! {
                        biased;
                        maybe_msg = rx.recv() => match maybe_msg {
                            None => break 'outer,
                            Some(Msg::InspectorConnect { proxy }) => {
                                rt.inspector().get_session_sender().unbounded_send(proxy).ok();
                            }
                            Some(Msg::StopDebug) => break, // user-requested shutdown
                            Some(other) => dispatch_msg(&mut rt, other, &mut source_maps).await,
                        },
                        _ = rt.run_event_loop(PollEventLoopOptions { wait_for_inspector: false }) => {}
                    }
                    let now_active = rt.inspector().sessions_state().has_active;
                    if now_active { was_ever_active = true; }
                    // Only exit debug mode after we have confirmed a session was established
                    // and it has since disconnected (avoids premature exit during handshake).
                    if was_ever_active && !now_active {
                        break;
                    }
                }
                continue 'outer;
            }
        }

        dispatch_msg(&mut rt, msg, &mut source_maps).await;
    }
}

async fn dispatch_msg(rt: &mut JsRuntime, msg: Msg, source_maps: &mut SourceMaps) {
    match msg {
        Msg::EvalTest(reply) => {
            let _ = reply.send(do_eval_test(rt).await);
        }
        Msg::LoadAndActivate { path, ext_id, workspace_root, bin_paths, l10n_bundle, reply } => {
            let _ = reply.send(
                do_load_and_activate(rt, &path, ext_id.as_deref(), workspace_root.as_deref(), &bin_paths, l10n_bundle.as_deref(), source_maps).await
            );
        }
        Msg::DispatchCommand { id, reply } => {
            let _ = reply.send(do_dispatch_command(rt, &id, source_maps).await);
        }
        Msg::DispatchEvent { id, payload, reply } => {
            let _ = reply.send(do_dispatch_event(rt, &id, &payload, source_maps).await);
        }
        Msg::TreeViewGetChildren { tree_id, element_id, reply } => {
            let _ = reply.send(
                do_tree_view_get_children(rt, &tree_id, element_id.as_deref(), source_maps).await
            );
        }
        Msg::ProvideDecorations { provider_id, ctx_json, reply } => {
            let _ = reply.send(
                do_provide_decorations(rt, &provider_id, &ctx_json, source_maps).await
            );
        }
        Msg::InspectorConnect { .. } => {} // only reached when inspector_enabled=false
        Msg::StopDebug => {}               // only reached when inspector_enabled=false
    }
}

// ── JS operations ─────────────────────────────────────────────────────────────

async fn do_eval_test(rt: &mut JsRuntime) -> Result<Vec<String>, ExthostError> {
    // Temporarily replace console to capture output, then restore.
    rt.execute_script(
        "<m0-eval>",
        r#"
        var __m0_logs = [];
        var __m0_prev_con = globalThis.console;
        globalThis.console = { log: function() { __m0_logs.push(Array.from(arguments).map(String).join(" ")); } };
        console.log("M0 boot OK");
        globalThis.console = __m0_prev_con;
        globalThis.__m0_logs = __m0_logs;
        "#,
    )
    .map_err(|e| ExthostError::Js(e.to_string()))?;

    let val = rt
        .execute_script("<m0-read>", "globalThis.__m0_logs")
        .map_err(|e| ExthostError::Js(e.to_string()))?;

    deno_core::scope!(scope, rt);
    let local = v8::Local::new(scope, &val);
    let arr = v8::Local::<v8::Array>::try_from(local)
        .map_err(|_| ExthostError::Js("expected Array for __m0_logs".into()))?;

    let mut out = Vec::new();
    for i in 0..arr.length() {
        if let Some(elem) = arr.get_index(scope, i) {
            out.push(elem.to_rust_string_lossy(scope));
        }
    }
    Ok(out)
}

/// Load an IIFE-bundled extension (globalName: "sindri_ext"), call activate(context),
/// and drive the event loop until all async activate work settles.
///
/// The bundle path is used as the V8 script specifier so stack frames in errors
/// reference it, enabling source map translation back to the original TS source.
async fn do_load_and_activate(
    rt: &mut JsRuntime,
    bundle_path: &str,
    ext_id: Option<&str>,
    workspace_root: Option<&str>,
    bin_paths: &HashMap<String, String>,
    l10n_bundle: Option<&str>,
    source_maps: &mut SourceMaps,
) -> Result<(), ExthostError> {
    let source = tokio::fs::read_to_string(bundle_path)
        .await
        .map_err(ExthostError::Io)?;

    // Try to load the adjacent source map so stack frames can be translated.
    try_load_source_map(bundle_path, source_maps).await;

    // Inject runtime globals before the bundle: ext_id (ADR-0030 log attribution),
    // workspace_root (exec cwd default), and bundle_dir (ADR-0035 WASM path resolution).
    {
        let ext_id_js = match ext_id {
            Some(id) => format!("{id:?}"),
            None => "\"unknown\"".to_owned(),
        };
        let workspace_root_js = match workspace_root {
            Some(r) => format!("{r:?}"),
            None => "null".to_owned(),
        };
        let bundle_dir_js = Path::new(bundle_path)
            .parent()
            .and_then(|p| p.to_str())
            .map(|s| format!("{s:?}"))
            .unwrap_or_else(|| "null".to_owned());
        let bin_paths_js = serde_json::to_string(bin_paths)
            .unwrap_or_else(|_| "{}".to_owned());
        // Validate the l10n bundle JSON before injecting; fall back to {} on malformed input.
        let l10n_bundle_js = l10n_bundle
            .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
            .filter(|v| v.is_object())
            .and_then(|v| serde_json::to_string(&v).ok())
            .unwrap_or_else(|| "{}".to_owned());
        let inject = format!(
            "globalThis.__sindri_ext_id = {ext_id_js}; \
             globalThis.__sindri_workspace_root = {workspace_root_js}; \
             globalThis.__sindri_bundle_dir = {bundle_dir_js}; \
             globalThis.__sindri_bin_paths = {bin_paths_js}; \
             globalThis.__sindri_l10n_bundle = {l10n_bundle_js};"
        );
        rt.execute_script("<sindri-globals>", inject)
            .map_err(|e| ExthostError::Js(e.to_string()))?;
    }

    // Prefix with file:// so V8 Inspector reports a proper URL in Debugger.scriptParsed.
    // Chrome DevTools requires a URL scheme to display the script in the Sources panel
    // and to resolve inline source maps embedded in the bundle.
    let script_url = if bundle_path.starts_with('/') {
        format!("file://{bundle_path}")
    } else if bundle_path.len() > 2 && bundle_path.as_bytes()[1] == b':' {
        // Windows: C:\... → file:///C:/...
        format!("file:///{}", bundle_path.replace('\\', "/"))
    } else {
        bundle_path.to_owned()
    };
    rt.execute_script(script_url, source)
        .map_err(|e| ExthostError::Js(translate_stack(&e.to_string(), source_maps)))?;

    // Call activate; wrap in async IIFE so both sync and async activate work uniformly.
    // Capture stack (not just message) so source map translation applies to activate errors.
    rt.execute_script(
        "<activate>",
        r#"
        (async () => {
            try {
                await sindri_ext.activate({ subscriptions: [] });
                globalThis.__activate_err = null;
            } catch (e) {
                globalThis.__activate_err = e.stack ?? String(e.message ?? e);
            }
        })();
        "#,
    )
    .map_err(|e| ExthostError::Js(e.to_string()))?;

    rt.run_event_loop(Default::default()).await
        .map_err(|e| ExthostError::Js(translate_stack(&e.to_string(), source_maps)))?;

    let err_val = rt
        .execute_script("<activate-check>", "globalThis.__activate_err")
        .map_err(|e| ExthostError::Js(e.to_string()))?;
    if let Some(raw) = v8_str_maybe(rt, &err_val) {
        return Err(ExthostError::Js(format!(
            "activate failed: {}",
            translate_stack(&raw, source_maps)
        )));
    }

    Ok(())
}

/// Dispatch a command registered via sindri.commands.register.
///
/// Runs the handler (sync or async) inside an async IIFE and drives the event loop
/// until the Promise settles. Result and errors land in JS globals for safe extraction.
/// Error stacks are captured (not just message) and source-map-translated before surfacing.
async fn do_dispatch_command(
    rt: &mut JsRuntime,
    id: &str,
    source_maps: &SourceMaps,
) -> Result<String, ExthostError> {
    // {id:?} produces a properly quoted+escaped JS string literal from the Rust string.
    let script = format!(
        r#"(async () => {{
            globalThis.__dc_result = null;
            globalThis.__dc_err = null;
            if (!globalThis.__sindri_registry.has({id:?})) {{
                globalThis.__dc_err = "NOT_FOUND";
                return;
            }}
            try {{
                globalThis.__dc_result = String(await globalThis.__sindri_registry.get({id:?})());
            }} catch (e) {{
                globalThis.__dc_err = e.stack ?? String(e.message ?? e);
            }}
        }})();"#,
        id = id,
    );

    rt.execute_script("<dispatch>", script)
        .map_err(|e| ExthostError::Js(e.to_string()))?;

    rt.run_event_loop(Default::default()).await
        .map_err(|e| ExthostError::Js(translate_stack(&e.to_string(), source_maps)))?;

    let err_val = rt
        .execute_script("<dispatch-err>", "globalThis.__dc_err")
        .map_err(|e| ExthostError::Js(e.to_string()))?;
    if let Some(raw) = v8_str_maybe(rt, &err_val) {
        return Err(if raw == "NOT_FOUND" {
            ExthostError::CommandNotFound(id.to_owned())
        } else {
            ExthostError::CommandFailed(translate_stack(&raw, source_maps))
        });
    }

    let res_val = rt
        .execute_script("<dispatch-result>", "globalThis.__dc_result")
        .map_err(|e| ExthostError::Js(e.to_string()))?;
    Ok(v8_str(rt, &res_val))
}

/// Fire all JS handlers registered with `sindri.events.on(id, ...)` for the given event.
///
/// All handlers are called concurrently via `Promise.all`. If any throws, the first
/// rejection is surfaced as `ExthostError::CommandFailed` with source-map translation.
async fn do_dispatch_event(
    rt: &mut JsRuntime,
    id: &str,
    payload: &str,
    source_maps: &SourceMaps,
) -> Result<(), ExthostError> {
    let script = format!(
        r#"(async () => {{
            globalThis.__de_err = null;
            const handlers = globalThis.__sindri_events.get({id:?}) ?? [];
            try {{
                await Promise.all(handlers.map(h => h({payload:?})));
            }} catch (e) {{
                globalThis.__de_err = e.stack ?? String(e.message ?? e);
            }}
        }})();"#,
        id = id,
        payload = payload,
    );

    rt.execute_script("<dispatch-event>", script)
        .map_err(|e| ExthostError::Js(e.to_string()))?;

    rt.run_event_loop(Default::default()).await
        .map_err(|e| ExthostError::Js(translate_stack(&e.to_string(), source_maps)))?;

    let err_val = rt
        .execute_script("<dispatch-event-err>", "globalThis.__de_err")
        .map_err(|e| ExthostError::Js(e.to_string()))?;
    if let Some(raw) = v8_str_maybe(rt, &err_val) {
        return Err(ExthostError::CommandFailed(translate_stack(&raw, source_maps)));
    }
    Ok(())
}

/// Call `getChildren(elementId)` on the tree-view provider registered for `tree_id`.
/// Returns a JSON string encoding `TreeItem[]`.
async fn do_tree_view_get_children(
    rt: &mut JsRuntime,
    tree_id: &str,
    element_id: Option<&str>,
    source_maps: &SourceMaps,
) -> Result<String, ExthostError> {
    let element_js = match element_id {
        Some(id) => format!("{id:?}"),
        None => "null".to_string(),
    };
    let script = format!(
        r#"(async () => {{
            globalThis.__tv_result = null;
            globalThis.__tv_err = null;
            const tv = __sindri_tree_views.get({tree_id:?});
            if (!tv) {{ globalThis.__tv_err = "NOT_FOUND"; return; }}
            try {{
                globalThis.__tv_result = await tv.getChildren({element_js});
            }} catch (e) {{
                globalThis.__tv_err = e.stack ?? String(e.message ?? e);
            }}
        }})();"#,
        tree_id = tree_id,
        element_js = element_js,
    );

    rt.execute_script("<tree-view-get-children>", script)
        .map_err(|e| ExthostError::Js(e.to_string()))?;

    rt.run_event_loop(Default::default()).await
        .map_err(|e| ExthostError::Js(translate_stack(&e.to_string(), source_maps)))?;

    let err_val = rt
        .execute_script("<tv-err>", "globalThis.__tv_err")
        .map_err(|e| ExthostError::Js(e.to_string()))?;
    if let Some(raw) = v8_str_maybe(rt, &err_val) {
        return Err(if raw == "NOT_FOUND" {
            ExthostError::CommandNotFound(format!("tree view: {tree_id}"))
        } else {
            ExthostError::CommandFailed(translate_stack(&raw, source_maps))
        });
    }

    let res_val = rt
        .execute_script("<tv-result>", "globalThis.__tv_result")
        .map_err(|e| ExthostError::Js(e.to_string()))?;
    Ok(v8_str(rt, &res_val))
}

/// Call `provide(ctx)` on the decoration provider registered under `provider_id`.
/// `ctx_json` is a JSON-encoded `DecorationContext`. Returns a JSON-encoded `DecorationDatum[]`.
async fn do_provide_decorations(
    rt: &mut JsRuntime,
    provider_id: &str,
    ctx_json: &str,
    source_maps: &SourceMaps,
) -> Result<String, ExthostError> {
    let ctx_json_str = serde_json::to_string(ctx_json)
        .unwrap_or_else(|_| "\"{}\"".to_string());
    let script = format!(
        r#"(async () => {{
            globalThis.__decor_result = null;
            globalThis.__decor_err = null;
            const __providers = globalThis.__sindri_decoration_providers;
            const __provider = __providers ? __providers.get({provider_id:?}) : undefined;
            if (!__provider) {{ globalThis.__decor_result = "[]"; return; }}
            try {{
                const __ctx = JSON.parse({ctx_json_str});
                const __result = await __provider.provide(__ctx);
                globalThis.__decor_result = JSON.stringify(Array.isArray(__result) ? __result : []);
            }} catch (e) {{
                globalThis.__decor_err = e.stack ?? String(e.message ?? e);
            }}
        }})();"#,
        provider_id = provider_id,
        ctx_json_str = ctx_json_str,
    );

    rt.execute_script("<provide-decorations>", script)
        .map_err(|e| ExthostError::Js(e.to_string()))?;

    rt.run_event_loop(Default::default()).await
        .map_err(|e| ExthostError::Js(translate_stack(&e.to_string(), source_maps)))?;

    let err_val = rt
        .execute_script("<decor-err>", "globalThis.__decor_err")
        .map_err(|e| ExthostError::Js(e.to_string()))?;
    if let Some(raw) = v8_str_maybe(rt, &err_val) {
        return Err(ExthostError::CommandFailed(translate_stack(&raw, source_maps)));
    }

    let res_val = rt
        .execute_script("<decor-result>", "globalThis.__decor_result")
        .map_err(|e| ExthostError::Js(e.to_string()))?;
    Ok(v8_str(rt, &res_val))
}

// ── V8 helpers ────────────────────────────────────────────────────────────────

fn v8_str_maybe(rt: &mut JsRuntime, val: &v8::Global<v8::Value>) -> Option<String> {
    deno_core::scope!(scope, rt);
    let local = v8::Local::new(scope, val);
    if local.is_null_or_undefined() {
        None
    } else {
        Some(local.to_rust_string_lossy(scope))
    }
}

fn v8_str(rt: &mut JsRuntime, val: &v8::Global<v8::Value>) -> String {
    deno_core::scope!(scope, rt);
    v8::Local::new(scope, val).to_rust_string_lossy(scope)
}
