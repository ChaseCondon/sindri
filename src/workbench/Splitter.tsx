import { layout, setDockSize, dockRail, dockZone, type DockId } from "./layout";

interface Props {
  dock: DockId;
  /** "col" = vertical bar resizing left/right docks; "row" = horizontal bar resizing top/bottom */
  orientation: "col" | "row";
}

export function Splitter(props: Props) {
  function onPointerDown(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    document.body.classList.add("user-dragging");

    const startPos = props.orientation === "col" ? e.clientX : e.clientY;
    const startSize = layout.dockSizes[props.dock] ?? (props.orientation === "col" ? 240 : 200);

    // right/bottom/bottom-zone splitters: positive pointer delta shrinks the dock
    const sign = (dockRail(props.dock) === "right" || dockRail(props.dock) === "bottom" || dockZone(props.dock) === "bottom") ? -1 : 1;

    function onMove(ev: PointerEvent) {
      const delta = (props.orientation === "col" ? ev.clientX : ev.clientY) - startPos;
      const next = Math.max(120, Math.min(600, startSize + sign * delta));
      setDockSize(props.dock, next);
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
      class={`splitter splitter-${props.orientation}`}
      onPointerDown={onPointerDown}
    />
  );
}
