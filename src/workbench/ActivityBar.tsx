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

// "top" is a valid DockId but has no rendered bar — omitted to prevent stranding icons.
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

// The drag indicator: where the dropped icon will be inserted, plus a Y offset
// for the insertion-line rendering (relative to the activity-bar element top).
interface DragState {
  id: string;
  dock: DockId;
  afterId: string | null;
  isNewZone: boolean;
  lineY: number;
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
  // Approach: source icon dims in place; a thin horizontal insertion line
  // tracks the cursor without causing any layout shifts.
  const [dragState, setDragState] = createSignal<DragState | null>(null);

  let barRef!: HTMLDivElement;
  let dividerRef!: HTMLDivElement;
  let ghostEl: HTMLButtonElement | null = null;
  const iconRefs = new Map<string, HTMLButtonElement>();

  // ── Drop position computation ───────────────────────────────────
  // Returns the target dock/position plus a lineY (px from bar top) for the
  // visual insertion indicator. Does NOT modify the render list.
  function computeDragState(clientY: number, dId: string): DragState | null {
    const topList = topTools().filter(t => t.id !== dId);
    const btmList = sideBottomTools().filter(t => t.id !== dId);

    const barRect = barRef.getBoundingClientRect();
    const dividerRect = dividerRef?.getBoundingClientRect();
    const inBottomZone = dividerRect ? clientY >= dividerRect.bottom - 4 : false;

    function iRect(id: string) { return iconRefs.get(id)?.getBoundingClientRect(); }

    if (inBottomZone) {
      let afterId: string | null = null;
      let lineY: number;

      if (btmList.length === 0) {
        // Empty bottom zone — line appears just below the divider.
        lineY = (dividerRect!.bottom - barRect.top) + 6;
      } else {
        // Default: before the first bottom icon.
        lineY = (iRect(btmList[0].id)?.top ?? dividerRect!.bottom) - barRect.top - 2;
        for (let i = btmList.length - 1; i >= 0; i--) {
          const r = iRect(btmList[i].id);
          if (r && clientY >= r.top + r.height / 2) {
            afterId = btmList[i].id;
            lineY = r.bottom - barRect.top + 2;
            break;
          }
        }
      }

      return { id: dId, dock: bottomDock(), afterId, isNewZone: btmList.length === 0, lineY };
    }

    // Top zone — everything above the divider.
    let afterId: string | null = null;
    let lineY = 2;

    if (topList.length > 0) {
      lineY = (iRect(topList[0].id)?.top ?? barRect.top) - barRect.top - 2;
      for (let i = topList.length - 1; i >= 0; i--) {
        const r = iRect(topList[i].id);
        if (r && clientY >= r.top + r.height / 2) {
          afterId = topList[i].id;
          lineY = r.bottom - barRect.top + 2;
          break;
        }
      }
    }

    return { id: dId, dock: topDock(), afterId, isNewZone: false, lineY };
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
      cleanup();
      if (dragging && ds) {
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

      {/* Insertion-line indicator — absolutely positioned within this bar */}
      <Show when={dragState()}>
        <div class="activity-drop-line" style={{ top: `${dragState()!.lineY}px` }} />
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

      {/* Bottom sidebar zone — always rendered so the divider stays stable */}
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
