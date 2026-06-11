import { For, createSignal, createMemo } from "solid-js";
import {
  groupStore,
  activateBufferInGroup,
  closeBufferInGroup,
  closePaneGroup,
  splitGroup,
  moveBufferToGroup,
  reorderBufferInGroup,
  startDragGhost,
  updateDragGhostPos,
  endDrag,
  setDragState,
  dragState,
  dragGrabOffsetX,
  dragTabWidth,
  type GroupId,
} from "./groups";
import { registry } from "./buffers";
import { openMenu } from "../workbench/ContextMenu";

interface Props {
  groupId: GroupId;
}

// ---------------------------------------------------------------------------
// Stable object cache so SolidJS For reuses DOM nodes during drags
// (avoids restarting CSS transitions when renderItems updates).
// ---------------------------------------------------------------------------
const _tabItemCache = new Map<string, { kind: "tab"; bufferId: string }>();
const _placeholder = { kind: "placeholder" as const };

function tabItem(id: string) {
  let item = _tabItemCache.get(id);
  if (!item) { item = { kind: "tab" as const, bufferId: id }; _tabItemCache.set(id, item); }
  return item;
}

export function TabBar(props: Props) {
  let tabBarRef!: HTMLDivElement;

  const group = () => groupStore.groups[props.groupId];
  const bufferIds = () => group()?.bufferIds ?? [];
  const activeId = () => group()?.activeBufferId ?? "";
  const anyDrag = () => dragState() !== null;
  const isSameGroupDrag = () => dragState()?.fromGroupId === props.groupId;
  const isExternalDrag = () => anyDrag() && !isSameGroupDrag();

  // Reactive insertion index — drives the placeholder in renderItems.
  // Only updates when the pointer crosses a tab midpoint (not every pixel).
  const [reorderInsert, setReorderInsert] = createSignal<number | null>(null);
  let lastInsertIdx = -2;

  // ---------------------------------------------------------------------------
  // Rendered list: tabs + optional placeholder at the current insertion index.
  // Source group: dragged tab is removed from normal positions and appended at
  // the end with .tab-dragging (collapses via CSS), keeping DOM identity for
  // SolidJS to reuse the element and fire exit-transition correctly.
  // ---------------------------------------------------------------------------
  const renderItems = createMemo(() => {
    const drag = dragState();
    const ids = bufferIds();
    const insertIdx = reorderInsert();

    if (!drag || insertIdx === null) return ids.map(tabItem);

    const isSource = drag.fromGroupId === props.groupId;
    const baseIds = isSource ? ids.filter((id) => id !== drag.bufferId) : ids;
    const idx = Math.min(insertIdx, baseIds.length);

    const result: ({ kind: "tab"; bufferId: string } | { kind: "placeholder" })[] = [];
    for (let i = 0; i <= baseIds.length; i++) {
      if (i === idx) result.push(_placeholder);
      if (i < baseIds.length) result.push(tabItem(baseIds[i]));
    }
    // Append collapsed dragged tab at the end so it can animate out via CSS.
    if (isSource) result.push(tabItem(drag.bufferId));
    return result;
  });

  // ---------------------------------------------------------------------------
  // Compute insertion index from live tab rects (excludes collapsed dragged tab)
  // ---------------------------------------------------------------------------
  function computeInsertIndex(clientX: number): number {
    const tabs = Array.from(
      tabBarRef.querySelectorAll<HTMLElement>(".editor-tab:not(.tab-dragging)"),
    );
    for (let i = 0; i < tabs.length; i++) {
      const rect = tabs[i].getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) return i;
    }
    return tabs.length;
  }

  // ---------------------------------------------------------------------------
  // Pointer handlers on the tab bar container
  // ---------------------------------------------------------------------------

  function handleBarPointerMove(e: PointerEvent) {
    const drag = dragState();
    if (!drag) return;
    // Snap ghost Y to this tab bar; update X via the global grab offset
    updateDragGhostPos(e.clientX - dragGrabOffsetX, tabBarRef.getBoundingClientRect().top);
    // Only update the signal when the insertion position actually changes
    const idx = computeInsertIndex(e.clientX);
    if (idx !== lastInsertIdx) {
      lastInsertIdx = idx;
      setReorderInsert(idx);
    }
  }

  function handleBarPointerLeave() {
    lastInsertIdx = -2;
    setReorderInsert(null);
  }

  function handleBarPointerUp(_e: PointerEvent) {
    const drag = dragState();
    if (!drag) return;
    const ri = reorderInsert();
    setReorderInsert(null);
    lastInsertIdx = -2;
    if (drag.fromGroupId === props.groupId) {
      endDrag();
      if (ri !== null) reorderBufferInGroup(drag.bufferId, props.groupId, ri);
    } else {
      endDrag();
      moveBufferToGroup(drag.bufferId, drag.fromGroupId, props.groupId);
    }
  }

  // ---------------------------------------------------------------------------
  // Drag initiation — ghost created before setDragState so dragTabWidth is set
  // by the time renderItems recomputes.
  // ---------------------------------------------------------------------------
  function handlePointerDown(e: PointerEvent, bufferId: string) {
    if (e.button !== 0) return;
    const tabEl = e.currentTarget as HTMLElement;
    const tabRect = tabEl.getBoundingClientRect();
    const grabOffsetX = e.clientX - tabRect.left;
    const startX = e.clientX;
    const startY = e.clientY;
    const THRESHOLD = 6;
    let dragging = false;

    function onMove(ev: PointerEvent) {
      if (
        !dragging &&
        (Math.abs(ev.clientX - startX) > THRESHOLD || Math.abs(ev.clientY - startY) > THRESHOLD)
      ) {
        dragging = true;
        const buf = registry.buffers[bufferId];
        // Ghost must be created BEFORE setDragState so dragTabWidth is ready for renderItems
        startDragGhost(
          buf?.name ?? "?",
          buf?.dirty ?? false,
          tabRect.width,
          ev.clientX - grabOffsetX,
          tabBarRef.getBoundingClientRect().top,
          grabOffsetX,
        );
        setDragState({ bufferId, fromGroupId: props.groupId });
      }
      if (dragging) updateDragGhostPos(ev.clientX - grabOffsetX);
    }

    function onUp() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      setReorderInsert(null);
      lastInsertIdx = -2;
      if (dragging && dragState()) endDrag(); // cancelled — no drop zone caught it
    }

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  // ---------------------------------------------------------------------------
  // Context menu
  // ---------------------------------------------------------------------------
  function handleContextMenu(e: MouseEvent, bufferId: string) {
    e.preventDefault();
    const ids = bufferIds();
    const idx = ids.indexOf(bufferId);
    const leftTabs = ids.slice(0, idx);
    const rightTabs = ids.slice(idx + 1);
    const canSplit = ids.length >= 2;

    const items: { label: string; action: () => void; danger?: boolean }[] = [
      { label: "Close", action: () => closeBufferInGroup(bufferId, props.groupId) },
    ];
    if (leftTabs.length > 0)
      items.push({ label: "Close Left", action: () => { for (const id of leftTabs) closeBufferInGroup(id, props.groupId); } });
    if (rightTabs.length > 0)
      items.push({ label: "Close Right", action: () => { for (const id of rightTabs) closeBufferInGroup(id, props.groupId); } });
    if (ids.length > 1)
      items.push({ label: "Close Others", action: () => { for (const id of ids.filter((id) => id !== bufferId)) closeBufferInGroup(id, props.groupId); } });
    items.push({ label: "Close All", action: () => closePaneGroup(props.groupId), danger: true });
    if (canSplit) {
      items.push(
        { label: "Split Right", action: () => { activateBufferInGroup(bufferId, props.groupId); splitGroup(props.groupId, "row"); } },
        { label: "Split Down",  action: () => { activateBufferInGroup(bufferId, props.groupId); splitGroup(props.groupId, "column"); } },
      );
    }
    openMenu(e.clientX, e.clientY, items);
  }

  return (
    <div
      ref={tabBarRef}
      class={`editor-tabs${anyDrag() ? " editor-tabs--reordering" : ""}${isExternalDrag() ? " editor-tabs-merge-target" : ""}`}
      onPointerMove={handleBarPointerMove}
      onPointerLeave={handleBarPointerLeave}
      onPointerUp={handleBarPointerUp}
    >
      <For each={renderItems()}>
        {(item) => {
          if (item.kind === "placeholder") {
            return <div class="tab-placeholder" style={{ width: `${dragTabWidth}px` }} />;
          }
          const { bufferId } = item;
          const buf = () => registry.buffers[bufferId];
          const isDraggingThis = () => isSameGroupDrag() && dragState()?.bufferId === bufferId;
          return (
            <div
              class={`editor-tab${bufferId === activeId() ? " active" : ""}${isDraggingThis() ? " tab-dragging" : ""}`}
              onClick={() => activateBufferInGroup(bufferId, props.groupId)}
              onContextMenu={(e) => handleContextMenu(e, bufferId)}
              onPointerDown={(e) => handlePointerDown(e, bufferId)}
            >
              <span class="editor-tab-name">
                {buf()?.name}
                {buf()?.dirty ? <span class="editor-tab-dirty">•</span> : null}
              </span>
              <button
                class="editor-tab-close"
                title="Close"
                onClick={(e) => { e.stopPropagation(); closeBufferInGroup(bufferId, props.groupId); }}
              >
                ×
              </button>
            </div>
          );
        }}
      </For>
    </div>
  );
}
