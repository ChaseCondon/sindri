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
// Injected at activation: snapshot of all Sindri settings at activate() time.
// Updated live via __sindri.config.changed events pushed by the frontend on set().
globalThis.__sindri_config_snapshot = {};
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
            const popupPanelId = (options && options.popupPanelId) ? String(options.popupPanelId) : null;
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
            sindri.events.emit("__sindri.ui.statusBarItemCreated", JSON.stringify({id, text, tooltip, ...(popupPanelId ? {popupPanelId} : {})}));
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
        // sandboxes it in a null-origin iframe and injects theme CSS vars + acquireSindriApi().
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
        },

        // ADR-0028 — surface B custom editor.
        // viewType: globally-unique editor id (e.g. "sindri.csv-grid").
        // selector: array of {scheme?,language?,pattern?} — matches files.
        // provider.resolveCustomEditor(document, webview) is called per-instance;
        // provider sets webview.html and wires onMessage. The instance is identified
        // by an instanceId (occurrence key = groupId+\0+bufferId) supplied by the workbench.
        registerEditor(viewType, selector, provider, options) {
            const priority = (options && options.priority) ? options.priority : 'default';
            // Announce registration so the workbench can update its selector registry.
            sindri.events.emit("__sindri.ui.editorRegistered", JSON.stringify({
                viewType,
                selector: selector || [],
                priority,
                extId: globalThis.__sindri_ext_id,
            }));

            // Listen for open-requests from the workbench ("please resolve this instance").
            sindri.events.on("__sindri.ui.editorOpenRequest:" + viewType, async function(rawPayload) {
                let req;
                try { req = JSON.parse(rawPayload); } catch { return; }
                const { uri, instanceId } = req;

                // Per-instance outbound emitter (ext → webview)
                function _emit(msg) {
                    const payload = (msg === null || msg === undefined) ? 'null'
                        : typeof msg === 'string' ? msg
                        : JSON.stringify(msg);
                    sindri.events.emit("__sindri.ui.editorOutbound:" + instanceId, payload);
                }

                // The webview handle the extension receives in resolveCustomEditor.
                let _html = '';
                let _htmlEmitted = false;
                let _isDirty = false;
                let _inboundHandler = null;
                const webview = {
                    get html() { return _html; },
                    set html(v) {
                        _html = String(v);
                        // Emit immediately for async providers that set html during an await.
                        sindri.events.emit("__sindri.ui.editorHtml:" + instanceId, _html);
                        _htmlEmitted = true;
                    },
                    postMessage: _emit,
                    onMessage(handler) {
                        _inboundHandler = handler;
                    },
                    get isDirty() { return _isDirty; },
                    set isDirty(v) {
                        _isDirty = !!v;
                        sindri.events.emit("__sindri.ui.editorDirty:" + instanceId, JSON.stringify(_isDirty));
                    },
                };

                // Route inbound iframe messages → provider.onMessage
                sindri.events.on("__sindri.ui.editorInbound:" + instanceId, function(rawPayload2) {
                    if (!_inboundHandler) return;
                    let msg = rawPayload2;
                    if (rawPayload2 && typeof rawPayload2 === 'string') {
                        try { msg = JSON.parse(rawPayload2); } catch {}
                    }
                    return _inboundHandler(msg);
                });

                const result = provider.resolveCustomEditor({ uri, viewType }, webview);
                // If resolveCustomEditor is async and html is set via setter during await,
                // the emit already fired. If html was set synchronously before the await,
                // we emit once more at the end to guarantee delivery.
                if (result && typeof result.then === 'function') {
                    await result;
                }
                // Only emit if the setter didn't already fire (sync providers set html
                // before any await, so the setter already emitted).
                if (_html && !_htmlEmitted) {
                    sindri.events.emit("__sindri.ui.editorHtml:" + instanceId, _html);
                } else if (!_html) {
                    console.error('[bootstrap] resolveCustomEditor finished but webview.html was never set! instanceId=' + instanceId);
                }
            });

            return {
                dispose() {
                    sindri.events.emit("__sindri.ui.editorUnregistered", viewType);
                }
            };
        },
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
    },

    // ADR-0023 §config — read Sindri settings from within an extension.
    // Snapshot is injected at activate() time; live updates arrive via __sindri.config.changed.
    config: (function() {
        const _listeners = {};

        // Handle live updates from the frontend (fired whenever configStore.set() is called).
        // Cannot use sindri.events.on() here — we're inside the sindri object literal,
        // so sindri is not yet defined. Use the internal events map directly instead.
        if (!globalThis.__sindri_events.has("__sindri.config.changed")) {
            globalThis.__sindri_events.set("__sindri.config.changed", []);
        }
        globalThis.__sindri_events.get("__sindri.config.changed").push(function(payload) {
            try {
                const { key, value } = JSON.parse(payload);
                (globalThis.__sindri_config_snapshot = globalThis.__sindri_config_snapshot || {})[key] = value;
                const fns = _listeners[key];
                if (fns) fns.forEach(function(fn) { try { fn(value); } catch {} });
            } catch {}
        });

        return {
            /** Read the current value of a setting. Returns undefined if not registered. */
            get(key) {
                return (globalThis.__sindri_config_snapshot || {})[key];
            },
            /** Subscribe to changes for a specific key. Returns a Disposable. */
            onChange(key, handler) {
                if (!_listeners[key]) _listeners[key] = [];
                _listeners[key].push(handler);
                return {
                    dispose() {
                        const arr = _listeners[key];
                        if (!arr) return;
                        const i = arr.indexOf(handler);
                        if (i >= 0) arr.splice(i, 1);
                    }
                };
            }
        };
    })()
};
