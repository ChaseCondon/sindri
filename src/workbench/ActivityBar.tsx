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

// ---------------------------------------------------------------------------
// Stable item cache — SolidJS For reuses DOM nodes only when object refs are
// identical across memo recomputations. This is what enables CSS transitions.
// ---------------------------------------------------------------------------
type ListItem =
  | { kind: "icon"; id: string }
  | { kind: "placeholder" }
  | { kind: "spacer" };

const _iconCache = new Map<string, { kind: "icon"; id: string }>();
const _placeholder: ListItem = { kind: "placeholder" };
const _spacer: ListItem = { kind: "spacer" };

function iconItem(id: string): { kind: "icon"; id: string } {
  let item = _iconCache.get(id);
  if (!item) { item = { kind: "icon" as const, id }; _iconCache.set(id, item); }
  return item;
}

interface Props {
  side: "left" | "right";
}

interface DropState {
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

    // Group panels by their current location
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
          // Hidden panels: clicking shows a sub-menu asking where to move them
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
          // Visible panels: clicking hides them
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
  const [draggingId, setDraggingId] = createSignal<string | null>(null);
  const [drop, setDrop] = createSignal<DropState | null>(null);

  let barRef!: HTMLDivElement;
  let ghostEl: HTMLButtonElement | null = null;
  const iconRefs = new Map<string, HTMLButtonElement>();

  // ---------------------------------------------------------------------------
  // Reactive render lists — include a placeholder slot at the drop position.
  // Items have stable object refs so SolidJS For can reuse DOM nodes and CSS
  // transitions on .icon-dragging / .activity-placeholder fire correctly.
  // ---------------------------------------------------------------------------
  function buildList(tools: ToolWindowDef[], targetDock: DockId): ListItem[] {
    const dId = draggingId();
    const d = drop();

    if (!dId) return tools.map((t) => iconItem(t.id));

    const sourceInThisZone = !!tools.find((t) => t.id === dId);
    const inThisZone = d?.dock === targetDock || (d?.isNewZone && targetDock === bottomDock());

    if (!inThisZone) {
      if (sourceInThisZone) {
        // Source zone but not drop target — replace the dragged icon with a same-size
        // spacer so the zone height doesn't change and the divider doesn't shift.
        return tools.map((t) => (t.id === dId ? _spacer : iconItem(t.id)));
      }
      return tools.map((t) => iconItem(t.id));
    }

    // Drop target zone — insert placeholder at the computed position, no source icon.
    const base = tools.filter((t) => t.id !== dId).map((t) => t.id);
    const insertIdx = d!.afterId !== null ? base.indexOf(d!.afterId) + 1 : 0;
    const result: ListItem[] = [];
    for (let i = 0; i <= base.length; i++) {
      if (i === Math.max(0, insertIdx)) result.push(_placeholder);
      if (i < base.length) result.push(iconItem(base[i]));
    }
    return result;
  }

  const renderTopItems = createMemo(() => buildList(topTools(), topDock()));

  const renderBtmItems = createMemo(() => {
    const d = drop();
    const tools = sideBottomTools();
    // Show the bottom section if it has real items OR if drag is targeting it / creating it
    if (tools.length === 0 && (!d || (!d.isNewZone && d.dock !== bottomDock()))) return null;
    return buildList(tools, bottomDock());
  });

  // ── Drop position computation ───────────────────────────────────
  function computeDrop(clientY: number): DropState | null {
    const dId = draggingId();
    if (!dId) return null;

    const topList = topTools().filter((t) => t.id !== dId);
    const btmList = sideBottomTools().filter((t) => t.id !== dId);

    function mid(id: string): number | null {
      const r = iconRefs.get(id)?.getBoundingClientRect();
      return r ? r.top + r.height / 2 : null;
    }

    // ── Check bottom sidebar zone first ──
    if (btmList.length > 0) {
      const firstMid = mid(btmList[0].id);
      if (firstMid !== null && clientY >= firstMid - 20) {
        let afterId: string | null = null;
        for (let i = btmList.length - 1; i >= 0; i--) {
          const m = mid(btmList[i].id);
          if (m !== null && clientY >= m) { afterId = btmList[i].id; break; }
        }
        return { dock: bottomDock(), afterId, isNewZone: false };
      }
    }

    // ── Top zone ──
    // If topList is empty (only the dragged icon was in the top zone), check whether
    // the pointer is below the dragged icon itself so we can still create a new bottom zone.
    if (topList.length === 0) {
      if (btmList.length === 0) {
        // Only icon in the whole bar — check if below its midpoint to create a bottom zone.
        const draggedEl = iconRefs.get(dId)?.getBoundingClientRect();
        if (draggedEl && clientY > draggedEl.bottom + 4) {
          return { dock: bottomDock(), afterId: null, isNewZone: true };
        }
      }
      return { dock: topDock(), afterId: null, isNewZone: false };
    }

    const lastId = topList[topList.length - 1].id;
    const lastEl = iconRefs.get(lastId)?.getBoundingClientRect();

    if (lastEl && clientY > lastEl.bottom + 4 && btmList.length === 0) {
      return { dock: bottomDock(), afterId: null, isNewZone: true };
    }

    let afterId: string | null = null;
    for (let i = topList.length - 1; i >= 0; i--) {
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

    function onMove(ev: PointerEvent) {
      if (!dragging && Math.abs(ev.clientY - startY) > 5) {
        dragging = true;
        setDraggingId(id);
        // Create ghost
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
      if (dragging && ghostEl) {
        ghostEl.style.top = `${ev.clientY - parseFloat(ghostEl.style.height) / 2}px`;
        setDrop(computeDrop(ev.clientY));
      }
    }

    function onUp() {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      if (ghostEl) { ghostEl.remove(); ghostEl = null; }

      if (dragging) {
        const d = drop();
        if (d) {
          reorderToolWindow(id, d.dock, d.afterId);
          if (d.isNewZone) {
            const railH = barRef.parentElement?.clientHeight ?? 400;
            setDockSize(bottomDock(), Math.round(railH / 2));
          }
        }
      }
      setDraggingId(null);
      setDrop(null);
    }

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  }

  return (
    <div class={`activity-bar activity-bar-${props.side}`} ref={barRef} onContextMenu={barContextMenu}>
      {/* Top sidebar zone */}
      <div class="activity-section">
        <For each={renderTopItems()}>
          {(item) =>
            item.kind === "placeholder"
              ? <div class="activity-placeholder" />
              : item.kind === "spacer"
              ? <div class="activity-spacer-slot" />
              : (
                <button
                  ref={(el) => iconRefs.set(item.id, el)}
                  class={`activity-icon${isActive(item.id) ? " active" : ""}`}
                  title={layout.registry[item.id]?.title ?? ""}
                  onClick={() => toggleToolWindow(item.id)}
                  onContextMenu={(e) => iconContextMenu(e, item.id)}
                  onPointerDown={(e) => handleDragStart(e, item.id)}
                  innerHTML={iconFor(item.id, layout.registry[item.id]?.icon ?? "")}
                />
              )
          }
        </For>
      </div>

      {/* Bottom sidebar zone — with divider; also renders during drag-to-create */}
      <Show when={renderBtmItems() !== null}>
        <div class="activity-divider" />
        <div class="activity-section">
          <For each={renderBtmItems()!}>
            {(item) =>
              item.kind === "placeholder"
                ? <div class="activity-placeholder" />
                : item.kind === "spacer"
                ? <div class="activity-spacer-slot" />
                : (
                  <button
                    ref={(el) => iconRefs.set(item.id, el)}
                    class={`activity-icon${isActive(item.id) ? " active" : ""}`}
                    title={layout.registry[item.id]?.title ?? ""}
                    onClick={() => toggleToolWindow(item.id)}
                    onContextMenu={(e) => iconContextMenu(e, item.id)}
                    onPointerDown={(e) => handleDragStart(e, item.id)}
                    innerHTML={iconFor(item.id, layout.registry[item.id]?.icon ?? "")}
                  />
                )
            }
          </For>
        </div>
      </Show>

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
