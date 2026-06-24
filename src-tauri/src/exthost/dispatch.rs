//! JS operation dispatch — the `do_*` handlers called from `dispatch_msg` in `runtime.rs`.
//! Each function is a single JS operation: eval, load/activate, command dispatch, etc.
use std::collections::HashMap;
use std::path::Path;

use deno_core::v8;
use deno_core::JsRuntime;

use super::runtime::ExthostError;
use super::source_map::{script_url_for, translate_stack, try_load_source_map, SourceMaps};

/// Call `deactivate()` on the extension (if exported) and dispose all `context.subscriptions`.
/// This triggers cleanup events (statusBarItemDisposed, webviewPanelDisposed, etc.) so the
/// frontend can remove stale UI state before the runtime is dropped.
pub(crate) async fn do_deactivate(rt: &mut JsRuntime, source_maps: &mut SourceMaps) -> Result<(), ExthostError> {
    rt.execute_script(
        "<deactivate>",
        r#"
        (async () => {
            try {
                if (typeof sindri_ext !== 'undefined' && typeof sindri_ext.deactivate === 'function') {
                    await sindri_ext.deactivate();
                }
            } catch (_) {}
            // Dispose all context subscriptions (status bar items, panels, timers, etc.)
            const subs = globalThis.__sindri_context_subscriptions ?? [];
            for (const sub of subs) {
                try { sub.dispose(); } catch (_) {}
            }
        })();
        "#,
    ).map_err(|e| ExthostError::Js(translate_stack(&e.to_string(), source_maps)))?;
    rt.run_event_loop(Default::default()).await
        .map_err(|e| ExthostError::Js(translate_stack(&e.to_string(), source_maps)))?;
    Ok(())
}

pub(crate) async fn do_eval_test(rt: &mut JsRuntime) -> Result<Vec<String>, ExthostError> {
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
pub(crate) async fn do_load_and_activate(
    rt: &mut JsRuntime,
    bundle_path: &str,
    ext_id: Option<&str>,
    workspace_root: Option<&str>,
    bin_paths: &HashMap<String, String>,
    l10n_bundle: Option<&str>,
    config_snapshot: Option<&str>,
    source_maps: &mut SourceMaps,
) -> Result<(), ExthostError> {
    let mut source = tokio::fs::read_to_string(bundle_path)
        .await
        .map_err(ExthostError::Io)?;

    // The script URL V8 reports in stack frames; also the source-map lookup key.
    let script_url = script_url_for(bundle_path);

    // Try to load the adjacent source map so stack frames can be translated.
    try_load_source_map(bundle_path, &script_url, source_maps).await;

    // ADR-0037: when the inspector is enabled, inline the source map as a data URI so
    // DevTools resolves the original TypeScript with no external fetch. Extensions ship
    // with a *linked* `extension.js.map` (sindri ext build default), but a CDP client
    // attached to a `file://` script cannot fetch a linked `file://` map — so without
    // this, the Sources panel shows nothing. V8 honours the LAST sourceMappingURL
    // comment, so appending overrides the linked reference. Already-inline maps
    // (--dev-sourcemaps) are left untouched.
    let inspector_enabled =
        cfg!(debug_assertions) || std::env::var("SINDRI_INSPECT").is_ok();
    if inspector_enabled {
        if let Ok(map_bytes) = tokio::fs::read(format!("{bundle_path}.map")).await {
            let b64 = crate::inspector_gateway::base64_encode(&map_bytes);
            source.push_str("\n//# sourceMappingURL=data:application/json;base64,");
            source.push_str(&b64);
            source.push('\n');
        }
    }

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
        let config_snapshot_js = config_snapshot
            .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
            .filter(|v| v.is_object())
            .and_then(|v| serde_json::to_string(&v).ok())
            .unwrap_or_else(|| "{}".to_owned());
        let inject = format!(
            "globalThis.__sindri_ext_id = {ext_id_js}; \
             globalThis.__sindri_workspace_root = {workspace_root_js}; \
             globalThis.__sindri_bundle_dir = {bundle_dir_js}; \
             globalThis.__sindri_bin_paths = {bin_paths_js}; \
             globalThis.__sindri_l10n_bundle = {l10n_bundle_js}; \
             globalThis.__sindri_config_snapshot = {config_snapshot_js};"
        );
        rt.execute_script("<sindri-globals>", inject)
            .map_err(|e| ExthostError::Js(e.to_string()))?;
    }

    // file:// URL (computed above) so V8 Inspector reports a proper URL in
    // Debugger.scriptParsed; Chrome DevTools needs a URL scheme to show the script in
    // the Sources panel and to resolve the inline source map appended above.
    rt.execute_script(script_url, source)
        .map_err(|e| ExthostError::Js(translate_stack(&e.to_string(), source_maps)))?;

    // Store context subscriptions in a global so do_deactivate can dispose them.
    // Call activate; wrap in async IIFE so both sync and async activate work uniformly.
    rt.execute_script(
        "<activate>",
        r#"
        (async () => {
            try {
                globalThis.__sindri_context_subscriptions = [];
                await sindri_ext.activate({ subscriptions: globalThis.__sindri_context_subscriptions });
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
pub(crate) async fn do_dispatch_command(
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
pub(crate) async fn do_dispatch_event(
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
pub(crate) async fn do_tree_view_get_children(
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
pub(crate) async fn do_provide_decorations(
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

// ── V8 value helpers ──────────────────────────────────────────────────────────

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
