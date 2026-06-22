import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { layout } from "./layout";

// Keep-alive panel bodies.
//
// Each tool-window body is rendered ONCE into its own persistent root and
// re-parented between docks when the panel is moved — moving a DOM node does not
// unmount its Solid component, so panel state (live terminals, scroll position,
// in-progress input) survives a drag between zones instead of restarting.
//
// Safe because no panel uses Solid Context (all shared state is module-level
// stores/signals), so an independent root loses nothing the app tree provided.
// Hosts persist while hidden (matching VSCode: a closed terminal keeps running)
// and are disposed only when the tool window is unregistered.

interface Host {
  el: HTMLElement;
  dispose: () => void;
}

const hosts = new Map<string, Host>();

export function getPanelHost(id: string): HTMLElement | null {
  const def = layout.registry[id];
  if (!def) return null;

  let h = hosts.get(id);
  if (!h) {
    const el = document.createElement("div");
    el.className = "panel-host";
    const dispose = render(() => createComponent(def.render, {}), el);
    h = { el, dispose };
    hosts.set(id, h);
  }
  return h.el;
}

export function disposePanelHost(id: string): void {
  const h = hosts.get(id);
  if (!h) return;
  h.dispose();
  h.el.remove();
  hosts.delete(id);
}
