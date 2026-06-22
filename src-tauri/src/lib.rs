mod env;
pub mod exthost;
mod inspector_gateway;
mod resource;
mod ext_cmds;
mod dev_cmds;
mod syntax;
mod terminal;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use env::{Environment, LocalEnvironment};
use exthost::ExtHost;
use tauri::Emitter;

// Bring command handlers into scope so tauri::generate_handler! can reference them
// by bare name below.
use ext_cmds::*;
use dev_cmds::*;
use syntax::{ts_open, ts_edit, ts_highlight, ts_close, ts_register_grammar, register_builtin_grammars};
use terminal::{term_create, term_write, term_resize, term_close, list_terminal_fonts, TerminalManager};

// ── Shared state type aliases ─────────────────────────────────────────────────

pub(crate) type ActiveEnv = Arc<dyn Environment>;
pub(crate) type WorkspaceRoot = Arc<Mutex<Option<String>>>;

// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
#[cfg(debug_assertions)]
async fn toggle_devtools(window: tauri::WebviewWindow) {
    if window.is_devtools_open() {
        window.close_devtools();
    } else {
        window.open_devtools();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let active_env: ActiveEnv = Arc::new(LocalEnvironment);
    let workspace_root: WorkspaceRoot = Arc::new(Mutex::new(None));
    let ext_bundle_sources: resource::ExtBundleSources = Arc::new(Mutex::new(HashMap::new()));
    let watch_processes: dev_cmds::WatchProcesses = Arc::new(Mutex::new(HashMap::new()));
    let (ext_host, event_rx) = ExtHost::new();
    let syntax_worker = syntax::SyntaxWorker::spawn();
    register_builtin_grammars(&syntax_worker).expect("failed to register built-in grammars");
    let terminal_manager = TerminalManager::new();
    build_app(active_env, workspace_root, ext_bundle_sources, watch_processes, ext_host, event_rx, syntax_worker, terminal_manager)
        .run(tauri::generate_context!())
        .expect("error while running Sindri");
}

/// Assemble the Tauri builder. Split out of [`run`] so tests can build a mock
/// app (or just exercise the context) without launching the event loop.
fn build_app(
    active_env: ActiveEnv,
    workspace_root: WorkspaceRoot,
    ext_bundle_sources: resource::ExtBundleSources,
    watch_processes: dev_cmds::WatchProcesses,
    ext_host: ExtHost,
    event_rx: tokio::sync::mpsc::UnboundedReceiver<(String, String)>,
    syntax_worker: syntax::SyntaxWorker,
    terminal_manager: TerminalManager,
) -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(active_env)
        .manage(workspace_root)
        .manage(ext_bundle_sources)
        .manage(watch_processes.clone())
        .manage(ext_host)
        .manage(syntax_worker)
        .manage(terminal_manager)
        .register_uri_scheme_protocol("sindri-resource", |ctx, request| {
            resource::handle_sindri_resource(ctx.app_handle(), request)
        })
        .on_window_event({
            let watch_for_exit = Arc::clone(&watch_processes);
            move |_window, event| {
                if let tauri::WindowEvent::Destroyed = event {
                    if let Ok(mut procs) = watch_for_exit.try_lock() {
                        for (_, mut child) in procs.drain() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut rx = event_rx;
                while let Some((id, payload)) = rx.recv().await {
                    let _ = handle.emit("ext-event", serde_json::json!({ "id": id, "payload": payload }));
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_file, write_file, list_dir, create_file, create_dir,
            set_workspace_root,
            ext_activate, ext_activate_sinxt, ext_check_compat,
            install_sinxt, install_sinxt_from_path,
            ext_execute_command, ext_dispatch_event,
            ext_tree_view_get_children, ext_quick_pick_result,
            ext_webview_panel_message,
            ext_editor_read_result, ext_editor_provide_decorations,
            file_mtime, ext_dev_dir,
            ext_load_from_source, ext_restart_watch, ext_stop_dev_watch,
            ext_attach_debugger, ext_list_loaded_extensions, ext_stop_debugger, ext_deactivate,
            ts_open, ts_edit, ts_highlight, ts_close, ts_register_grammar,
            term_create, term_write, term_resize, term_close, list_terminal_fonts,
            #[cfg(debug_assertions)]
            toggle_devtools,
        ])
}

#[cfg(test)]
mod path_parity {
    //! ADR-0033 §3: the CLI computes data dirs without a Tauri runtime, so a
    //! Tauri-verified test guards against drift. If a future Tauri version
    //! changes its path convention, this fails loudly rather than the CLI
    //! silently writing to the wrong place.
    use tauri::Manager;

    #[test]
    fn core_app_data_dir_matches_tauri() {
        let mut ctx = tauri::test::mock_context(tauri::test::noop_assets());
        ctx.config_mut().identifier = sindri_core::IDENTIFIER.to_string();
        let app = tauri::test::mock_builder().build(ctx).expect("mock app");

        let tauri_dir = app.path().app_data_dir().expect("tauri app_data_dir");
        let core_dir = sindri_core::app_data_dir().expect("core app_data_dir");
        assert_eq!(
            core_dir, tauri_dir,
            "sindri_core::app_data_dir() must equal Tauri's app_data_dir()"
        );
    }
}
