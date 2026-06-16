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
  type DockId,
  type ToolWindowDef,
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

// Stable sentinel used as the placeholder item in the render list.
const PLACEHOLDER_ID = "__activity-placeholder__";
const PLACEHOLDER_DEF = { id: PLACEHOLDER_ID } as ToolWindowDef;

interface Props {
  side: "left" | "right";
}

interface DropTarget {
  dock: DockId;
  afterId: string | null;
  isNewZone: boolean;
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
  // The source icon stays in its original position (dimmed).
  // A placeholder block — styled like tab-placeholder — is inserted into the
  // render list at the computed drop target, showing exactly where the icon lands.
  const [draggingId, setDraggingId] = createSignal<string | null>(null);
  const [dropTarget, setDropTarget] = createSignal<DropTarget | null>(null);

  let dividerRef!: HTMLDivElement;
  let ghostEl: HTMLButtonElement | null = null;
  const iconRefs = new Map<string, HTMLButtonElement>();

  // Build render list: source stays (will be dimmed), placeholder inserted at target.
  function buildList(tools: ToolWindowDef[], dock: DockId): ToolWindowDef[] {
    const dt = dropTarget();
    if (!dt || dt.dock !== dock) return tools;

    const result = [...tools];
    const afterIdx = dt.afterId !== null
      ? result.findIndex(t => t.id === dt.afterId)
      : -1;
    result.splice(afterIdx + 1, 0, PLACEHOLDER_DEF);
    return result;
  }

  const topRenderList = createMemo(() => buildList(topTools(), topDock()));
  const btmRenderList = createMemo(() => buildList(sideBottomTools(), bottomDock()));

  // ── Drop computation ────────────────────────────────────────────
  function computeDropTarget(clientY: number, dId: string): DropTarget | null {
    const topList = topTools();
    const btmList = sideBottomTools();

    const dividerRect = dividerRef?.getBoundingClientRect();
    const inBottomZone = dividerRect ? clientY >= dividerRect.bottom - 4 : false;

    function mid(id: string): number | null {
      const r = iconRefs.get(id)?.getBoundingClientRect();
      return r ? r.top + r.height / 2 : null;
    }

    if (inBottomZone) {
      let afterId: string | null = null;
      for (let i = btmList.length - 1; i >= 0; i--) {
        if (btmList[i].id === dId) continue;
        const m = mid(btmList[i].id);
        if (m !== null && clientY >= m) { afterId = btmList[i].id; break; }
      }
      return { dock: bottomDock(), afterId, isNewZone: btmList.length === 0 };
    }

    let afterId: string | null = null;
    for (let i = topList.length - 1; i >= 0; i--) {
      if (topList[i].id === dId) continue;
      const m = mid(topList[i].id);
      if (m !== null && clientY >= m) { afterId = topList[i].id; break; }
    }
    return { dock: topDock(), afterId, isNewZone: false };
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
      setDraggingId(null);
      setDropTarget(null);
    }

    function onMove(ev: PointerEvent) {
      if (!dragging && Math.abs(ev.clientY - startY) > 5) {
        dragging = true;
        setDraggingId(id);
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
        setDropTarget(computeDropTarget(ev.clientY, id));
      }
    }

    function onUp() {
      const dt = dropTarget();
      const wasActive = dragging;
      cleanup();
      if (wasActive && dt) {
        reorderToolWindow(id, dt.dock, dt.afterId);
        if (dt.isNewZone) {
          const srcEl = iconRefs.get(id);
          const railH = srcEl?.closest(".dock-rail")?.clientHeight ?? 400;
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
    <div class={`activity-bar activity-bar-${props.side}`} onContextMenu={barContextMenu}>

      {/* Top sidebar zone */}
      <div class="activity-section">
        <For each={topRenderList()}>
          {(def) =>
            def.id === PLACEHOLDER_ID
              ? <div class="activity-placeholder" />
              : (
                <button
                  ref={(el) => iconRefs.set(def.id, el)}
                  class={`activity-icon${isActive(def.id) ? " active" : ""}${draggingId() === def.id ? " icon-dragging-source" : ""}`}
                  title={def.title}
                  onClick={() => toggleToolWindow(def.id)}
                  onContextMenu={(e) => iconContextMenu(e, def.id)}
                  onPointerDown={(e) => handleDragStart(e, def.id)}
                  innerHTML={iconFor(def.id, def.icon)}
                />
              )
          }
        </For>
      </div>

      {/* Divider — always visible; marks the boundary between top and bottom zones */}
      <div class="activity-divider" ref={dividerRef} />

      {/* Bottom sidebar zone — always rendered so the divider stays stable */}
      <div class="activity-section">
        <For each={btmRenderList()}>
          {(def) =>
            def.id === PLACEHOLDER_ID
              ? <div class="activity-placeholder" />
              : (
                <button
                  ref={(el) => iconRefs.set(def.id, el)}
                  class={`activity-icon${isActive(def.id) ? " active" : ""}${draggingId() === def.id ? " icon-dragging-source" : ""}`}
                  title={def.title}
                  onClick={() => toggleToolWindow(def.id)}
                  onContextMenu={(e) => iconContextMenu(e, def.id)}
                  onPointerDown={(e) => handleDragStart(e, def.id)}
                  innerHTML={iconFor(def.id, def.icon)}
                />
              )
          }
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
