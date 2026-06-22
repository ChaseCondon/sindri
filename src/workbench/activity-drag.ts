import { createSignal } from "solid-js";
import type { DockId } from "./layout";

// Shared, cross-rail tool-window drag state (ADR-0018 §5, v0.2).
//
// Both ActivityBar instances (left + right) read these module-level signals, so a
// drag that starts in one rail can render its drop placeholder in the other rail.
// All hit-testing runs off a geometry snapshot taken once at drag-start — the live
// DOM shifting (source removed, placeholder spliced) is purely visual and never
// feeds back into the drop computation.

export interface DropTarget {
  dock: DockId;
  afterId: string | null;
}

const [draggingId, setDraggingId] = createSignal<string | null>(null);
const [dropTarget, setDropTarget] = createSignal<DropTarget | null>(null);

export { draggingId, setDraggingId, dropTarget, setDropTarget };
export const isDragging = () => draggingId() !== null;

// ── Geometry snapshot ─────────────────────────────────────────────────────────
interface IconSnap { id: string; dock: DockId; rect: DOMRect; }
interface BarSnap {
  side: "left" | "right";
  rect: DOMRect;
  dividerY: number;       // center Y of the top/bottom divider
  dockSectionTop: number; // top Y of the bottom-dock section, Infinity when absent
}

let cachedIcons: IconSnap[] = [];
let cachedBars: BarSnap[] = [];

/** Snapshot every activity-bar icon + rail landmark. Call AFTER the source icon has
 *  left the list and empty rails have been force-rendered, so the snapshot matches
 *  exactly what the user sees and drops onto. */
export function snapshotGeometry(): void {
  cachedIcons = [...document.querySelectorAll<HTMLElement>(".activity-icon[data-wid]")].map((el) => ({
    id: el.dataset.wid!,
    dock: el.dataset.dock as DockId,
    rect: el.getBoundingClientRect(),
  }));

  cachedBars = [...document.querySelectorAll<HTMLElement>(".activity-bar")].map((bar) => {
    const divider = bar.querySelector<HTMLElement>(".activity-divider");
    const dr = divider?.getBoundingClientRect();
    const dockSection = bar.querySelector<HTMLElement>('.activity-section[data-dock="bottom"]');
    const dsr = dockSection?.getBoundingClientRect();
    return {
      side: bar.classList.contains("activity-bar-right") ? "right" : "left",
      rect: bar.getBoundingClientRect(),
      dividerY: dr ? dr.top + dr.height / 2 : Infinity,
      dockSectionTop: dsr && dsr.height > 0 ? dsr.top : Infinity,
    };
  });
}

/** Resolve (x, y) to a dock + insertion point. Returns null when the cursor is not
 *  over any activity bar — a drop there is a no-op (cancel), not a valid target. */
export function computeDropTarget(x: number, y: number, draggedId: string): DropTarget | null {
  const bar = cachedBars.find((b) => x >= b.rect.left && x <= b.rect.right);
  if (!bar) return null;

  let dock: DockId;
  if (y >= bar.dockSectionTop) dock = "bottom";
  else if (y < bar.dividerY) dock = `${bar.side}-top` as DockId;
  else dock = `${bar.side}-bottom` as DockId;

  const inDock = cachedIcons
    .filter((i) => i.dock === dock && i.id !== draggedId)
    .sort((a, b) => a.rect.top - b.rect.top);

  let afterId: string | null = null;
  for (const ic of inDock) {
    if (y >= ic.rect.top + ic.rect.height / 2) afterId = ic.id;
  }
  return { dock, afterId };
}

export function clearGeometry(): void {
  cachedIcons = [];
  cachedBars = [];
}
