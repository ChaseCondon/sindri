// ADR-0030 — Extension Logs panel.
// Two-pane layout: left = channel tree (extensions grouped by category), right = log view.
// The divider between panes is a locally-managed draggable splitter (panel-internal geometry,
// not stored in the layout store per ADR-0030 §5).
import { createSignal, createEffect, For, Show } from "solid-js";
import {
  extLogsStore,
  selectedChannel,
  setSelectedChannel,
  showRequest,
  markRead,
  extUnread,
  allCategories,
  extsInCategory,
  type LogLine,
} from "./ext-logs-store";

const LEVEL_BADGE: Record<LogLine["level"], string> = {
  log:   "LOG",
  info:  "INF",
  warn:  "WRN",
  error: "ERR",
};

const LEVEL_COLOR: Record<LogLine["level"], string> = {
  log:   "var(--text-dim)",
  info:  "var(--accent)",
  warn:  "#c9a227",
  error: "#e05252",
};

function fmt(ts: number): string {
  const d = new Date(ts);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function ExtensionLogsPanel() {
  // ── Pane-split drag state ───────────────────────────────────────────
  const [leftWidth, setLeftWidth] = createSignal(180);
  const MIN_LEFT = 120;
  const MAX_LEFT = 400;

  function onDividerPointerDown(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = leftWidth();

    function onMove(ev: PointerEvent) {
      const next = Math.max(MIN_LEFT, Math.min(MAX_LEFT, startW + ev.clientX - startX));
      setLeftWidth(next);
    }
    function onUp() {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
    }
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  }

  // ── Category collapse state ─────────────────────────────────────────
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());
  function toggleCategory(cat: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }

  // ── Extension collapse state ────────────────────────────────────────
  const [collapsedExts, setCollapsedExts] = createSignal<Set<string>>(new Set());
  function toggleExt(extId: string) {
    setCollapsedExts((prev) => {
      const next = new Set(prev);
      if (next.has(extId)) next.delete(extId);
      else next.add(extId);
      return next;
    });
  }

  function selectChannel(extId: string, channelId: string) {
    setSelectedChannel({ extId, channelId });
    markRead(extId, channelId);
  }

  // ── Auto-scroll log view ────────────────────────────────────────────
  let logRef!: HTMLDivElement;
  const [autoScroll, setAutoScroll] = createSignal(true);

  function onLogScroll() {
    if (!logRef) return;
    const atBottom = logRef.scrollHeight - logRef.scrollTop - logRef.clientHeight < 32;
    setAutoScroll(atBottom);
  }

  const lines = () => {
    const s = selectedChannel();
    if (!s) return [];
    return extLogsStore[s.extId]?.channels[s.channelId]?.lines ?? [];
  };

  // Scroll to bottom when new lines arrive (if auto-scroll is on).
  createEffect(() => {
    lines(); // subscribe
    if (autoScroll() && logRef) {
      logRef.scrollTop = logRef.scrollHeight;
    }
  });

  // React to OutputChannel.show() requests.
  createEffect(() => {
    const req = showRequest();
    if (req && logRef) {
      logRef.scrollTop = logRef.scrollHeight;
    }
  });

  const selectedExt = () => {
    const s = selectedChannel();
    return s ? extLogsStore[s.extId] : undefined;
  };
  const selectedCh = () => {
    const s = selectedChannel();
    return s ? extLogsStore[s.extId]?.channels[s.channelId] : undefined;
  };

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>

      {/* ── Left pane: channel tree ─────────────────────────────────── */}
      <div
        style={{
          width: `${leftWidth()}px`,
          "min-width": `${MIN_LEFT}px`,
          "flex-shrink": "0",
          "overflow-y": "auto",
          "border-right": "1px solid var(--border)",
          "padding": "4px 0",
          "font-size": "12px",
        }}
      >
        <For each={allCategories()} fallback={
          <div style={{ padding: "12px 8px", color: "var(--text-dim)", "font-size": "12px" }}>
            No extensions loaded
          </div>
        }>
          {(cat) => {
            const exts = () => extsInCategory(cat);
            const catUnread = () => exts().reduce((acc, e) => acc + extUnread(e.id), 0);
            const isCollapsed = () => collapsed().has(cat);
            return (
              <div>
                {/* Category header */}
                <div
                  onClick={() => toggleCategory(cat)}
                  style={{
                    display: "flex",
                    "align-items": "center",
                    gap: "4px",
                    padding: "3px 8px",
                    cursor: "pointer",
                    color: "var(--text-dim)",
                    "text-transform": "uppercase",
                    "letter-spacing": "0.07em",
                    "font-size": "10px",
                    "user-select": "none",
                  }}
                >
                  <span>{isCollapsed() ? "▶" : "▼"}</span>
                  <span style={{ flex: "1" }}>{cat}</span>
                  <Show when={catUnread() > 0}>
                    <span style={{
                      background: "var(--accent)",
                      color: "var(--bg)",
                      "border-radius": "8px",
                      padding: "0 5px",
                      "font-size": "10px",
                    }}>{catUnread()}</span>
                  </Show>
                </div>

                {/* Extensions in category */}
                <Show when={!isCollapsed()}>
                  <For each={exts()}>
                    {(ext) => {
                      const extCollapsed = () => collapsedExts().has(ext.id);
                      const unread = () => extUnread(ext.id);
                      const channels = () => Object.values(ext.channels);
                      return (
                        <div>
                          {/* Extension row */}
                          <div
                            onClick={() => toggleExt(ext.id)}
                            style={{
                              display: "flex",
                              "align-items": "center",
                              gap: "4px",
                              padding: "3px 8px 3px 16px",
                              cursor: "pointer",
                              color: "var(--text)",
                              "font-size": "12px",
                              "user-select": "none",
                            }}
                          >
                            <span style={{ color: "var(--text-dim)", "font-size": "10px" }}>
                              {extCollapsed() ? "▶" : "▼"}
                            </span>
                            <span style={{ flex: "1", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                              {ext.name}
                            </span>
                            <Show when={unread() > 0 && extCollapsed()}>
                              <span style={{
                                background: "var(--accent)",
                                color: "var(--bg)",
                                "border-radius": "8px",
                                padding: "0 5px",
                                "font-size": "10px",
                              }}>{unread()}</span>
                            </Show>
                          </div>

                          {/* Channel rows */}
                          <Show when={!extCollapsed()}>
                            <For each={channels()}>
                              {(ch) => {
                                const isSelected = () => {
                                  const sel = selectedChannel();
                                  return sel?.extId === ext.id && sel?.channelId === ch.channelId;
                                };
                                return (
                                  <div
                                    onClick={() => selectChannel(ext.id, ch.channelId)}
                                    style={{
                                      display: "flex",
                                      "align-items": "center",
                                      gap: "6px",
                                      padding: "3px 8px 3px 28px",
                                      cursor: "pointer",
                                      background: isSelected() ? "var(--accent-subtle, color-mix(in srgb, var(--accent) 15%, transparent))" : "transparent",
                                      color: isSelected() ? "var(--accent)" : "var(--text-dim)",
                                      "font-size": "12px",
                                      "user-select": "none",
                                    }}
                                  >
                                    <span style={{ color: isSelected() ? "var(--accent)" : "var(--text-dim)", "font-size": "9px" }}>
                                      {isSelected() ? "●" : "○"}
                                    </span>
                                    <span style={{ flex: "1", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                                      {ch.name}
                                    </span>
                                    <Show when={ch.unread > 0 && !isSelected()}>
                                      <span style={{
                                        background: "var(--accent)",
                                        color: "var(--bg)",
                                        "border-radius": "8px",
                                        padding: "0 5px",
                                        "font-size": "10px",
                                      }}>{ch.unread}</span>
                                    </Show>
                                  </div>
                                );
                              }}
                            </For>
                          </Show>
                        </div>
                      );
                    }}
                  </For>
                </Show>
              </div>
            );
          }}
        </For>
      </div>

      {/* ── Drag divider ────────────────────────────────────────────── */}
      <div
        onPointerDown={onDividerPointerDown}
        style={{
          width: "4px",
          cursor: "col-resize",
          "flex-shrink": "0",
          background: "transparent",
          transition: "background 0.1s",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--accent)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      />

      {/* ── Right pane: log view ────────────────────────────────────── */}
      <div style={{ flex: "1", display: "flex", "flex-direction": "column", overflow: "hidden" }}>
        {/* Log header */}
        <div style={{
          display: "flex",
          "align-items": "center",
          gap: "8px",
          padding: "4px 8px",
          "border-bottom": "1px solid var(--border)",
          "font-size": "12px",
          "flex-shrink": "0",
          color: "var(--text-dim)",
        }}>
          <Show when={selectedCh()} fallback={<span style={{ opacity: ".5" }}>Select a channel</span>}>
            <span>
              {selectedExt()?.name ?? ""} › {selectedCh()?.name ?? ""}
            </span>
            <span style={{ flex: "1" }} />
          </Show>
        </div>

        {/* Log lines */}
        <div
          ref={logRef!}
          onScroll={onLogScroll}
          style={{
            flex: "1",
            "overflow-y": "auto",
            "font-family": "var(--font-mono, monospace)",
            "font-size": "12px",
            padding: "4px 0",
          }}
        >
          <Show
            when={lines().length > 0}
            fallback={
              <div style={{ padding: "12px 12px", color: "var(--text-dim)", "font-size": "12px" }}>
                No output yet
              </div>
            }
          >
            <For each={lines()}>
              {(line) => (
                <div style={{
                  display: "flex",
                  gap: "8px",
                  padding: "1px 8px",
                  "align-items": "baseline",
                  "line-height": "1.5",
                }}>
                  <span style={{ color: "var(--text-dim)", "white-space": "nowrap", "flex-shrink": "0" }}>
                    {fmt(line.ts)}
                  </span>
                  <span style={{
                    color: LEVEL_COLOR[line.level],
                    "font-size": "10px",
                    "white-space": "nowrap",
                    "flex-shrink": "0",
                    "letter-spacing": "0.05em",
                    "padding-top": "1px",
                  }}>
                    {LEVEL_BADGE[line.level]}
                  </span>
                  <span style={{ color: "var(--text)", "white-space": "pre-wrap", "word-break": "break-all" }}>
                    {line.msg}
                  </span>
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  );
}
