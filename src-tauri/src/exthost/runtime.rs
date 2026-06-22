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
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use deno_core::{InspectorSessionProxy, JsRuntime, PollEventLoopOptions, RuntimeOptions};
use tokio::sync::{mpsc, oneshot};

use super::dispatch::{
    do_deactivate, do_dispatch_command, do_dispatch_event, do_eval_test,
    do_load_and_activate, do_provide_decorations, do_tree_view_get_children,
};
use super::ops::{sindri_ext, EventTx, PendingEditorReads, PendingQuickPicks};
use super::source_map::SourceMaps;

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
    /// ADR-0040: extension's `engines.sindri` range is incompatible with the host.
    #[error("incompatible host: {0}")]
    IncompatibleHost(String),
}

// Bootstrap JS injected into every isolate before extension code runs (see bootstrap.js).
const SINDRI_BOOTSTRAP: &str = include_str!("bootstrap.js");

// ── channel messages ──────────────────────────────────────────────────────────

type Reply<T> = oneshot::Sender<Result<T, ExthostError>>;

enum Msg {
    EvalTest(Reply<Vec<String>>),
    LoadAndActivate { path: String, ext_id: Option<String>, workspace_root: Option<String>, bin_paths: HashMap<String, String>, l10n_bundle: Option<String>, reply: Reply<()> },
    DispatchCommand { id: String, reply: Reply<String> },
    DispatchEvent { id: String, payload: String, reply: Reply<()> },
    TreeViewGetChildren { tree_id: String, element_id: Option<String>, reply: Reply<String> },
    ProvideDecorations { provider_id: String, ctx_json: String, reply: Reply<String> },
    /// Graceful shutdown: call JS deactivate() + dispose all subscriptions, then reply.
    Deactivate(Reply<()>),
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

    /// Graceful shutdown: calls JS `deactivate()` and disposes all `context.subscriptions`,
    /// triggering cleanup events (statusBarItemDisposed, etc.) before the runtime is dropped.
    pub async fn deactivate_gracefully(&self) -> Result<(), ExthostError> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(Msg::Deactivate(tx)).map_err(|_| ExthostError::RuntimeGone)?;
        rx.await.map_err(|_| ExthostError::RuntimeGone)?
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
            // ADR-0037: report this isolate as a *main/default* execution context
            // ({"isDefault":true,"type":"default"}) rather than deno_core's default
            // worker context ({"isDefault":false,"type":"worker"}). Chrome/Brave DevTools
            // blackbox non-default contexts, which hides every script → an empty Sources
            // panel even though scriptParsed fired. Each extension owns its own CDP target,
            // so each legitimately is the main context of its inspector.
            is_main: inspector_enabled,
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
        rt.execute_script("<sindri-polyfills>", super::polyfills::POLYFILLS)
            .expect("sindri polyfills failed");
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
        Msg::Deactivate(reply) => {
            let _ = reply.send(do_deactivate(rt, source_maps).await);
        }
        Msg::InspectorConnect { .. } => {} // only reached when inspector_enabled=false
        Msg::StopDebug => {}               // only reached when inspector_enabled=false
    }
}

// ── ADR-0037 inspector diagnostics ────────────────────────────────────────────

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod inspector_tests;
