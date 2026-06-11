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
use deno_core::{extension, op2, JsRuntime, OpState, RuntimeOptions};
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

extension!(sindri_ext, ops = [op_fs_read, op_fs_write, op_fs_exists, op_fs_glob, op_event_emit, op_env_exec, op_ui_show_quick_pick]);

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
globalThis.__sindri_qp_counter = 0;
globalThis.__sindri_ext_id = "unknown";
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
            return Deno.core.ops.op_env_exec(cmd, args, cwd);
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
    }
};
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
    LoadAndActivate { path: String, ext_id: Option<String>, workspace_root: Option<String>, reply: Reply<()> },
    DispatchCommand { id: String, reply: Reply<String> },
    DispatchEvent { id: String, payload: String, reply: Reply<()> },
    TreeViewGetChildren { tree_id: String, element_id: Option<String>, reply: Reply<String> },
}

// ── public handle (Send) ──────────────────────────────────────────────────────

pub struct ExtensionRuntime {
    tx: mpsc::UnboundedSender<Msg>,
    pub pending_quick_picks: PendingQuickPicks,
}

impl ExtensionRuntime {
    pub async fn new(
        env: Arc<dyn crate::env::Environment>,
        event_tx: Option<EventTx>,
    ) -> Result<Self, ExthostError> {
        let (tx, rx) = mpsc::unbounded_channel();
        let pending_quick_picks: PendingQuickPicks = Arc::new(Mutex::new(HashMap::new()));
        let pending_for_loop = pending_quick_picks.clone();
        std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("js thread tokio rt")
                .block_on(runtime_loop(env, event_tx, pending_for_loop, rx));
        });
        Ok(Self { tx, pending_quick_picks })
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

    /// M0 smoke test: verify console capture and basic JS eval.
    pub async fn eval_test(&self) -> Result<Vec<String>, ExthostError> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(Msg::EvalTest(tx)).map_err(|_| ExthostError::RuntimeGone)?;
        rx.await.map_err(|_| ExthostError::RuntimeGone)?
    }

    /// Execute an IIFE-bundled extension and call its activate(context) export.
    /// `ext_id` is injected as `globalThis.__sindri_ext_id` before the bundle runs
    /// so console output and `sindri.output` channels are attributed correctly (ADR-0030).
    pub async fn load_and_activate(
        &self,
        bundle_path: &str,
        ext_id: Option<&str>,
        workspace_root: Option<&str>,
    ) -> Result<(), ExthostError> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Msg::LoadAndActivate {
                path: bundle_path.to_owned(),
                ext_id: ext_id.map(|s| s.to_owned()),
                workspace_root: workspace_root.map(|s| s.to_owned()),
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
}

// ── runtime thread ────────────────────────────────────────────────────────────

async fn runtime_loop(
    env: Arc<dyn crate::env::Environment>,
    event_tx: Option<EventTx>,
    pending_quick_picks: PendingQuickPicks,
    mut rx: mpsc::UnboundedReceiver<Msg>,
) {
    let mut rt = {
        let mut rt = JsRuntime::new(RuntimeOptions {
            extensions: vec![sindri_ext::init()],
            ..Default::default()
        });
        {
            let op_state_rc = rt.op_state();
            let mut state = op_state_rc.borrow_mut();
            state.put(env);
            state.put(pending_quick_picks);
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

    while let Some(msg) = rx.recv().await {
        match msg {
            Msg::EvalTest(reply) => {
                let _ = reply.send(do_eval_test(&mut rt).await);
            }
            Msg::LoadAndActivate { path, ext_id, workspace_root, reply } => {
                let _ = reply.send(
                    do_load_and_activate(&mut rt, &path, ext_id.as_deref(), workspace_root.as_deref(), &mut source_maps).await
                );
            }
            Msg::DispatchCommand { id, reply } => {
                let _ = reply.send(do_dispatch_command(&mut rt, &id, &source_maps).await);
            }
            Msg::DispatchEvent { id, payload, reply } => {
                let _ = reply.send(do_dispatch_event(&mut rt, &id, &payload, &source_maps).await);
            }
            Msg::TreeViewGetChildren { tree_id, element_id, reply } => {
                let _ = reply.send(
                    do_tree_view_get_children(&mut rt, &tree_id, element_id.as_deref(), &source_maps).await
                );
            }
        }
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
    source_maps: &mut SourceMaps,
) -> Result<(), ExthostError> {
    let source = tokio::fs::read_to_string(bundle_path)
        .await
        .map_err(ExthostError::Io)?;

    // Try to load the adjacent source map so stack frames can be translated.
    try_load_source_map(bundle_path, source_maps).await;

    // Inject runtime globals before the bundle: ext_id for log attribution (ADR-0030)
    // and workspace_root so exec() defaults to the open workspace directory.
    {
        let ext_id_js = match ext_id {
            Some(id) => format!("{id:?}"),
            None => "\"unknown\"".to_owned(),
        };
        let workspace_root_js = match workspace_root {
            Some(r) => format!("{r:?}"),
            None => "null".to_owned(),
        };
        let inject = format!(
            "globalThis.__sindri_ext_id = {ext_id_js}; globalThis.__sindri_workspace_root = {workspace_root_js};"
        );
        rt.execute_script("<sindri-globals>", inject)
            .map_err(|e| ExthostError::Js(e.to_string()))?;
    }

    // Use bundle_path as the V8 script specifier (not "<bundle>") so that any
    // error stack frames reference the real path and can be source-map-translated.
    rt.execute_script(bundle_path.to_owned(), source)
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
