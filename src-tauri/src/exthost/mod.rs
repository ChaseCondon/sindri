/// Extension host — Deno/V8-backed JS runtime (ADR-0025).
///
/// M0: runtime boot + console capture.
/// M1: IIFE bundle load, activate(), sindri.commands registry, execute_command.
/// M2: async sindri.env bridge (plane-② ops via deno_core #[op2(async)]).
/// M3: event bus (sindri.events → Tauri events).
///
/// Isolation model (ADR-0025 §2): one JsRuntime (V8 Isolate) per extension.
/// ExtHost owns a HashMap<ext_id, Arc<ExtensionRuntime>>. Each extension gets an
/// independent heap, GC, and thread — no shared-isolate compromise.
mod dispatch;
mod ops;
mod polyfills;
mod source_map;
pub mod runtime;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;

use ops::EventTx;
use runtime::{ExtensionRuntime, ExthostError};

/// Manages loaded extensions — one V8 Isolate per extension (ADR-0025 §2).
pub struct ExtHost {
    runtimes: Mutex<HashMap<String, Arc<ExtensionRuntime>>>,
    event_tx: EventTx,
    /// ADR-0037: registry of debuggable targets. A target is present here ONLY while a
    /// debugger is attached — registered on `attach_debugger`, pruned on `stop_debugger`
    /// / `deactivate`. This is what `/json/list` reflects, so stopping the debugger and
    /// refreshing `chrome://inspect` correctly drops the target.
    debug_targets: crate::inspector_gateway::TargetRegistry,
    /// ext_id → bundle path, remembered at activation so `attach_debugger` can build the
    /// CDP target `url` without re-plumbing the path through every call site.
    bundle_paths: Mutex<HashMap<String, String>>,
    /// Guard so the gateway TCP listener is started at most once.
    gateway_started: Arc<AtomicBool>,
}

impl ExtHost {
    /// Create a new `ExtHost` and the receiver for events emitted by extensions.
    ///
    /// Callers should spawn a task to drain `event_rx` (e.g. forwarding to
    /// `AppHandle::emit`) or drop it (events are silently discarded).
    pub fn new() -> (Self, mpsc::UnboundedReceiver<(String, String)>) {
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        (
            Self {
                runtimes: Mutex::new(HashMap::new()),
                event_tx,
                debug_targets: Arc::new(Mutex::new(HashMap::new())),
                bundle_paths: Mutex::new(HashMap::new()),
                gateway_started: Arc::new(AtomicBool::new(false)),
            },
            event_rx,
        )
    }

    /// Load an IIFE-bundled extension, run its activate(), and store its runtime.
    ///
    /// Each extension gets its own `JsRuntime` (V8 Isolate). `ext_id` is used as the
    /// routing key; pass the manifest id (e.g. `"sindri.color-swatches"`). If `ext_id`
    /// is None (dev/test path) the bundle path is used as a fallback key.
    /// `bin_paths` maps logical binary names to absolute paths for bundled binaries (ADR-0036).
    /// `l10n_bundle` is the JSON content of the resolved locale bundle (1.5j), or `None` if the
    /// extension has no l10n directory or no bundle matches the current locale.
    /// `engines` is the `engines.sindri` range from `manifest.json` (ADR-0040); `None` = no constraint.
    pub async fn activate(
        &self,
        bundle_path: &str,
        ext_id: Option<&str>,
        workspace_root: Option<&str>,
        env: Arc<dyn crate::env::Environment>,
        bin_paths: HashMap<String, String>,
        l10n_bundle: Option<String>,
        config_snapshot: Option<String>,
        engines: Option<&str>,
    ) -> Result<(), ExthostError> {
        // ADR-0040: engine compat gate — checked before allocating a V8 isolate.
        match sindri_core::check_engine(engines, sindri_core::HOST_API_VERSION) {
            sindri_core::Compat::Ok => {}
            sindri_core::Compat::HostTooOld { required, host } => {
                return Err(ExthostError::IncompatibleHost(format!(
                    "extension requires Sindri engine {required} but host is {host}; upgrade Sindri"
                )));
            }
            sindri_core::Compat::HostTooNew { required, host } => {
                return Err(ExthostError::IncompatibleHost(format!(
                    "extension requires Sindri engine {required} but host is {host}; the extension may need an update"
                )));
            }
            sindri_core::Compat::BadRange(msg) => {
                return Err(ExthostError::IncompatibleHost(format!(
                    "extension has invalid engines.sindri range: {msg}"
                )));
            }
        }
        let rt = ExtensionRuntime::new(env, Some(self.event_tx.clone())).await?;
        rt.load_and_activate(bundle_path, ext_id, workspace_root, bin_paths, l10n_bundle, config_snapshot).await?;
        let key = ext_id.unwrap_or(bundle_path).to_owned();
        let rt = Arc::new(rt);

        // ADR-0037: remember the bundle path so `attach_debugger` can register a CDP
        // target on demand. We do NOT register the target here — a target appears in
        // `/json/list` only while a debugger is actively attached.
        self.bundle_paths.lock().unwrap().insert(key.clone(), bundle_path.to_owned());

        self.runtimes.lock().unwrap().insert(key, rt);
        Ok(())
    }

    /// ADR-0037: start the CDP gateway (if not already running) and return the
    /// `webSocketDebuggerUrl` for `ext_id`. Returns `None` if the extension is
    /// not loaded or inspector support is disabled (release builds).
    pub fn attach_debugger(&self, ext_id: &str) -> Option<String> {
        if !cfg!(debug_assertions) && std::env::var("SINDRI_INSPECT").is_err() {
            return None;
        }
        // Resolve the loaded runtime; bail if the extension isn't active.
        let runtime = self.runtimes.lock().unwrap().get(ext_id).cloned()?;
        let bundle_path = self
            .bundle_paths
            .lock()
            .unwrap()
            .get(ext_id)
            .cloned()
            .unwrap_or_default();

        // Register the CDP target now — it appears in `/json/list` only from this point
        // until `stop_debugger`/`deactivate` prunes it.
        self.debug_targets.lock().unwrap().insert(
            ext_id.to_owned(),
            crate::inspector_gateway::TargetEntry {
                name: ext_id.to_owned(),
                bundle_path,
                runtime,
            },
        );

        // Lazily bind the gateway the first time a target is requested.
        if !self.gateway_started.swap(true, Ordering::SeqCst) {
            let registry = Arc::clone(&self.debug_targets);
            tokio::spawn(async move {
                if let Err(e) = crate::inspector_gateway::start(9229, registry).await {
                    eprintln!("[sindri cdp] gateway error: {e}");
                }
            });
        }
        Some(format!("ws://127.0.0.1:9229/ws/{ext_id}"))
    }

    /// Deactivate and unload an extension by id. Drops the runtime (which closes the
    /// mpsc sender and causes the JS thread to exit). Also removes the debug target.
    /// Returns false if the extension was not loaded.
    /// Return a cloned Arc for the named runtime (if loaded). Used to call async methods
    /// outside the lock (e.g. `deactivate_gracefully` before dropping the runtime).
    pub fn get_runtime(&self, ext_id: &str) -> Option<Arc<crate::exthost::runtime::ExtensionRuntime>> {
        self.runtimes.lock().unwrap().get(ext_id).cloned()
    }

    pub fn deactivate(&self, ext_id: &str) -> bool {
        let removed = self.runtimes.lock().unwrap().remove(ext_id).is_some();
        self.debug_targets.lock().unwrap().remove(ext_id);
        self.bundle_paths.lock().unwrap().remove(ext_id);
        removed
    }

    /// Send `StopDebug` to the JS thread for `ext_id`, exiting debug mode and closing
    /// all active inspector sessions. Returns `false` if the extension is not loaded.
    pub fn stop_debugger(&self, ext_id: &str) -> bool {
        // Drop the CDP target first so a `chrome://inspect` refresh stops listing it,
        // then tell the JS thread to exit debug mode and close its inspector sessions.
        let pruned = self.debug_targets.lock().unwrap().remove(ext_id).is_some();
        let rt = self.runtimes.lock().unwrap().get(ext_id).cloned();
        if let Some(rt) = rt {
            rt.stop_debug();
            true
        } else {
            pruned
        }
    }

    /// Return `(ext_id, display_name)` for every loaded extension.
    /// Used by the "Attach Debugger" palette command to populate the quick-pick.
    pub fn loaded_extension_ids(&self) -> Vec<(String, String)> {
        self.runtimes
            .lock()
            .unwrap()
            .keys()
            .map(|k| (k.clone(), k.clone()))
            .collect()
    }

    /// Dispatch a command to the extension that registered it.
    ///
    /// Tries each runtime in turn; the first that returns a non-CommandNotFound result
    /// wins. Returns `CommandNotFound` only if no runtime owns the command.
    pub async fn execute_command(&self, command_id: &str) -> Result<String, ExthostError> {
        let rts = self.all_runtimes();
        let mut last_err = ExthostError::CommandNotFound(command_id.to_owned());
        for rt in rts {
            match rt.dispatch_command(command_id).await {
                Ok(result) => return Ok(result),
                Err(ExthostError::CommandNotFound(_)) => continue,
                Err(e) => { last_err = e; }
            }
        }
        Err(last_err)
    }

    /// Fire all JS handlers registered via `sindri.events.on(id, …)` in every extension.
    pub async fn dispatch_event(&self, id: &str, payload: &str) -> Result<(), ExthostError> {
        let rts = self.all_runtimes();
        for rt in rts {
            rt.dispatch_event(id, payload).await?;
        }
        Ok(())
    }

    /// Call `getChildren` on the JS tree-view provider registered under `tree_id`.
    ///
    /// Tries each runtime; the first that owns the tree view wins.
    pub async fn tree_view_get_children(
        &self,
        tree_id: &str,
        element_id: Option<&str>,
    ) -> Result<String, ExthostError> {
        let rts = self.all_runtimes();
        for rt in rts {
            match rt.tree_view_get_children(tree_id, element_id).await {
                Ok(result) => return Ok(result),
                Err(ExthostError::CommandNotFound(_)) => continue,
                Err(e) => return Err(e),
            }
        }
        Err(ExthostError::CommandNotFound(format!("tree view: {tree_id}")))
    }

    /// Deliver a quick-pick result to the awaiting `showQuickPick` op.
    /// Broadcasts to all runtimes; only the one holding the request_id acts on it.
    pub fn quick_pick_result(&self, request_id: &str, item_json: Option<String>) {
        for rt in self.all_runtimes() {
            rt.resolve_quick_pick(request_id, item_json.clone());
        }
    }

    /// Deliver the webview's response to a sindri.editor proxy read.
    /// Broadcasts to all runtimes; only the one holding the request_id acts on it.
    pub fn editor_read_result(&self, request_id: &str, result: Option<String>) {
        for rt in self.all_runtimes() {
            rt.resolve_editor_read(request_id, result.clone());
        }
    }

    /// Call `provide(ctx)` on the decoration provider registered under `provider_id`.
    ///
    /// Routes directly to the runtime for `ext_id` (the extension that registered the
    /// provider). Returns `"[]"` if that extension is not loaded.
    pub async fn provide_decorations(
        &self,
        ext_id: &str,
        provider_id: &str,
        ctx_json: &str,
    ) -> Result<String, ExthostError> {
        let rt = self.runtimes.lock().unwrap().get(ext_id).cloned();
        match rt {
            Some(rt) => rt.provide_decorations(provider_id, ctx_json).await,
            None => Ok("[]".to_string()),
        }
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    fn all_runtimes(&self) -> Vec<Arc<ExtensionRuntime>> {
        self.runtimes.lock().unwrap().values().cloned().collect()
    }
}

#[cfg(test)]
mod tests;
