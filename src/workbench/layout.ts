import { createStore, produce } from "solid-js/store";
import type { Component } from "solid-js";

export type DockId =
  | "left-top" | "left-bottom"
  | "right-top" | "right-bottom"
  | "top" | "bottom"
  | "popup"; // Rendered as a fixed-position overlay above the status bar; no activity-bar icon.

export function dockRail(id: DockId): "left" | "right" | "top" | "bottom" {
  if (id === "left-top" || id === "left-bottom") return "left";
  if (id === "right-top" || id === "right-bottom") return "right";
  if (id === "popup") return "bottom"; // popup has no rail; treated like bottom for resize math
  return id as "top" | "bottom";
}

/** "bottom" for the lower zone inside a left/right rail; "top" for everything else */
export function dockZone(id: DockId): "top" | "bottom" {
  return id.endsWith("-bottom") ? "bottom" : "top";
}

export interface ToolWindowDef {
  id: string;
  title: string;
  /** SVG markup string shown in the activity bar (rendered via innerHTML).
   *  Will eventually be sourced from IconThemeDef.ui per ADR-0019 §4. */
  icon: string;
  defaultDock: DockId;
  render: Component;
  /** Optional icon-button actions rendered in the panel header bar. */
  headerActions?: Component;
}

export interface WindowState {
  dock: DockId;
  open: boolean;
  floating: boolean;
  order?: number;
  hidden?: boolean; // icon hidden from the activity bar; panel inaccessible until shown again
}

interface LayoutState {
  registry: Record<string, ToolWindowDef>;
  windows: Record<string, WindowState>;
  /** Active tool-window id per dock */
  activeTabs: Partial<Record<DockId, string>>;
  /** Dock bar size in px: width for left/right rails, height for top/bottom */
  dockSizes: Partial<Record<DockId, number>>;
}

interface PersistableLayout {
  windows: Record<string, WindowState>;
  activeTabs: Partial<Record<DockId, string>>;
  dockSizes: Partial<Record<DockId, number>>;
}

const STORAGE_KEY = "sindri:layout";

function migratePersistedLayout(data: Partial<PersistableLayout>): Partial<PersistableLayout> {
  // Cumulative migrations: old DockId strings → current values
  const rename = (k: string): string => {
    if (k === "left" || k === "left-primary") return "left-top";
    if (k === "right" || k === "right-primary") return "right-top";
    if (k === "left-secondary") return "left-bottom";
    if (k === "right-secondary") return "right-bottom";
    // "top" dock has no rendered bar — rescue stranded icons back to left-top
    if (k === "top") return "left-top";
    return k;
  };
  if (data.windows) {
    for (const win of Object.values(data.windows)) {
      win.dock = rename(win.dock as string) as DockId;
    }
  }
  if (data.activeTabs) {
    const next: Partial<Record<DockId, string>> = {};
    for (const [k, v] of Object.entries(data.activeTabs)) next[rename(k) as DockId] = v;
    data.activeTabs = next;
  }
  if (data.dockSizes) {
    const next: Partial<Record<DockId, number>> = {};
    for (const [k, v] of Object.entries(data.dockSizes)) next[rename(k) as DockId] = v;
    data.dockSizes = next;
  }
  return data;
}

function loadPersistedLayout(): Partial<PersistableLayout> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? migratePersistedLayout(JSON.parse(stored)) : {};
  } catch {
    return {};
  }
}

function persistLayout(layout: LayoutState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      windows: layout.windows,
      activeTabs: layout.activeTabs,
      dockSizes: layout.dockSizes,
    } satisfies PersistableLayout));
  } catch {}
}

const persisted = loadPersistedLayout();
const [layout, setLayout] = createStore<LayoutState>({
  registry: {},
  windows: persisted.windows ?? {},
  activeTabs: persisted.activeTabs ?? {},
  dockSizes: persisted.dockSizes ?? { "left-top": 240, bottom: 200 },
});

export { layout };

export function registerToolWindow(def: ToolWindowDef): void {
  setLayout(
    produce((s) => {
      s.registry[def.id] = def;
      if (!s.windows[def.id]) {
        const inDock = Object.values(s.windows).filter((w) => w.dock === def.defaultDock);
        const maxOrder = inDock.reduce((m, w) => Math.max(m, w.order ?? -1), -1);
        s.windows[def.id] = { dock: def.defaultDock, open: false, floating: false, order: maxOrder + 1 };
      } else {
        // Panel was previously registered. Clear stale hidden flag so it becomes
        // visible in the activity bar again after reinstall.
        s.windows[def.id].hidden = false;
        // If the stored dock is somehow missing/invalid, reset to the declared default.
        if (!s.windows[def.id].dock) {
          s.windows[def.id].dock = def.defaultDock;
        }
      }
      if (!s.activeTabs[def.defaultDock]) {
        s.activeTabs[def.defaultDock] = def.id;
      }
    })
  );
  persistLayout(layout);
}

export function openToolWindow(id: string): void {
  setLayout(
    produce((s) => {
      if (!s.windows[id]) return;
      const dock = s.windows[id].dock;
      // Exclusive single-open per dock: close others so clicking through the
      // activity bar switches panels rather than accumulating open ones.
      for (const [wid, w] of Object.entries(s.windows)) {
        if (wid !== id && w.dock === dock) s.windows[wid].open = false;
      }
      s.windows[id].open = true;
      s.activeTabs[dock] = id;
    })
  );
  persistLayout(layout);
}

export function closeToolWindow(id: string): void {
  setLayout(
    produce((s) => {
      if (!s.windows[id]) return;
      const dock = s.windows[id].dock;
      s.windows[id].open = false;
      if (s.activeTabs[dock] === id) {
        const next = Object.entries(s.windows).find(
          ([wid, w]) => wid !== id && w.dock === dock && w.open
        );
        s.activeTabs[dock] = next ? next[0] : undefined;
      }
    })
  );
  persistLayout(layout);
}

export function toggleToolWindow(id: string): void {
  const win = layout.windows[id];
  if (!win) return;
  if (win.open && layout.activeTabs[win.dock] === id) {
    closeToolWindow(id);
  } else {
    openToolWindow(id);
  }
}

export function moveToolWindow(id: string, dock: DockId): void {
  setLayout(
    produce((s) => {
      if (!s.windows[id]) return;
      const oldDock = s.windows[id].dock;
      // Clear old dock's active tab if it was pointing at this window
      if (oldDock !== dock && s.activeTabs[oldDock] === id) {
        const next = Object.entries(s.windows).find(
          ([wid, w]) => wid !== id && w.dock === oldDock && w.open
        );
        s.activeTabs[oldDock] = next ? next[0] : undefined;
      }
      s.windows[id].dock = dock;
      if (!s.activeTabs[dock]) s.activeTabs[dock] = id;
    })
  );
  persistLayout(layout);
}

/** Move `id` to `targetDock`, inserting it after `afterId` (or at the start if null).
 *  Re-assigns contiguous order values for the target dock. */
export function reorderToolWindow(id: string, targetDock: DockId, afterId: string | null): void {
  setLayout(
    produce((s) => {
      if (!s.windows[id]) return;
      const oldDock = s.windows[id].dock;
      // Clear old dock's active tab pointer if moving to a different dock
      if (oldDock !== targetDock && s.activeTabs[oldDock] === id) {
        const next = Object.entries(s.windows).find(
          ([wid, w]) => wid !== id && w.dock === oldDock && w.open
        );
        s.activeTabs[oldDock] = next ? next[0] : undefined;
      }
      s.windows[id].dock = targetDock;
      s.windows[id].open = true;
      if (!s.activeTabs[targetDock]) s.activeTabs[targetDock] = id;

      // Rebuild order for target dock (excluding the dragged id, then insert)
      const others = Object.entries(s.windows)
        .filter(([wid, w]) => wid !== id && w.dock === targetDock)
        .sort(([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0))
        .map(([wid]) => wid);

      const insertIdx = afterId !== null ? others.indexOf(afterId) + 1 : 0;
      others.splice(Math.max(0, insertIdx), 0, id);
      others.forEach((wid, idx) => { if (s.windows[wid]) s.windows[wid].order = idx; });
    })
  );
  persistLayout(layout);
}

export function setActiveTab(dock: DockId, id: string): void {
  setLayout(
    produce((s) => {
      if (!s.windows[id]) return;
      s.activeTabs[dock] = id;
      s.windows[id].open = true;
    })
  );
  persistLayout(layout);
}

export function setDockSize(dock: DockId, px: number): void {
  setLayout("dockSizes", dock, px);
  persistLayout(layout);
}

/** All registered windows assigned to a given dock, sorted by order. Excludes hidden windows. */
export function windowsForDock(dock: DockId): ToolWindowDef[] {
  return Object.values(layout.registry)
    .filter((def) => layout.windows[def.id]?.dock === dock && !layout.windows[def.id]?.hidden)
    .sort((a, b) => (layout.windows[a.id]?.order ?? 0) - (layout.windows[b.id]?.order ?? 0));
}

/** All registered windows for a dock, including hidden ones. */
export function allWindowsForDock(dock: DockId): ToolWindowDef[] {
  return Object.values(layout.registry)
    .filter((def) => layout.windows[def.id]?.dock === dock)
    .sort((a, b) => (layout.windows[a.id]?.order ?? 0) - (layout.windows[b.id]?.order ?? 0));
}

/** All registered tool windows across all docks (for the show/hide menu). */
export function allRegisteredToolWindows(): ToolWindowDef[] {
  return Object.values(layout.registry).sort(
    (a, b) => (layout.windows[a.id]?.order ?? 0) - (layout.windows[b.id]?.order ?? 0)
  );
}

export function isToolWindowHidden(id: string): boolean {
  return !!layout.windows[id]?.hidden;
}

export function hideToolWindow(id: string): void {
  setLayout(produce((s) => {
    if (!s.windows[id]) return;
    s.windows[id].hidden = true;
    s.windows[id].open = false;
  }));
  persistLayout(layout);
}

export function showToolWindow(id: string): void {
  setLayout(produce((s) => {
    if (!s.windows[id]) return;
    s.windows[id].hidden = false;
  }));
  persistLayout(layout);
}

/** True when at least one window in the dock is open. */
export function isDockOpen(dock: DockId): boolean {
  return Object.values(layout.windows).some((w) => w.dock === dock && w.open && !w.hidden);
}

/** True when at least one window is registered (not hidden) for a given sidebar side.
 *  Used to conditionally render the ActivityBar — it shows as long as any panel can
 *  be reopened from it, but hides after all panels for that side are unregistered. */
export function hasWindowsForSide(side: "left" | "right"): boolean {
  const top = `${side}-top` as DockId;
  const btm = `${side}-bottom` as DockId;
  return Object.keys(layout.registry).some((id) => {
    const dock = layout.windows[id]?.dock;
    return (dock === top || dock === btm) && !layout.windows[id]?.hidden;
  });
}

/** Remove a tool window entirely from the registry and layout.
 *  Call this when uninstalling an extension — it ensures the panel vanishes from the
 *  activity bar and the dock rail, and won't be re-hydrated from persisted layout on
 *  next launch. */
export function unregisterToolWindow(id: string): void {
  setLayout(produce((s) => {
    if (!s.registry[id]) return;
    const dock = s.windows[id]?.dock;
    delete s.registry[id];
    delete s.windows[id];
    if (dock && s.activeTabs[dock] === id) {
      const next = Object.entries(s.windows).find(
        ([wid, w]) => wid !== id && w.dock === dock && w.open && !w.hidden
      );
      s.activeTabs[dock] = next ? next[0] : undefined;
    }
  }));
  persistLayout(layout);
}
