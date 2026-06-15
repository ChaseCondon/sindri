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
pub mod runtime;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;

use runtime::{EventTx, ExtensionRuntime, ExthostError};

/// Manages loaded extensions — one V8 Isolate per extension (ADR-0025 §2).
pub struct ExtHost {
    runtimes: Mutex<HashMap<String, Arc<ExtensionRuntime>>>,
    event_tx: EventTx,
    /// ADR-0037: registry of debuggable targets; populated on activate in dev builds.
    debug_targets: crate::inspector_gateway::TargetRegistry,
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
    pub async fn activate(
        &self,
        bundle_path: &str,
        ext_id: Option<&str>,
        workspace_root: Option<&str>,
        env: Arc<dyn crate::env::Environment>,
        bin_paths: HashMap<String, String>,
        l10n_bundle: Option<String>,
    ) -> Result<(), ExthostError> {
        let rt = ExtensionRuntime::new(env, Some(self.event_tx.clone())).await?;
        rt.load_and_activate(bundle_path, ext_id, workspace_root, bin_paths, l10n_bundle).await?;
        let key = ext_id.unwrap_or(bundle_path).to_owned();
        let rt = Arc::new(rt);

        // ADR-0037: register as a debuggable target in dev builds.
        if cfg!(debug_assertions) || std::env::var("SINDRI_INSPECT").is_ok() {
            self.debug_targets.lock().unwrap().insert(
                key.clone(),
                crate::inspector_gateway::TargetEntry {
                    name: key.clone(),
                    bundle_path: bundle_path.to_owned(),
                    runtime: Arc::clone(&rt),
                },
            );
        }

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
        {
            let guard = self.debug_targets.lock().unwrap();
            if !guard.contains_key(ext_id) {
                return None;
            }
        }
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

    /// Send `StopDebug` to the JS thread for `ext_id`, exiting debug mode and closing
    /// all active inspector sessions. Returns `false` if the extension is not loaded.
    pub fn stop_debugger(&self, ext_id: &str) -> bool {
        let guard = self.runtimes.lock().unwrap();
        if let Some(rt) = guard.get(ext_id) {
            rt.stop_debug();
            true
        } else {
            false
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
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;

    use super::runtime::ExtensionRuntime;
    use super::ExtHost;
    use crate::env::LocalEnvironment;

    fn local_env() -> Arc<dyn crate::env::Environment> {
        Arc::new(LocalEnvironment)
    }

    #[tokio::test]
    async fn m0_boot_smoke() {
        let rt = ExtensionRuntime::new(local_env(), None)
            .await
            .expect("runtime boot failed");
        let logs = rt.eval_test().await.expect("eval failed");
        assert!(
            logs.iter().any(|l| l.contains("M0 boot OK")),
            "expected 'M0 boot OK' in logs, got: {logs:?}"
        );
    }

    #[tokio::test]
    async fn m1_activate_and_dispatch() {
        let bundle = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../core-extensions/sindri-hello/dist/extension.js");

        let (host, _) = ExtHost::new();
        host.activate(bundle.to_str().unwrap(), None, None, local_env(), HashMap::new(), None)
            .await
            .expect("activate failed");

        let result = host
            .execute_command("hello.ping")
            .await
            .expect("dispatch failed");
        assert_eq!(result, "pong from Deno");
    }

    /// Step 5: source map translation.
    ///
    /// Bundle line 3 throws; the adjacent .js.map maps that line back to
    /// "src/ext.ts" via a hand-crafted VLQ mapping (;;AASA = line 2→src[0]:9:0).
    /// The error surfaced by ExtHost should reference "src/ext.ts", not the bundle.
    #[tokio::test]
    async fn m5_source_map_translation() {
        let tmp = tempfile::tempdir().unwrap();

        // Three-line bundle: throw is on line 3.
        let bundle_src = "var sindri_ext = (function() {\n\
            function activate(ctx) {\n\
            throw new Error(\"sourcemap test\");\n\
            }\n\
            return { activate: activate };\n\
            })();\n";

        // Minimal v3 source map.
        //   ";;"  — skip lines 0 and 1 (no segments)
        //   "AASA" — line 2, segment: generated_col=0, sources[0], orig_line_delta=+9, orig_col=0
        //            → maps bundle:3:* to src/ext.ts:10:1
        let map_json = r#"{"version":3,"sources":["src/ext.ts"],"sourcesContent":[null],"mappings":";;AASA","names":[]}"#;

        let bundle_file = tmp.path().join("ext.js");
        let map_file = tmp.path().join("ext.js.map");
        std::fs::write(&bundle_file, bundle_src).unwrap();
        std::fs::write(&map_file, map_json).unwrap();

        let (host, _) = ExtHost::new();
        let result = host.activate(bundle_file.to_str().unwrap(), None, None, local_env(), HashMap::new(), None).await;

        assert!(result.is_err(), "activate should fail because extension throws");
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("src/ext.ts"),
            "expected source map translation to reference 'src/ext.ts'; got: {err}"
        );
    }

    /// M3: extension calls `sindri.events.emit` → event arrives in the Rust receiver.
    #[tokio::test]
    async fn m3_events_js_to_rust() {
        let ext_src = r#"var sindri_ext = (function() {
            function activate(context) {
                sindri.commands.register("events.emit.test", function() {
                    sindri.events.emit("test.event", "hello from extension");
                    return "emitted";
                });
            }
            return { activate: activate };
        })();"#;

        let tmp = tempfile::tempdir().unwrap();
        let ext_file = tmp.path().join("events_emit_ext.js");
        std::fs::write(&ext_file, ext_src).unwrap();

        let (host, mut event_rx) = ExtHost::new();
        host.activate(ext_file.to_str().unwrap(), None, None, local_env(), HashMap::new(), None)
            .await
            .expect("activate failed");

        host.execute_command("events.emit.test").await.expect("command failed");

        let event = event_rx.try_recv().expect("expected event in channel");
        assert_eq!(event.0, "test.event");
        assert_eq!(event.1, "hello from extension");
    }

    /// M4: `sindri.env.exec` runs a real process and returns stdout/code to JS.
    #[tokio::test]
    async fn m4_exec() {
        let ext_src = r#"var sindri_ext = (function() {
            function activate(context) {
                sindri.commands.register("exec.echo", async function() {
                    const result = await sindri.env.exec("echo", "hello from exec");
                    return result.code + ":" + result.stdout.trim();
                });
            }
            return { activate: activate };
        })();"#;

        let tmp = tempfile::tempdir().unwrap();
        let ext_file = tmp.path().join("exec_ext.js");
        std::fs::write(&ext_file, ext_src).unwrap();

        let (host, _) = ExtHost::new();
        host.activate(ext_file.to_str().unwrap(), None, None, local_env(), HashMap::new(), None)
            .await
            .expect("activate failed");

        let result = host.execute_command("exec.echo").await.expect("command failed");
        assert_eq!(result, "0:hello from exec");
    }

    /// M3: Rust calls `host.dispatch_event` → registered JS handler fires and stores result.
    #[tokio::test]
    async fn m3_events_rust_to_js() {
        let ext_src = r#"var sindri_ext = (function() {
            function activate(context) {
                let received = null;
                sindri.events.on("core.event", function(payload) {
                    received = payload;
                });
                sindri.commands.register("events.get.result", function() {
                    return received ?? "null";
                });
            }
            return { activate: activate };
        })();"#;

        let tmp = tempfile::tempdir().unwrap();
        let ext_file = tmp.path().join("events_listen_ext.js");
        std::fs::write(&ext_file, ext_src).unwrap();

        let (host, _) = ExtHost::new();
        host.activate(ext_file.to_str().unwrap(), None, None, local_env(), HashMap::new(), None)
            .await
            .expect("activate failed");

        host.dispatch_event("core.event", "world").await.expect("dispatch_event failed");

        let result = host.execute_command("events.get.result").await.expect("command failed");
        assert_eq!(result, "world");
    }

    /// showQuickPick: op_ui_show_quick_pick blocks until resolve_quick_pick delivers a result.
    #[tokio::test]
    async fn ui_show_quick_pick_resolves() {
        let ext_src = r#"var sindri_ext = (function() {
            function activate(context) {
                sindri.commands.register("qp.test", async function() {
                    const item = await sindri.ui.showQuickPick(
                        [{ label: "Alpha" }, { label: "Beta" }],
                        { placeholder: "Pick one" }
                    );
                    return item ? item.label : "cancelled";
                });
            }
            return { activate: activate };
        })();"#;

        let tmp = tempfile::tempdir().unwrap();
        let ext_file = tmp.path().join("qp_ext.js");
        std::fs::write(&ext_file, ext_src).unwrap();

        let (host, mut event_rx) = ExtHost::new();
        host.activate(ext_file.to_str().unwrap(), None, None, local_env(), HashMap::new(), None)
            .await
            .expect("activate failed");

        // Run the command that calls showQuickPick — it will block awaiting user input.
        let host = std::sync::Arc::new(host);
        let host2 = host.clone();
        let cmd_handle = tokio::spawn(async move {
            host2.execute_command("qp.test").await
        });

        // Give the command a moment to emit the show event and park on the op.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // Drain events; the show event should have arrived.
        let mut show_event = None;
        while let Ok(e) = event_rx.try_recv() {
            if e.0 == "__sindri.ui.quickPickShow" {
                show_event = Some(e.1);
            }
        }
        assert!(show_event.is_some(), "expected __sindri.ui.quickPickShow event");

        // Simulate user picking "Alpha".
        let payload: serde_json::Value = serde_json::from_str(show_event.as_deref().unwrap()).unwrap();
        let request_id = payload["requestId"].as_str().unwrap().to_string();
        host.quick_pick_result(&request_id, Some(r#"{"label":"Alpha"}"#.to_string()));

        let result = cmd_handle.await.expect("task panicked").expect("command failed");
        assert_eq!(result, "Alpha");
    }

    /// createStatusBarItem: JS emits `__sindri.ui.statusBarItemCreated` through the event bus.
    #[tokio::test]
    async fn ui_status_bar_item_created() {
        let ext_src = r#"var sindri_ext = (function() {
            function activate(context) {
                const item = sindri.ui.createStatusBarItem("test.item", { text: "hello", tooltip: "tip" });
                item.show();
                item.text = "updated";
            }
            return { activate: activate };
        })();"#;

        let tmp = tempfile::tempdir().unwrap();
        let ext_file = tmp.path().join("status_bar_ext.js");
        std::fs::write(&ext_file, ext_src).unwrap();

        let (host, mut event_rx) = ExtHost::new();
        host.activate(ext_file.to_str().unwrap(), None, None, local_env(), HashMap::new(), None)
            .await
            .expect("activate failed");

        // Three events should have been emitted: created, statusBarItemUpdated (show visible:true), statusBarItemUpdated (text updated).
        let mut events = Vec::new();
        while let Ok(e) = event_rx.try_recv() {
            events.push(e);
        }

        let created = events.iter().find(|(id, _)| id == "__sindri.ui.statusBarItemCreated");
        assert!(created.is_some(), "expected statusBarItemCreated event; got: {events:?}");
        let (_, payload) = created.unwrap();
        assert!(payload.contains("\"id\":\"test.item\""), "payload: {payload}");
        assert!(payload.contains("\"text\":\"hello\""), "payload: {payload}");
    }

    #[tokio::test]
    async fn m2_env_fs_read() {
        let tmp = tempfile::tempdir().unwrap();

        let data_file = tmp.path().join("data.txt");
        std::fs::write(&data_file, "hello from env").unwrap();

        let data_path = data_file.to_str().unwrap().replace('\\', "\\\\");

        // Extension as an IIFE bundle (globalName: sindri_ext) mirroring esbuild output.
        let ext_src = format!(
            "var sindri_ext = (function() {{\n\
                 function activate(context) {{\n\
                     sindri.commands.register('env.read.test', async function() {{\n\
                         return await sindri.env.fs.read('{path}');\n\
                     }});\n\
                 }}\n\
                 return {{ activate: activate }};\n\
             }})();\n",
            path = data_path,
        );

        let ext_file = tmp.path().join("test_ext.js");
        std::fs::write(&ext_file, &ext_src).unwrap();

        let (host, _) = ExtHost::new();
        host.activate(ext_file.to_str().unwrap(), None, None, local_env(), HashMap::new(), None)
            .await
            .expect("activate failed");

        let result = host
            .execute_command("env.read.test")
            .await
            .expect("dispatch failed");
        assert_eq!(result, "hello from env");
    }

    /// Multi-extension: two extensions each register a different command; both remain callable.
    #[tokio::test]
    async fn multi_ext_both_commands_callable() {
        let make_ext = |cmd: &str, ret: &str| format!(
            "var sindri_ext = (function() {{ \
                function activate(c) {{ sindri.commands.register({cmd:?}, function() {{ return {ret:?}; }}); }} \
                return {{ activate }}; \
            }})();",
            cmd = cmd, ret = ret,
        );

        let tmp = tempfile::tempdir().unwrap();
        let ext_a = tmp.path().join("ext_a.js");
        let ext_b = tmp.path().join("ext_b.js");
        std::fs::write(&ext_a, make_ext("ext.a.ping", "pong-a")).unwrap();
        std::fs::write(&ext_b, make_ext("ext.b.ping", "pong-b")).unwrap();

        let (host, _) = ExtHost::new();
        host.activate(ext_a.to_str().unwrap(), Some("ext.a"), None, local_env(), HashMap::new(), None)
            .await.expect("activate a failed");
        host.activate(ext_b.to_str().unwrap(), Some("ext.b"), None, local_env(), HashMap::new(), None)
            .await.expect("activate b failed");

        assert_eq!(host.execute_command("ext.a.ping").await.expect("a"), "pong-a");
        assert_eq!(host.execute_command("ext.b.ping").await.expect("b"), "pong-b");
    }

    /// 1.5j: sindri.l10n.t() resolves keys from injected bundle; falls back to key; substitutes args.
    #[tokio::test]
    async fn l10n_t_resolves_and_substitutes() {
        let ext_src = r#"var sindri_ext = (function() {
            function activate(context) {
                sindri.commands.register("l10n.test.hit", function() {
                    return sindri.l10n.t("hello", { name: "world" });
                });
                sindri.commands.register("l10n.test.miss", function() {
                    return sindri.l10n.t("missing.key");
                });
                sindri.commands.register("l10n.test.locale", function() {
                    return sindri.l10n.locale;
                });
            }
            return { activate: activate };
        })();"#;

        let tmp = tempfile::tempdir().unwrap();
        let ext_file = tmp.path().join("l10n_ext.js");
        std::fs::write(&ext_file, ext_src).unwrap();

        let bundle = r#"{"hello":"Hello, {name}!"}"#.to_string();

        let (host, _) = ExtHost::new();
        host.activate(ext_file.to_str().unwrap(), None, None, local_env(), HashMap::new(), Some(bundle))
            .await
            .expect("activate failed");

        let hit = host.execute_command("l10n.test.hit").await.expect("hit failed");
        assert_eq!(hit, "Hello, world!");

        let miss = host.execute_command("l10n.test.miss").await.expect("miss failed");
        assert_eq!(miss, "missing.key");

        let locale = host.execute_command("l10n.test.locale").await.expect("locale failed");
        assert_eq!(locale, "en-US");
    }
}
