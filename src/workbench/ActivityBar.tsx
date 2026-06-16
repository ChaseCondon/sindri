import { For, Show, createSignal, createMemo } from "solid-js";
import {
  layout,
  windowsForDock,
  allRegisteredToolWindows,
  toggleToolWindow,
  reorderToolWindow,
  setDockSize,
  hideToolWindow,
  showToolWindow,
  isToolWindowHidden,
  moveToolWindow,
  type DockId,
  type ToolWindowDef,
} from "./layout";
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
  // APPROACH: Render-list placeholder (icons shift aside) + cached rects.
  //
  // The placeholder (PLACEHOLDER_DEF) is inserted into the flex column so icons
  // genuinely make room for it — the user sees exactly where the icon will land.
  // The dragging source is REMOVED from the list; a ghost clone follows the cursor.
  //
  // FEEDBACK LOOP PREVENTION: All position maths use `cachedRects` — a snapshot
  // taken at drag-start BEFORE any list changes. The render list changes (source
  // removed, placeholder inserted) are purely visual; they never feed back into
  // computeDropTarget because we never re-read live DOM positions during the drag.

  const [draggingId, setDraggingId] = createSignal<string | null>(null);
  const [dropTarget, setDropTarget] = createSignal<{ dock: DockId; afterId: string | null } | null>(null);

  let barRef!: HTMLDivElement;
  let dividerRef!: HTMLDivElement;
  let ghostEl: HTMLButtonElement | null = null;
  const iconRefs = new Map<string, HTMLButtonElement>();

  // Snapshotted at drag-start. Never mutated or re-read from DOM during drag.
  let cachedRects = new Map<string, DOMRect>();
  let cachedDividerTop = Infinity;

  // Build the render list for a given zone, splicing in the placeholder and
  // removing the source. Only reads `draggingId` and `dropTarget` (reactive).
  function buildList(tools: ToolWindowDef[], dock: DockId): ToolWindowDef[] {
    const dId = draggingId();
    const dt = dropTarget();
    if (!dId) return tools;

    if (!dt || dt.dock !== dock) {
      // Not the target dock — just hide the source.
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

  // Compute where to drop based ONLY on cachedRects (stable across list changes).
  function computeDropTarget(clientY: number, dId: string): { dock: DockId; afterId: string | null } {
    const inBottomZone = clientY >= cachedDividerTop;

    function afterBelow(list: ToolWindowDef[]): string | null {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].id === dId) continue;
        const r = cachedRects.get(list[i].id);
        if (r && clientY >= r.top + r.height / 2) return list[i].id;
      }
      return null;
    }

    if (inBottomZone) {
      return { dock: bottomDock(), afterId: afterBelow(sideBottomTools()) };
    }
    return { dock: topDock(), afterId: afterBelow(topTools()) };
  }

  // ── Drag handlers ────────────────────────────────────────────────────────────
  function handleDragStart(e: PointerEvent, id: string) {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLButtonElement;
    el.setPointerCapture(e.pointerId);

    const startY = e.clientY;
    let dragging = false;
    // Snapshot whether the bottom zone was empty (excluding source) at drag-start.
    // Used to decide if we need to size the new zone on drop.
    const wasBtmEmpty = sideBottomTools().filter((t) => t.id !== id).length === 0;

    function cleanup() {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onCancel);
      if (ghostEl) { ghostEl.remove(); ghostEl = null; }
      setDraggingId(null);
      setDropTarget(null);
    }

    function onMove(ev: PointerEvent) {
      if (!dragging && Math.abs(ev.clientY - startY) > 5) {
        dragging = true;

        // Snapshot positions NOW — before `setDraggingId` triggers the list
        // rebuild that removes the source and shifts other icons.
        cachedRects.clear();
        for (const [iconId, iconEl] of iconRefs) {
          cachedRects.set(iconId, iconEl.getBoundingClientRect());
        }
        cachedDividerTop = dividerRef?.getBoundingClientRect()?.top ?? Infinity;

        // Compute the initial drop target before committing to any state changes.
        const initialDt = computeDropTarget(ev.clientY, id);

        // Now update signals (triggers list rebuild).
        setDraggingId(id);
        setDropTarget(initialDt);

        // Clone the icon (at its pre-removal size/position) for the ghost.
        const r = cachedRects.get(id);
        const srcEl = iconRefs.get(id);
        if (srcEl && r) {
          ghostEl = srcEl.cloneNode(true) as HTMLButtonElement;
          Object.assign(ghostEl.style, {
            position: "fixed", zIndex: "9999",
            width: `${r.width}px`, height: `${r.height}px`,
            left: `${r.left}px`, top: `${ev.clientY - r.height / 2}px`,
            opacity: "0.85", pointerEvents: "none",
            transform: "scale(1.1)", transition: "none",
            borderRadius: "8px", boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
            border: "2px solid var(--accent)",
          });
          document.body.appendChild(ghostEl);
        }
      }

      if (dragging) {
        if (ghostEl) ghostEl.style.top = `${ev.clientY - parseFloat(ghostEl.style.height) / 2}px`;
        // Uses cachedRects — no live DOM reads, no feedback loop.
        setDropTarget(computeDropTarget(ev.clientY, id));
      }
    }

    function onUp() {
      const dt = dropTarget();
      const wasActive = dragging;
      cleanup();
      if (wasActive && dt) {
        reorderToolWindow(id, dt.dock, dt.afterId);
        if (wasBtmEmpty && dt.dock === bottomDock()) {
          const railH = barRef?.parentElement?.clientHeight ?? 400;
          setDockSize(bottomDock(), Math.round(railH / 2));
        }
      }
    }

    function onCancel() { cleanup(); }

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onCancel);
  }

  return (
    <div class={`activity-bar activity-bar-${props.side}`} ref={barRef} onContextMenu={barContextMenu}>

      {/* Top sidebar zone */}
      <div class="activity-section">
        <For each={topRenderList()}>
          {(def) => (
            <Show
              when={def.id !== PLACEHOLDER_ID}
              fallback={<div class="activity-placeholder" />}
            >
              <button
                ref={(el) => iconRefs.set(def.id, el)}
                class={`activity-icon${isActive(def.id) ? " active" : ""}`}
                title={def.title}
                onClick={() => toggleToolWindow(def.id)}
                onContextMenu={(e) => iconContextMenu(e, def.id)}
                onPointerDown={(e) => handleDragStart(e, def.id)}
                innerHTML={iconFor(def.id, def.icon)}
              />
            </Show>
          )}
        </For>
      </div>

      {/* Divider — boundary between top and bottom drag zones */}
      <div class="activity-divider" ref={dividerRef} />

      {/* Bottom sidebar zone */}
      <div class="activity-section">
        <For each={btmRenderList()}>
          {(def) => (
            <Show
              when={def.id !== PLACEHOLDER_ID}
              fallback={<div class="activity-placeholder" />}
            >
              <button
                ref={(el) => iconRefs.set(def.id, el)}
                class={`activity-icon${isActive(def.id) ? " active" : ""}`}
                title={def.title}
                onClick={() => toggleToolWindow(def.id)}
                onContextMenu={(e) => iconContextMenu(e, def.id)}
                onPointerDown={(e) => handleDragStart(e, def.id)}
                innerHTML={iconFor(def.id, def.icon)}
              />
            </Show>
          )}
        </For>
      </div>

      {/* Spacer */}
      <div class="activity-spacer" />

      {/* Bottom-dock icons — no reorder drag */}
      <Show when={dockTools().length > 0}>
        <div class="activity-section">
          <For each={dockTools()}>
            {(def) => (
              <button
                ref={(el) => iconRefs.set(def.id, el)}
                class={`activity-icon${isActive(def.id) ? " active" : ""}`}
                title={def.title}
                onClick={() => toggleToolWindow(def.id)}
                onContextMenu={(e) => iconContextMenu(e, def.id)}
                innerHTML={iconFor(def.id, def.icon)}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
