import { For, Show, createMemo } from "solid-js";
import {
  layout,
  windowsForDock,
  allRegisteredToolWindows,
  toggleToolWindow,
  reorderToolWindow,
  openToolWindow,
  hideToolWindow,
  showToolWindow,
  isToolWindowHidden,
  moveToolWindow,
  type DockId,
  type ToolWindowDef,
} from "./layout";
import {
  draggingId,
  setDraggingId,
  dropTarget,
  setDropTarget,
  isDragging,
  snapshotGeometry,
  computeDropTarget,
  clearGeometry,
} from "./activity-drag";
import { openMenu } from "./ContextMenu";
import { activeUiIconPack } from "../theme/registry";

function iconFor(id: string, fallback: string): string {
  return activeUiIconPack()?.icons[id] ?? fallback;
}

const MOVEABLE_DOCKS: DockId[] = [
  "left-top", "left-bottom",
  "right-top", "right-bottom",
  "bottom",
];
const DOCK_LABELS: Partial<Record<DockId, string>> = {
  "left-top": "Left sidebar (top)",
  "left-bottom": "Left sidebar (bottom)",
  "right-top": "Right sidebar (top)",
  "right-bottom": "Right sidebar (bottom)",
  bottom: "Bottom dock",
};

interface Props {
  side: "left" | "right";
}

// Sentinel for the visual drop-placeholder slot in the render list.
// The placeholder lives in the flex column so icons genuinely move aside —
// it has no real ToolWindowDef data; the `id` is enough for the For key.
const PLACEHOLDER_ID = "__drag-placeholder__";
const PLACEHOLDER_DEF = { id: PLACEHOLDER_ID } as ToolWindowDef;

export function ActivityBar(props: Props) {
  const topDock = (): DockId => `${props.side}-top` as DockId;
  const bottomDock = (): DockId => `${props.side}-bottom` as DockId;

  const topTools = () => windowsForDock(topDock());
  const sideBottomTools = () => windowsForDock(bottomDock());
  const dockTools = () => (props.side === "left" ? windowsForDock("bottom") : []);

  const isActive = (id: string) => {
    const win = layout.windows[id];
    return !!win?.open && layout.activeTabs[win.dock] === id;
  };

  function iconContextMenu(e: MouseEvent, id: string) {
    e.preventDefault();
    const currentDock = layout.windows[id]?.dock;
    openMenu(e.clientX, e.clientY, [
      { label: "Hide from sidebar", action: () => hideToolWindow(id) },
      { label: "──────────────", action: () => {} },
      ...MOVEABLE_DOCKS.filter((d) => d !== currentDock).map((d) => ({
        label: `Move to ${DOCK_LABELS[d]}`,
        action: () => moveToolWindow(id, d),
      })),
    ]);
  }

  function barContextMenu(e: MouseEvent) {
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    const all = allRegisteredToolWindows();

    const sectionLabels: [string, DockId | "hidden"][] = [
      ["Left sidebar — top",    "left-top"],
      ["Left sidebar — bottom", "left-bottom"],
      ["Bottom dock",           "bottom"],
      ["Right sidebar — top",   "right-top"],
      ["Right sidebar — bottom","right-bottom"],
      ["Hidden",                "hidden"],
    ];

    const items: Parameters<typeof openMenu>[2] = [];
    for (const [label, section] of sectionLabels) {
      const panelsInSection = section === "hidden"
        ? all.filter((d) => isToolWindowHidden(d.id))
        : all.filter((d) => !isToolWindowHidden(d.id) && layout.windows[d.id]?.dock === section);
      if (panelsInSection.length === 0) continue;

      items.push({ label: `— ${label} —`, action: () => {} });
      for (const def of panelsInSection) {
        if (section === "hidden") {
          items.push({
            label: `◌ ${def.title}  ↩ show`,
            action: () => openMenu(e.clientX, e.clientY, [
              { label: "Add to…", action: () => {} },
              ...MOVEABLE_DOCKS.map((d) => ({
                label: `  ${DOCK_LABELS[d]}`,
                action: () => { showToolWindow(def.id); moveToolWindow(def.id, d); },
              })),
            ]),
          });
        } else {
          items.push({
            label: `● ${def.title}`,
            action: () => hideToolWindow(def.id),
          });
        }
      }
    }

    openMenu(e.clientX, e.clientY, items);
  }

  // ── Drag state ──────────────────────────────────────────────────────────────
  //
  // APPROACH: shared cross-rail state (activity-drag.ts) + render-list placeholder.
  //
  // Drag signals live in activity-drag.ts so BOTH rails react to one drag — the
  // source leaves its rail's list while the target rail (possibly the opposite
  // side, possibly previously empty) shows the placeholder. A ghost clone follows
  // the cursor. All position maths use the geometry snapshot taken at drag-start.

  let barRef!: HTMLDivElement;
  let ghostEl: HTMLButtonElement | null = null;

  // Build the render list for a given zone, splicing in the placeholder and
  // removing the source. Only reads `draggingId`/`dropTarget` (reactive, shared).
  function buildList(tools: ToolWindowDef[], dock: DockId): ToolWindowDef[] {
    const dId = draggingId();
    const dt = dropTarget();
    if (!dId) return tools;

    if (!dt || dt.dock !== dock) {
      // Not the target dock — just hide the source (no-op where source isn't present).
      return tools.filter((t) => t.id !== dId);
    }

    // Target dock — remove source, splice in placeholder.
    const result = tools.filter((t) => t.id !== dId);
    const afterIdx = dt.afterId !== null ? result.findIndex((t) => t.id === dt.afterId) : -1;
    result.splice(afterIdx + 1, 0, PLACEHOLDER_DEF);
    return result;
  }

  const topRenderList = createMemo(() => buildList(topTools(), topDock()));
  const btmRenderList = createMemo(() => buildList(sideBottomTools(), bottomDock()));
  const dockRenderList = createMemo(() => buildList(dockTools(), "bottom"));

  // ── Drag handlers ────────────────────────────────────────────────────────────
  function handleDragStart(e: PointerEvent, id: string) {
    if (e.button !== 0) return;

    // NOTE: do NOT setPointerCapture / preventDefault here. Capturing on pointerdown
    // re-targets the pointerup to barRef, swallowing plain icon clicks. We engage
    // capture only once an actual drag starts (past the move threshold).
    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    let captured = false;
    let ghostH = 0;

    function cleanup() {
      barRef.removeEventListener("pointermove", onMove);
      barRef.removeEventListener("pointerup", onUp);
      barRef.removeEventListener("pointercancel", onCancel);
      if (captured) {
        try { barRef.releasePointerCapture(pointerId); } catch { /* already released */ }
        captured = false;
      }
      if (ghostEl) { ghostEl.remove(); ghostEl = null; }
      document.body.classList.remove("user-dragging");
      setDraggingId(null);
      setDropTarget(null);
      clearGeometry();
    }

    function onMove(ev: PointerEvent) {
      if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 5) {
        dragging = true;

        // A real drag is underway — take pointer capture on barRef (the source bar
        // stays mounted even after the source button leaves the list) so every
        // subsequent move/up routes here regardless of what's under the cursor.
        ev.preventDefault();
        barRef.setPointerCapture(pointerId);
        captured = true;
        document.body.classList.add("user-dragging");

        // 1. Ghost from the live source element BEFORE it leaves the render list.
        const srcEl = document.querySelector<HTMLButtonElement>(
          `.activity-icon[data-wid="${CSS.escape(id)}"]`
        );
        const r = srcEl?.getBoundingClientRect();
        if (srcEl && r) {
          ghostH = r.height;
          ghostEl = srcEl.cloneNode(true) as HTMLButtonElement;
          Object.assign(ghostEl.style, {
            position: "fixed", zIndex: "9999",
            width: `${r.width}px`, height: `${r.height}px`,
            left: `${r.left}px`, top: `${ev.clientY - r.height / 2}px`,
            margin: "0", opacity: "0.85", pointerEvents: "none",
            transform: "scale(1.1)", transition: "none",
            borderRadius: "8px", boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
            border: "2px solid var(--accent)",
          });
          document.body.appendChild(ghostEl);
        }

        // 2. Enter drag mode — both rails (incl. empty ones, force-rendered by
        //    Workbench) now show as drop zones and the source leaves its list.
        setDraggingId(id);

        // 3. Snapshot the resulting geometry, then compute the first target.
        snapshotGeometry();
        setDropTarget(computeDropTarget(ev.clientX, ev.clientY, id));
      }

      if (dragging) {
        if (ghostEl) ghostEl.style.top = `${ev.clientY - ghostH / 2}px`;
        setDropTarget(computeDropTarget(ev.clientX, ev.clientY, id));
      }
    }

    function onUp() {
      const dt = dropTarget();
      const wasActive = dragging;
      cleanup();
      if (wasActive && dt) {
        reorderToolWindow(id, dt.dock, dt.afterId);
        // Surface the moved panel in its new dock (exclusive-open per ADR-0010).
        openToolWindow(id);
      }
    }

    function onCancel() { cleanup(); }

    barRef.addEventListener("pointermove", onMove);
    barRef.addEventListener("pointerup", onUp);
    barRef.addEventListener("pointercancel", onCancel);
  }

  function renderIcon(def: ToolWindowDef, dock: DockId) {
    return (
      <Show
        when={def.id !== PLACEHOLDER_ID}
        fallback={<div class="activity-placeholder" />}
      >
        <button
          data-wid={def.id}
          data-dock={dock}
          class={`activity-icon${isActive(def.id) ? " active" : ""}`}
          title={def.title}
          onClick={() => toggleToolWindow(def.id)}
          onContextMenu={(e) => iconContextMenu(e, def.id)}
          onPointerDown={(e) => handleDragStart(e, def.id)}
          innerHTML={iconFor(def.id, def.icon)}
        />
      </Show>
    );
  }

  const zoneClass = (dock: DockId) =>
    `activity-section${dropTarget()?.dock === dock ? " drop-target-zone" : ""}`;

  return (
    <div
      class={`activity-bar activity-bar-${props.side}${isDragging() ? " drag-active" : ""}`}
      ref={barRef}
      onContextMenu={barContextMenu}
    >
      {/* Top sidebar zone */}
      <div class={zoneClass(topDock())}>
        <For each={topRenderList()}>{(def) => renderIcon(def, topDock())}</For>
      </div>

      {/* Divider — boundary between top and bottom drag zones */}
      <div class="activity-divider" />

      {/* Bottom sidebar zone */}
      <div class={zoneClass(bottomDock())}>
        <For each={btmRenderList()}>{(def) => renderIcon(def, bottomDock())}</For>
      </div>

      {/* Spacer */}
      <div class="activity-spacer" />

      {/* Bottom-dock icons (left rail only) — force-rendered during a drag so the
          bottom dock is a reachable drop target even when currently empty. */}
      <Show when={props.side === "left" && (dockTools().length > 0 || isDragging())}>
        <div class={zoneClass("bottom")} data-dock="bottom">
          <For each={dockRenderList()}>{(def) => renderIcon(def, "bottom")}</For>
        </div>
      </Show>
    </div>
  );
}
