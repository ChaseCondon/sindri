import { For, Show, createSignal, createMemo } from "solid-js";
import {
  groupStore,
  setActiveGroup,
  moveBufferToGroup,
  splitGroupWithBuffer,
  setSplitSizes,
  dragState,
  endDrag,
  type GroupId,
  type SplitNode,
  type SplitSplitNode,
} from "./groups";
import { registry, occKey } from "./buffers";
import { TabBar } from "./TabBar";
import { EditorGroup } from "./EditorGroup";
import { WebviewEditorHost } from "./WebviewEditorHost";

export function EditorArea() {
  return <SplitNodeView node={groupStore.root} />;
}

// ---------------------------------------------------------------------------
// Recursive tree renderer
// ---------------------------------------------------------------------------

function SplitNodeView(props: { node: SplitNode }) {
  return (
    <>
      {props.node.kind === "leaf"
        ? <LeafView groupId={props.node.group} />
        : <SplitView node={props.node as SplitSplitNode} />}
    </>
  );
}

function SplitView(props: { node: SplitSplitNode }) {
  const isRow = () => props.node.dir === "row";

  function onResizerDown(e: PointerEvent, index: number) {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    document.body.classList.add("user-dragging");

    const startPos = isRow() ? e.clientX : e.clientY;
    const startSizes = [...props.node.sizes];
    const container = el.parentElement as HTMLElement;
    const containerSize = isRow() ? container.offsetWidth : container.offsetHeight;

    function onMove(ev: PointerEvent) {
      const delta = (isRow() ? ev.clientX : ev.clientY) - startPos;
      const deltaPct = (delta / containerSize) * 100;
      const total = startSizes[index - 1] + startSizes[index];
      const newSizes = [...startSizes];
      newSizes[index - 1] = Math.max(10, startSizes[index - 1] + deltaPct);
      newSizes[index] = Math.max(10, total - newSizes[index - 1]);
      setSplitSizes(props.node.id, newSizes);
    }

    function onUp() {
      document.body.classList.remove("user-dragging");
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
    }

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  }

  return (
    <div
      class={`editor-split editor-split-${props.node.dir}`}
      style={{ display: "flex", "flex-direction": isRow() ? "row" : "column", height: "100%", width: "100%" }}
    >
      <For each={props.node.children}>
        {(child, i) => (
          <>
            {i() > 0 && (
              <div
                class={`splitter splitter-${isRow() ? "col" : "row"}`}
                onPointerDown={(e) => onResizerDown(e, i())}
              />
            )}
            <div
              style={{
                flex: `${props.node.sizes[i()] ?? 50} 1 0%`,
                "min-width": "0",
                "min-height": "0",
                overflow: "hidden",
              }}
            >
              <SplitNodeView node={child} />
            </div>
          </>
        )}
      </For>
    </div>
  );
}

function WelcomeScreen() {
  return (
    <div class="welcome-screen">
      <div class="welcome-logo">sindri</div>
      <div class="welcome-hint">Open a file from the Explorer to begin</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Leaf view: tab bar + editor + drop overlay during external drag
// ---------------------------------------------------------------------------

type DropZone = "center" | "north" | "south" | "east" | "west";

function LeafView(props: { groupId: GroupId }) {
  const isActive = () => groupStore.activeGroup === props.groupId;
  const isOwnDrag = () => dragState()?.fromGroupId === props.groupId;
  // Show the overlay for ANY active drag (own-group = edge split; external = edge split OR center merge)
  const isDragging = () => dragState() !== null;
  const [hovered, setHovered] = createSignal<DropZone | null>(null);

  function commitDrop(zone: DropZone) {
    const drag = dragState();
    if (!drag) return;
    setHovered(null);
    endDrag(); // destroys ghost + clears dragState
    if (zone === "center") {
      // Center zone is only rendered for external drags; own-group center = unreachable
      moveBufferToGroup(drag.bufferId, drag.fromGroupId, props.groupId);
    } else {
      const dir: "row" | "column" = zone === "east" || zone === "west" ? "row" : "column";
      splitGroupWithBuffer(props.groupId, dir, drag.bufferId, drag.fromGroupId);
    }
  }

  function zoneProps(zone: DropZone) {
    return {
      class: `drop-zone drop-zone-${zone}`,
      onPointerEnter: () => setHovered(zone),
      onPointerLeave: () => setHovered(null),
      onPointerUp: () => commitDrop(zone),
    };
  }

  const group = () => groupStore.groups[props.groupId];
  const isEmpty = () => (group()?.bufferIds.length ?? 0) === 0;
  const activeBufferId = () => group()?.activeBufferId ?? "";
  const activeBuf = () => registry.buffers[activeBufferId()];
  const isActiveText = () => !activeBuf() || (activeBuf()?.viewType ?? "text") === "text";

  // Custom-editor buffers currently in this group — drives keep-alive iframe set.
  const customBufferIds = createMemo(() =>
    (group()?.bufferIds ?? []).filter(
      (id) => (registry.buffers[id]?.viewType ?? "text") !== "text",
    ),
  );

  const editorBodyStyle = (visible: boolean) => ({
    display: visible ? "flex" : "none",
    flex: "1 1 0%",
    "min-height": "0",
    overflow: "hidden",
  });

  return (
    <div
      class={`editor-group${isActive() ? " editor-group-active" : ""}`}
      onClick={() => setActiveGroup(props.groupId)}
    >
      <Show when={!isEmpty()} fallback={<WelcomeScreen />}>
        <TabBar groupId={props.groupId} />
        {/* CM text editor — always mounted once, shown only when active buffer is text */}
        <div style={editorBodyStyle(isActiveText())}>
          <EditorGroup groupId={props.groupId} />
        </div>
        {/* Custom editor instances — one iframe per occurrence; kept alive, show/hide */}
        <For each={customBufferIds()}>
          {(bufferId) => {
            const buf = () => registry.buffers[bufferId];
            const isVisible = () => activeBufferId() === bufferId;
            return (
              <div style={editorBodyStyle(isVisible())}>
                <WebviewEditorHost
                  instanceId={occKey(props.groupId, bufferId)}
                  bufferId={bufferId}
                  viewType={buf()?.viewType ?? ""}
                />
              </div>
            );
          }}
        </For>
      </Show>

      {/* Drop overlay — sits below the tab bar (top: 35px) so tab bar handles its own events.
          Shown for all drags; center zone hidden for own-group (splitting to same group = move). */}
      <Show when={isDragging()}>
        <div class={`drop-overlay${isEmpty() ? " drop-overlay-full" : ""}`}>
          <div {...zoneProps("north")} />
          <div {...zoneProps("south")} />
          <div {...zoneProps("west")} />
          <div {...zoneProps("east")} />
          <Show when={!isOwnDrag()}>
            <div {...zoneProps("center")} />
          </Show>
          <div class="split-preview" data-zone={hovered() ?? ""} />
        </div>
      </Show>
    </div>
  );
}
