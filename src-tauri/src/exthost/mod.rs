/// Extension host — Deno/V8-backed JS runtime (ADR-0025).
///
/// M0: runtime boot + console capture.
/// M1: IIFE bundle load, activate(), sindri.commands registry, execute_command.
/// M2: async sindri.env bridge (plane-② ops via deno_core #[op2(async)]).
/// M3: event bus (sindri.events → Tauri events).
pub mod runtime;

use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;

use runtime::{EventTx, ExtensionRuntime, ExthostError};

/// Manages loaded extensions. M1: single extension slot.
/// M2+ will be a keyed `HashMap<ExtId, Arc<ExtensionRuntime>>`.
pub struct ExtHost {
    runtime: Mutex<Option<Arc<ExtensionRuntime>>>,
    event_tx: EventTx,
}

impl ExtHost {
    /// Create a new `ExtHost` and the receiver for events emitted by extensions.
    ///
    /// Callers should either spawn a task to drain `event_rx` (e.g. forwarding to
    /// `AppHandle::emit`) or drop it (events are silently discarded).
    pub fn new() -> (Self, mpsc::UnboundedReceiver<(String, String)>) {
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        (Self { runtime: Mutex::new(None), event_tx }, event_rx)
    }

    /// Load an IIFE-bundled extension, run activate(), and register it as the active extension.
    /// `ext_id` is the manifest id (e.g. "sindri.commit-streak"); used for log attribution (ADR-0030).
    pub async fn activate(
        &self,
        bundle_path: &str,
        ext_id: Option<&str>,
        workspace_root: Option<&str>,
        env: Arc<dyn crate::env::Environment>,
    ) -> Result<(), ExthostError> {
        let rt = ExtensionRuntime::new(env, Some(self.event_tx.clone())).await?;
        rt.load_and_activate(bundle_path, ext_id, workspace_root).await?;
        *self.runtime.lock().unwrap() = Some(Arc::new(rt));
        Ok(())
    }

    /// Dispatch a command to whichever extension registered it.
    pub async fn execute_command(&self, command_id: &str) -> Result<String, ExthostError> {
        // Clone the Arc so we don't hold the std Mutex across an await.
        let rt = self.runtime.lock().unwrap().clone();
        match rt {
            Some(rt) => rt.dispatch_command(command_id).await,
            None => Err(ExthostError::CommandNotFound(command_id.to_string())),
        }
    }

    /// Fire all JS handlers registered via `sindri.events.on(id, ...)` in the active extension.
    /// No-ops silently if no extension is loaded.
    pub async fn dispatch_event(&self, id: &str, payload: &str) -> Result<(), ExthostError> {
        let rt = self.runtime.lock().unwrap().clone();
        match rt {
            Some(rt) => rt.dispatch_event(id, payload).await,
            None => Ok(()),
        }
    }

    /// Call `getChildren` on the JS tree-view provider registered under `tree_id`.
    /// Returns a JSON-encoded `TreeItem[]` string.
    pub async fn tree_view_get_children(
        &self,
        tree_id: &str,
        element_id: Option<&str>,
    ) -> Result<String, ExthostError> {
        let rt = self.runtime.lock().unwrap().clone();
        match rt {
            Some(rt) => rt.tree_view_get_children(tree_id, element_id).await,
            None => Err(ExthostError::CommandNotFound(format!("tree view: {tree_id}"))),
        }
    }

    /// Deliver a quick-pick result to the awaiting `showQuickPick` op.
    /// `item_json` is the chosen QuickPickItem as JSON, or `None` if the user cancelled.
    /// This signals the oneshot channel directly without touching the JS message queue,
    /// so it is safe to call while the runtime event loop is blocked awaiting the op.
    pub fn quick_pick_result(&self, request_id: &str, item_json: Option<String>) {
        let rt = self.runtime.lock().unwrap().clone();
        if let Some(rt) = rt {
            rt.resolve_quick_pick(request_id, item_json);
        }
    }
}

#[cfg(test)]
mod tests {
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
        host.activate(bundle.to_str().unwrap(), None, None, local_env())
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
        let result = host.activate(bundle_file.to_str().unwrap(), None, None, local_env()).await;

        assert!(result.is_err(), "activate should fail because extension throws");
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("src/ext.ts"),
            "expected source map translation to reference 'src/ext.ts'; got: {err}"
        );
    }

    #[tokio::test]
    async fn m2_5_env_error_codes() {
        // Extension that reads a missing file and returns the structured error code + name.
        let ext_src = r#"var sindri_ext = (function() {
            function activate(context) {
                sindri.commands.register("err.code.test", async function() {
                    try {
                        await sindri.env.fs.read("/no/such/sindri/path/does/not/exist");
                        return "no error";
                    } catch (e) {
                        return e.code + ":" + e.name;
                    }
                });
            }
            return { activate: activate };
        })();"#;

        let tmp = tempfile::tempdir().unwrap();
        let ext_file = tmp.path().join("test_err_ext.js");
        std::fs::write(&ext_file, ext_src).unwrap();

        let (host, _) = ExtHost::new();
        host.activate(ext_file.to_str().unwrap(), None, None, local_env())
            .await
            .expect("activate failed");

        let result = host.execute_command("err.code.test").await.expect("dispatch failed");
        assert_eq!(result, "NOT_FOUND:SindriError");
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
        host.activate(ext_file.to_str().unwrap(), None, None, local_env())
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
        host.activate(ext_file.to_str().unwrap(), None, None, local_env())
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
        host.activate(ext_file.to_str().unwrap(), None, None, local_env())
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
        host.activate(ext_file.to_str().unwrap(), None, None, local_env())
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
        host.activate(ext_file.to_str().unwrap(), None, None, local_env())
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
        host.activate(ext_file.to_str().unwrap(), None, None, local_env())
            .await
            .expect("activate failed");

        let result = host
            .execute_command("env.read.test")
            .await
            .expect("dispatch failed");
        assert_eq!(result, "hello from env");
    }
}
