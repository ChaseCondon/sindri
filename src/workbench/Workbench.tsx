import { Show, createEffect, type JSX } from "solid-js";
import { layout, isDockOpen, setDockSize, hasWindowsForSide } from "./layout";
import { ActivityBar } from "./ActivityBar";
import { DockBar } from "./DockBar";
import { Splitter } from "./Splitter";
import { ContextMenu } from "./ContextMenu";

interface Props {
  children: JSX.Element;
}

export function Workbench(props: Props) {
  const leftTopOpen = () => isDockOpen("left-top");
  const leftBottomOpen = () => isDockOpen("left-bottom");
  const anyLeftOpen = () => leftTopOpen() || leftBottomOpen();

  const rightTopOpen = () => isDockOpen("right-top");
  const rightBottomOpen = () => isDockOpen("right-bottom");
  const anyRightOpen = () => rightTopOpen() || rightBottomOpen();

  const bottomOpen = () => isDockOpen("bottom");

  const leftRailWidth = () => layout.dockSizes["left-top"] ?? 240;
  const rightRailWidth = () => layout.dockSizes["right-top"] ?? 240;

  // Rail refs for 50%-split initialisation
  let leftRailRef: HTMLDivElement | undefined;
  let rightRailRef: HTMLDivElement | undefined;

  // When both zones first open together, default the bottom zone to 50% of the rail
  createEffect(() => {
    if (leftTopOpen() && leftBottomOpen() && !layout.dockSizes["left-bottom"]) {
      setDockSize("left-bottom", Math.round((leftRailRef?.clientHeight ?? 400) / 2));
    }
  });
  createEffect(() => {
    if (rightTopOpen() && rightBottomOpen() && !layout.dockSizes["right-bottom"]) {
      setDockSize("right-bottom", Math.round((rightRailRef?.clientHeight ?? 400) / 2));
    }
  });

  return (
    <div class="workbench-shell">
      {/* workbench-frame: activity bars span the full height including the bottom dock */}
      <div class="workbench-frame">
        <Show when={hasWindowsForSide("left")}>
          <ActivityBar side="left" />
        </Show>

        <div class="workbench-content">
          <div class="workbench-main">
            {/* Left panel rail */}
            <Show when={anyLeftOpen()}>
              <div class="dock-rail" ref={leftRailRef} style={{ width: `${leftRailWidth()}px` }}>
                <Show when={leftTopOpen()}>
                  <DockBar dock="left-top" />
                </Show>
                <Show when={leftTopOpen() && leftBottomOpen()}>
                  <Splitter dock="left-bottom" orientation="row" />
                </Show>
                <Show when={leftBottomOpen()}>
                  <DockBar dock="left-bottom" fill={!leftTopOpen()} />
                </Show>
              </div>
              <Splitter dock="left-top" orientation="col" />
            </Show>

            <div class="workbench-center">{props.children}</div>

            {/* Right panel rail */}
            <Show when={anyRightOpen()}>
              <Splitter dock="right-top" orientation="col" />
              <div class="dock-rail" ref={rightRailRef} style={{ width: `${rightRailWidth()}px` }}>
                <Show when={rightTopOpen()}>
                  <DockBar dock="right-top" />
                </Show>
                <Show when={rightTopOpen() && rightBottomOpen()}>
                  <Splitter dock="right-bottom" orientation="row" />
                </Show>
                <Show when={rightBottomOpen()}>
                  <DockBar dock="right-bottom" fill={!rightTopOpen()} />
                </Show>
              </div>
            </Show>
          </div>

          {/* Bottom dock */}
          <Show when={bottomOpen()}>
            <Splitter dock="bottom" orientation="row" />
            <DockBar dock="bottom" />
          </Show>
        </div>

        <Show when={hasWindowsForSide("right")}>
          <ActivityBar side="right" />
        </Show>
      </div>

      <ContextMenu />
    </div>
  );
}
