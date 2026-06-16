// Popup dock surface — fixed-position overlay above the status bar.
// Renders panels that have defaultDock: "popup". Triggered by clicking the associated
// status bar item; closes on outside click or Escape.
import { For, Show, onCleanup, onMount } from "solid-js";
import { layout, isDockOpen, windowsForDock, closeToolWindow } from "./layout";

export function PopupPanel() {
  const popupOpen = () => isDockOpen("popup");

  // Close on Escape or outside click.
  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape" && popupOpen()) {
      for (const def of windowsForDock("popup")) {
        if (layout.windows[def.id]?.open) closeToolWindow(def.id);
      }
    }
  }

  onMount(() => {
    document.addEventListener("keydown", handleKeyDown);
    onCleanup(() => document.removeEventListener("keydown", handleKeyDown));
  });

  return (
    <Show when={popupOpen()}>
      {/* Backdrop: transparent click-away area */}
      <div
        class="popup-backdrop"
        onClick={() => {
          for (const def of windowsForDock("popup")) {
            if (layout.windows[def.id]?.open) closeToolWindow(def.id);
          }
        }}
      />
      {/* Panel content */}
      <For each={windowsForDock("popup").filter((d) => layout.windows[d.id]?.open)}>
        {(def) => (
          <div class="popup-panel">
            <div class="popup-panel-header">
              <span class="popup-panel-title">{def.title}</span>
              <button
                class="popup-panel-close"
                onClick={() => closeToolWindow(def.id)}
                title="Close"
              >✕</button>
            </div>
            <div class="popup-panel-body">
              <def.render />
            </div>
          </div>
        )}
      </For>
    </Show>
  );
}
