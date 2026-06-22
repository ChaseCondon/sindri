import { Show, createEffect } from "solid-js";
import { Dynamic } from "solid-js/web";
import {
  layout,
  closeToolWindow,
  dockRail,
  dockZone,
  type DockId,
} from "./layout";
import { getPanelHost } from "./panelHost";
import { openMenu } from "./ContextMenu";
import { moveToolWindow } from "./layout";

// Mounts the active tool window's persistent, keep-alive body (panelHost) into
// this dock. Re-parents on id change rather than remounting, so panel state
// survives moves between docks.
function PanelBody(props: { id: string }) {
  let el!: HTMLDivElement;
  createEffect(() => {
    const host = getPanelHost(props.id);
    if (host) el.replaceChildren(host);
    else el.replaceChildren();
  });
  return <div class="panel-body" ref={el} />;
}

const ALL_DOCKS: DockId[] = [
  "left-top", "left-bottom",
  "right-top", "right-bottom",
  "bottom", "top",
];
const DOCK_LABELS: Partial<Record<DockId, string>> = {
  "left-top": "Left sidebar (top)",
  "left-bottom": "Left sidebar (bottom)",
  "right-top": "Right sidebar (top)",
  "right-bottom": "Right sidebar (bottom)",
  top: "Top bar",
  bottom: "Bottom dock",
};

interface Props {
  dock: DockId;
  /** When true the panel fills available height (bottom zone with no sibling top panel) */
  fill?: boolean;
}

export function DockBar(props: Props) {
  const activeId = () => layout.activeTabs[props.dock];
  const activeDef = () => layout.registry[activeId() ?? ""];

  const sizeStyle = () => {
    const sz = layout.dockSizes[props.dock];
    const rail = dockRail(props.dock);
    const zone = dockZone(props.dock);
    // Bottom zones inside a left/right rail: explicit height unless alone
    if ((rail === "left" || rail === "right") && zone === "bottom" && !props.fill) {
      return sz ? { height: `${sz}px` } : {};
    }
    // Bottom/top dock: explicit height
    if (rail === "bottom" || rail === "top") {
      return sz ? { height: `${sz}px` } : {};
    }
    return {};
  };

  return (
    <div
      class={`dock-panel dock-${props.dock} dock-zone-${dockZone(props.dock)}${props.fill ? " dock-fill" : ""}`}
      style={sizeStyle()}
    >
      <Show when={activeDef() && layout.windows[activeId() ?? ""]?.open}>
        <div class="panel-header">
          <span class="panel-title">{activeDef()!.title}</span>
          <Show when={activeDef()!.headerActions}>
            <Dynamic component={activeDef()!.headerActions} />
          </Show>
          <button
            class="panel-action-btn"
            title="Move panel"
            onClick={(e) => {
              const id = activeId()!;
              const currentDock = layout.windows[id]?.dock;
              openMenu(
                e.clientX, e.clientY,
                ALL_DOCKS.filter((d) => d !== currentDock).map((d) => ({
                  label: `Move to ${DOCK_LABELS[d]}`,
                  action: () => moveToolWindow(id, d),
                }))
              );
            }}
          >
            ⋯
          </button>
          <button
            class="panel-action-btn"
            title="Close"
            onClick={() => closeToolWindow(activeId()!)}
          >
            ✕
          </button>
        </div>
        <PanelBody id={activeId()!} />
      </Show>
    </div>
  );
}
