import { For, Show, createSignal } from "solid-js";
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
  type DockId,
} from "./layout";
import { openMenu } from "./ContextMenu";
import { moveToolWindow } from "./layout";
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

// The drag indicator state: where the dropped icon will land + the Y position
// (relative to the activity-bar element) for the absolutely-positioned block.
interface DragState {
  id: string;
  dock: DockId;
  afterId: string | null;
  isNewZone: boolean;
  blockY: number; // top of the 36px indicator block, px from bar top
}


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

  // ── Drag state ─────────────────────────────────────────────────
  // The indicator block is absolutely positioned inside `.activity-bar`
  // (which has position:relative). It does NOT modify the render list, so
  // icon DOM positions never shift during drag — no feedback loop.
  const [dragState, setDragState] = createSignal<DragState | null>(null);

  let barRef!: HTMLDivElement;
  let dividerRef!: HTMLDivElement;
  let ghostEl: HTMLButtonElement | null = null;
  const iconRefs = new Map<string, HTMLButtonElement>();

  // Cached icon rects taken at the START of each drag (before any visual
  // changes) so computations stay stable throughout the gesture.
  let cachedRects = new Map<string, DOMRect>();
  let cachedDividerBottom = Infinity;

  function computeDragState(clientY: number, dId: string): DragState {
    const topList = topTools();
    const btmList = sideBottomTools();
    const barTop = barRef.getBoundingClientRect().top;
    const inBottomZone = clientY >= cachedDividerBottom - 4;

    function afterBelow(list: typeof topList): string | null {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].id === dId) continue;
        const r = cachedRects.get(list[i].id);
        if (r && clientY >= r.top + r.height / 2) return list[i].id;
      }
      return null;
    }

    function blockY(afterId: string | null, fallbackY: number): number {
      if (afterId !== null) {
        const r = cachedRects.get(afterId);
        return r ? r.bottom - barTop + 1 : fallbackY;
      }
      return fallbackY; // "place at top of zone" — use the zone's top offset
    }

    if (inBottomZone) {
      const afterId = afterBelow(btmList);
      const fallback = cachedDividerBottom - barTop + 2;
      return {
        id: dId, dock: bottomDock(), afterId,
        isNewZone: btmList.length === 0,
        blockY: blockY(afterId, fallback),
      };
    }

    const afterId = afterBelow(topList);
    return {
      id: dId, dock: topDock(), afterId,
      isNewZone: false,
      blockY: blockY(afterId, 4),
    };
  }

  // ── Drag handlers ───────────────────────────────────────────────
  function handleDragStart(e: PointerEvent, id: string) {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLButtonElement;
    el.setPointerCapture(e.pointerId);

    const startY = e.clientY;
    let dragging = false;

    function cleanup() {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onCancel);
      if (ghostEl) { ghostEl.remove(); ghostEl = null; }
      setDragState(null);
    }

    function onMove(ev: PointerEvent) {
      if (!dragging && Math.abs(ev.clientY - startY) > 5) {
        dragging = true;
        // Snapshot ALL icon and divider positions NOW, before any visual
        // changes happen. These cached rects are used for all subsequent
        // computeDropTarget calls — stable, no feedback loop.
        cachedRects.clear();
        for (const [iconId, iconEl] of iconRefs) {
          cachedRects.set(iconId, iconEl.getBoundingClientRect());
        }
        cachedDividerBottom = dividerRef?.getBoundingClientRect()?.bottom ?? Infinity;

        setDragState({ id, dock: topDock(), afterId: null, isNewZone: false, blockY: 4 });

        const srcEl = iconRefs.get(id);
        if (srcEl) {
          const r = srcEl.getBoundingClientRect();
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
        setDragState(computeDragState(ev.clientY, id));
      }
    }

    function onUp() {
      const ds = dragState();
      const wasActive = dragging;
      cleanup();
      if (wasActive && ds) {
        reorderToolWindow(id, ds.dock, ds.afterId);
        if (ds.isNewZone) {
          const railH = barRef.parentElement?.clientHeight ?? 400;
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

      {/* Drop indicator — absolutely positioned block, doesn't shift icons */}
      <Show when={dragState()}>
        <div class="activity-drop-indicator" style={{ top: `${dragState()!.blockY}px` }} />
      </Show>

      {/* Top sidebar zone */}
      <div class="activity-section">
        <For each={topTools()}>
          {(def) => (
            <button
              ref={(el) => iconRefs.set(def.id, el)}
              class={`activity-icon${isActive(def.id) ? " active" : ""}${dragState()?.id === def.id ? " icon-dragging-source" : ""}`}
              title={def.title}
              onClick={() => toggleToolWindow(def.id)}
              onContextMenu={(e) => iconContextMenu(e, def.id)}
              onPointerDown={(e) => handleDragStart(e, def.id)}
              innerHTML={iconFor(def.id, def.icon)}
            />
          )}
        </For>
      </div>

      {/* Divider — always visible; marks the boundary between top and bottom zones */}
      <div class="activity-divider" ref={dividerRef} />

      {/* Bottom sidebar zone — always rendered so the divider position is stable */}
      <div class="activity-section">
        <For each={sideBottomTools()}>
          {(def) => (
            <button
              ref={(el) => iconRefs.set(def.id, el)}
              class={`activity-icon${isActive(def.id) ? " active" : ""}${dragState()?.id === def.id ? " icon-dragging-source" : ""}`}
              title={def.title}
              onClick={() => toggleToolWindow(def.id)}
              onContextMenu={(e) => iconContextMenu(e, def.id)}
              onPointerDown={(e) => handleDragStart(e, def.id)}
              innerHTML={iconFor(def.id, def.icon)}
            />
          )}
        </For>
      </div>

      {/* Spacer */}
      <div class="activity-spacer" />

      {/* Bottom-dock icons — no zone drag */}
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
