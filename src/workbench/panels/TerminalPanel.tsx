import { createSignal, For, onMount, onCleanup, createEffect, Show } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { LigaturesAddon } from "@xterm/addon-ligatures";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openUrl } from "@tauri-apps/plugin-opener";
import "@xterm/xterm/css/xterm.css";
import { get } from "../settings/configStore";
import { resolveTerminalTheme } from "./terminal-themes";
import { workspace } from "../../workspace/store";

interface TermSession {
  id: string;
  shell: string;
}

/** Fire-and-forget IPC: a resize/write/close racing a closed session is benign. */
function fire(cmd: string, args: Record<string, unknown>): void {
  invoke(cmd, args).catch(() => {});
}

const GENERIC_FAMILIES = new Set(["monospace", "serif", "sans-serif", "cursive", "fantasy"]);

/** CSS font-family string with a guaranteed monospace fallback. */
export function cssFontStack(family: string): string {
  const f = family.trim() || "monospace";
  return GENERIC_FAMILIES.has(f.toLowerCase()) ? f : `"${f}", monospace`;
}

/**
 * Resolve a font face before measuring, so xterm measures real glyph metrics.
 * Races a 200 ms timeout so a never-settling `document.fonts.load` (seen in
 * WKWebView for some system fonts) can't block rendering.
 */
export function loadFont(family: string, size: number): Promise<unknown> {
  if (GENERIC_FAMILIES.has(family.toLowerCase())) return Promise.resolve();
  const load = document.fonts.load(`${size}px "${family}"`).catch(() => undefined);
  const timeout = new Promise((r) => setTimeout(r, 200));
  return Promise.race([load, timeout]);
}

/** Icon: tabs docked to the left rail (shown when tabs are currently on top). */
function PanelLeftIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <line x1="6.5" y1="3" x2="6.5" y2="13" />
    </svg>
  );
}

/** Icon: tabs docked along the top (shown when tabs are currently on the left). */
function PanelTopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <line x1="2" y1="6.5" x2="14" y2="6.5" />
    </svg>
  );
}

// ── TerminalView ────────────────────────────────────────────────────────────

interface ViewProps {
  sessionKey: number;
  active: boolean;
  onShellName: (name: string) => void;
}

function TerminalView(props: ViewProps) {
  let containerRef!: HTMLDivElement;
  let sessionId: string | null = null;
  let xterm: Terminal | null = null;
  let fitAddon: FitAddon | null = null;
  let ligAddon: LigaturesAddon | null = null;
  let unlisten: UnlistenFn | null = null;
  let unlistenExit: UnlistenFn | null = null;
  let ro: ResizeObserver | null = null;

  onMount(async () => {
    const inTauri = "__TAURI_INTERNALS__" in globalThis;

    xterm = new Terminal({
      cursorBlink: get<boolean>("terminal.cursorBlink"),
      cursorStyle: get<"block" | "bar" | "underline">("terminal.cursorStyle"),
      fontFamily: cssFontStack(get<string>("terminal.fontFamily")),
      fontSize: get<number>("terminal.fontSize"),
      lineHeight: get<number>("terminal.lineHeight"),
      letterSpacing: get<number>("terminal.letterSpacing"),
      theme: resolveTerminalTheme(),
      scrollback: get<number>("terminal.scrollback"),
      macOptionIsMeta: get<boolean>("terminal.macOptionAsAlt"),
    });
    fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    // Default handler uses window.open(), a no-op in the Tauri webview — route
    // clicks through the opener plugin so links open in the OS default browser.
    xterm.loadAddon(new WebLinksAddon((_event, uri) => { void openUrl(uri).catch(() => {}); }));
    xterm.open(containerRef);

    if (!inTauri) {
      xterm.writeln("Terminal — Tauri not available in browser mode.");
      return;
    }

    try {
      const customShell = get<string>("terminal.shell") || null;
      const cwdSetting = get<string>("terminal.cwd");
      const cwd = cwdSetting === "workspace" ? (workspace.folderPath ?? null) : null;

      const session = await invoke<TermSession>("term_create", {
        cols: 80,
        rows: 24,
        shell: customShell,
        cwd,
      });
      sessionId = session.id;
      props.onShellName(session.shell);

      requestAnimationFrame(() => {
        fitAddon!.fit();
        fire("term_resize", { id: sessionId, cols: xterm!.cols, rows: xterm!.rows });
      });

      unlisten = await listen<number[]>(`term-data:${sessionId}`, (e) => {
        xterm!.write(new Uint8Array(e.payload));
      });

      unlistenExit = await listen(`term-exit:${sessionId}`, () => {
        xterm?.writeln("\r\n\x1b[90m[Process exited]\x1b[0m");
        unlistenExit?.();
        unlistenExit = null;
      });

      xterm.onData((data) => {
        if (!sessionId) return;
        fire("term_write", { id: sessionId, data: Array.from(new TextEncoder().encode(data)) });
      });

      // Clicks anywhere in the container (incl. the padding gutter, outside
      // xterm's own screen) focus the terminal, so keystrokes — and control keys
      // like Ctrl-C/Ctrl-Z — always reach the PTY.
      containerRef.addEventListener("mousedown", () => xterm?.focus());

      xterm.onBell(() => {
        if (!get<boolean>("terminal.bell")) return;
        try {
          const ctx = new AudioContext();
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.frequency.value = 440;
          gain.gain.value = 0.08;
          osc.start();
          osc.stop(ctx.currentTime + 0.08);
          osc.onended = () => ctx.close();
        } catch { /* AudioContext unavailable */ }
      });

      xterm.onSelectionChange(() => {
        if (get<boolean>("terminal.copyOnSelect") && xterm!.hasSelection()) {
          navigator.clipboard.writeText(xterm!.getSelection()).catch(() => {});
        }
      });

      ro = new ResizeObserver(() => {
        if (!props.active || !fitAddon || !xterm || !sessionId) return;
        fitAddon.fit();
        fire("term_resize", { id: sessionId, cols: xterm.cols, rows: xterm.rows });
      });
      ro.observe(containerRef);
    } catch (err) {
      xterm?.writeln(`\x1b[31mFailed to start terminal: ${err}\x1b[0m`);
    }
  });

  onCleanup(() => {
    ro?.disconnect();
    unlisten?.();
    unlistenExit?.();
    if (sessionId) fire("term_close", { id: sessionId });
    try { ligAddon?.dispose(); } catch { /* ignore */ }
    xterm?.dispose();
  });

  // Apply settings changes to the live xterm instance.
  createEffect(() => {
    if (!xterm) return;

    xterm.options.cursorBlink = get<boolean>("terminal.cursorBlink");
    xterm.options.cursorStyle = get<"block" | "bar" | "underline">("terminal.cursorStyle");
    xterm.options.macOptionIsMeta = get<boolean>("terminal.macOptionAsAlt");
    xterm.options.scrollback = get<number>("terminal.scrollback");
    xterm.options.lineHeight = get<number>("terminal.lineHeight");
    xterm.options.letterSpacing = get<number>("terminal.letterSpacing");

    // resolveTerminalTheme reads terminal.customTheme/colorScheme + uiThemeId,
    // so this effect re-runs when the chosen scheme or the app theme changes.
    const theme = resolveTerminalTheme();
    xterm.options.theme = theme;
    // xterm only paints its background on the rendered rows; the sub-cell sliver
    // left when the pane height isn't an exact multiple of the cell height shows
    // through to the container. Paint the container to match so the gap blends in.
    if (theme.background) containerRef.style.background = theme.background;

    // Ligatures addon: load/unload to match the setting. Requires the font's
    // ligature tables to be readable by the renderer.
    const wantLigatures = get<boolean>("terminal.fontLigatures");
    if (wantLigatures && !ligAddon) {
      try { ligAddon = new LigaturesAddon(); xterm.loadAddon(ligAddon); } catch { ligAddon = null; }
    } else if (!wantLigatures && ligAddon) {
      try { ligAddon.dispose(); } catch { /* already gone */ }
      ligAddon = null;
    }

    const fontFamily = get<string>("terminal.fontFamily") || "monospace";
    const fontSize = get<number>("terminal.fontSize");

    // Apply font options only after the face is loaded so xterm remeasures cell
    // dimensions against the real glyphs (otherwise spacing comes out wrong).
    loadFont(fontFamily, fontSize).then(() => {
      if (!xterm || !fitAddon) return;
      xterm.options.fontFamily = cssFontStack(fontFamily);
      xterm.options.fontSize = fontSize;
      requestAnimationFrame(() => {
        fitAddon!.fit();
        if (props.active && sessionId) {
          fire("term_resize", { id: sessionId, cols: xterm!.cols, rows: xterm!.rows });
        }
      });
    });
  });

  // Re-fit and focus when this tab becomes active.
  createEffect(() => {
    if (props.active && fitAddon && xterm && sessionId) {
      requestAnimationFrame(() => {
        fitAddon!.fit();
        fire("term_resize", { id: sessionId!, cols: xterm!.cols, rows: xterm!.rows });
        xterm!.focus();
      });
    }
  });

  return (
    <div
      ref={containerRef!}
      class="terminal-view"
      style={{
        visibility: props.active ? "visible" : "hidden",
        "pointer-events": props.active ? "auto" : "none",
      }}
    />
  );
}

// ── TerminalPanel ───────────────────────────────────────────────────────────

interface TabMeta {
  shellName: string;
  customName: string | null;
}

export function TerminalPanel() {
  // The `<For>`-keyed list is plain numbers, so its item identities only change
  // on add/remove. Per-tab names live in a separate fine-grained store — updating
  // a name does NOT change `tabKeys`, so TerminalViews never remount (a remount
  // would re-run term_create and, via onShellName, loop until PTYs are exhausted).
  const [tabKeys, setTabKeys] = createSignal<number[]>([0]);
  const [meta, setMeta] = createStore<Record<number, TabMeta>>({ 0: { shellName: "", customName: null } });
  const [activeKey, setActiveKey] = createSignal(0);
  const [editingKey, setEditingKey] = createSignal<number | null>(null);
  const [tabsOnLeft, setTabsOnLeft] = createSignal(
    localStorage.getItem("sindri:term-layout") === "left"
  );
  let nextKey = 1;

  function addTab() {
    const key = nextKey++;
    setMeta(key, { shellName: "", customName: null });
    setTabKeys((prev) => [...prev, key]);
    setActiveKey(key);
  }

  function removeTab(key: number) {
    const remaining = tabKeys().filter((k) => k !== key);
    setTabKeys(remaining);
    setMeta(produce((m) => { delete m[key]; }));
    if (activeKey() === key && remaining.length > 0) {
      setActiveKey(remaining[remaining.length - 1]);
    }
  }

  function setShellName(key: number, name: string) {
    if (meta[key]) setMeta(key, "shellName", name);
  }

  function tabLabel(key: number, idx: number): string {
    const m = meta[key];
    return m?.customName ?? (m?.shellName || `Terminal ${idx + 1}`);
  }

  function toggleLayout() {
    const next = !tabsOnLeft();
    setTabsOnLeft(next);
    localStorage.setItem("sindri:term-layout", next ? "left" : "top");
  }

  function commitRename(key: number, value: string) {
    const trimmed = value.trim();
    if (meta[key]) setMeta(key, "customName", trimmed || null);
    setEditingKey(null);
  }

  return (
    <div class={`terminal-panel${tabsOnLeft() ? " terminal-panel--left" : ""}`}>

      {/* ── Top tab bar (default) ──────────────────────────────────── */}
      <Show when={!tabsOnLeft()}>
        <div class="terminal-tab-bar">
          <For each={tabKeys()}>
            {(key, i) => (
              <button
                class={`terminal-tab${activeKey() === key ? " active" : ""}`}
                onClick={() => { if (editingKey() !== key) setActiveKey(key); }}
              >
                <Show
                  when={editingKey() === key}
                  fallback={
                    <span
                      class="terminal-tab-title"
                      onDblClick={(e) => { e.stopPropagation(); setEditingKey(key); }}
                    >
                      {tabLabel(key, i())}
                    </span>
                  }
                >
                  <input
                    class="terminal-tab-rename-input"
                    value={tabLabel(key, i())}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => commitRename(key, e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") { e.stopPropagation(); setEditingKey(null); }
                    }}
                    ref={(el) => requestAnimationFrame(() => { el?.focus(); el?.select(); })}
                  />
                </Show>
                <span
                  class="terminal-tab-close"
                  role="button"
                  tabIndex={0}
                  aria-label="Close terminal"
                  onClick={(e) => { e.stopPropagation(); removeTab(key); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); removeTab(key); }
                  }}
                >
                  ×
                </span>
              </button>
            )}
          </For>
          <button class="terminal-tab-add" title="New terminal" onClick={addTab}>+</button>
          <div class="terminal-tab-spacer" />
          <button class="terminal-layout-toggle" title="Move tabs to left sidebar" onClick={toggleLayout}>
            <PanelLeftIcon />
          </button>
        </div>
      </Show>

      {/* ── Left tab list ─────────────────────────────────────────── */}
      <Show when={tabsOnLeft()}>
        <div class="terminal-tab-list">
          <div class="terminal-tab-list-header">
            <div class="terminal-tab-list-actions">
              <button class="terminal-tab-add" title="New terminal" onClick={addTab}>+</button>
              <button class="terminal-layout-toggle" title="Move tabs to top bar" onClick={toggleLayout}>
                <PanelTopIcon />
              </button>
            </div>
          </div>
          <div class="terminal-tab-list-items">
            <For each={tabKeys()}>
              {(key, i) => (
                <div
                  class={`terminal-tab-list-item${activeKey() === key ? " active" : ""}`}
                  onClick={() => { if (editingKey() !== key) setActiveKey(key); }}
                >
                  <span class={`terminal-tab-list-dot${activeKey() === key ? " active" : ""}`} aria-hidden="true">●</span>
                  <Show
                    when={editingKey() === key}
                    fallback={
                      <span
                        class="terminal-tab-list-name"
                        onDblClick={(e) => { e.stopPropagation(); setEditingKey(key); }}
                      >
                        {tabLabel(key, i())}
                      </span>
                    }
                  >
                    <input
                      class="terminal-tab-rename-input terminal-tab-rename-input--list"
                      value={tabLabel(key, i())}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => commitRename(key, e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                        if (e.key === "Escape") { e.stopPropagation(); setEditingKey(null); }
                      }}
                      ref={(el) => requestAnimationFrame(() => { el?.focus(); el?.select(); })}
                    />
                  </Show>
                  <span
                    class="terminal-tab-close terminal-tab-close--list"
                    role="button"
                    tabIndex={0}
                    aria-label="Close terminal"
                    onClick={(e) => { e.stopPropagation(); removeTab(key); }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); removeTab(key); }
                    }}
                  >
                    ×
                  </span>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      {/* xterm.js views */}
      <div class="terminal-views">
        <For each={tabKeys()}>
          {(key) => (
            <TerminalView
              sessionKey={key}
              active={activeKey() === key}
              onShellName={(name) => setShellName(key, name)}
            />
          )}
        </For>
      </div>

    </div>
  );
}
