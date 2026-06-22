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
    host.activate(bundle.to_str().unwrap(), None, None, local_env(), HashMap::new(), None, None)
        .await
        .expect("activate failed");

    let result = host
        .execute_command("hello.ping")
        .await
        .expect("dispatch failed");
    assert_eq!(result, "pong from Deno");
}

/// Step 5: source map translation.
#[tokio::test]
async fn m5_source_map_translation() {
    let tmp = tempfile::tempdir().unwrap();

    let bundle_src = "var sindri_ext = (function() {\n\
        function activate(ctx) {\n\
        throw new Error(\"sourcemap test\");\n\
        }\n\
        return { activate: activate };\n\
        })();\n";

    let map_json = r#"{"version":3,"sources":["src/ext.ts"],"sourcesContent":[null],"mappings":";;AASA","names":[]}"#;

    let bundle_file = tmp.path().join("ext.js");
    let map_file = tmp.path().join("ext.js.map");
    std::fs::write(&bundle_file, bundle_src).unwrap();
    std::fs::write(&map_file, map_json).unwrap();

    let (host, _) = ExtHost::new();
    let result = host.activate(bundle_file.to_str().unwrap(), None, None, local_env(), HashMap::new(), None, None).await;

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
    host.activate(ext_file.to_str().unwrap(), None, None, local_env(), HashMap::new(), None, None)
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
    host.activate(ext_file.to_str().unwrap(), None, None, local_env(), HashMap::new(), None, None)
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
    host.activate(ext_file.to_str().unwrap(), None, None, local_env(), HashMap::new(), None, None)
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
    host.activate(ext_file.to_str().unwrap(), None, None, local_env(), HashMap::new(), None, None)
        .await
        .expect("activate failed");

    let host = std::sync::Arc::new(host);
    let host2 = host.clone();
    let cmd_handle = tokio::spawn(async move {
        host2.execute_command("qp.test").await
    });

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let mut show_event = None;
    while let Ok(e) = event_rx.try_recv() {
        if e.0 == "__sindri.ui.quickPickShow" {
            show_event = Some(e.1);
        }
    }
    assert!(show_event.is_some(), "expected __sindri.ui.quickPickShow event");

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
    host.activate(ext_file.to_str().unwrap(), None, None, local_env(), HashMap::new(), None, None)
        .await
        .expect("activate failed");

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
    host.activate(ext_file.to_str().unwrap(), None, None, local_env(), HashMap::new(), None, None)
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
    host.activate(ext_a.to_str().unwrap(), Some("ext.a"), None, local_env(), HashMap::new(), None, None)
        .await.expect("activate a failed");
    host.activate(ext_b.to_str().unwrap(), Some("ext.b"), None, local_env(), HashMap::new(), None, None)
        .await.expect("activate b failed");

    assert_eq!(host.execute_command("ext.a.ping").await.expect("a"), "pong-a");
    assert_eq!(host.execute_command("ext.b.ping").await.expect("b"), "pong-b");
}

/// ADR-0040: activate() returns IncompatibleHost before allocating a V8 isolate when the
/// extension's engines.sindri range is not satisfied by HOST_API_VERSION ("0.1.0").
#[tokio::test]
async fn engine_gate_blocks_incompatible_extension() {
    let tmp = tempfile::tempdir().unwrap();
    let ext_file = tmp.path().join("compat_ext.js");
    std::fs::write(&ext_file, "var sindri_ext = (function() { function activate() {} return { activate }; })();").unwrap();

    let (host, _) = ExtHost::new();
    // ">99.0.0" is never satisfied by host "0.1.0" → must get IncompatibleHost, not Ok.
    let result = host
        .activate(ext_file.to_str().unwrap(), None, None, local_env(), HashMap::new(), None, Some(">99.0.0"))
        .await;

    assert!(result.is_err(), "expected activation to fail for incompatible range");
    let err = result.unwrap_err().to_string();
    assert!(
        err.contains("incompatible host"),
        "expected IncompatibleHost error; got: {err}"
    );
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
    host.activate(ext_file.to_str().unwrap(), None, None, local_env(), HashMap::new(), Some(bundle), None)
        .await
        .expect("activate failed");

    let hit = host.execute_command("l10n.test.hit").await.expect("hit failed");
    assert_eq!(hit, "Hello, world!");

    let miss = host.execute_command("l10n.test.miss").await.expect("miss failed");
    assert_eq!(miss, "missing.key");

    let locale = host.execute_command("l10n.test.locale").await.expect("locale failed");
    assert_eq!(locale, "en-US");
}
