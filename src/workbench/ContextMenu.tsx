import { Show, For } from "solid-js";
import { createStore } from "solid-js/store";

export interface MenuItem {
  label: string;
  action: () => void;
  danger?: boolean;
}

interface MenuState {
  visible: boolean;
  x: number;
  y: number;
  items: MenuItem[];
}

const [menuState, setMenuState] = createStore<MenuState>({
  visible: false,
  x: 0,
  y: 0,
  items: [],
});

export function openMenu(x: number, y: number, items: MenuItem[]): void {
  // Clamp so the menu never overflows the viewport.
  // min-width: 160px; items are ~30px each; header + padding ~8px.
  const menuW = 200;
  const menuH = items.length * 30 + 8;
  const cx = Math.max(4, Math.min(x, window.innerWidth  - menuW - 4));
  const cy = Math.max(4, Math.min(y, window.innerHeight - menuH - 4));
  setMenuState({ visible: true, x: cx, y: cy, items });
}

export function closeMenu(): void {
  setMenuState("visible", false);
}

export function ContextMenu() {
  return (
    <Show when={menuState.visible}>
      <div class="context-menu-backdrop" onClick={closeMenu} onContextMenu={(e) => { e.preventDefault(); closeMenu(); }} />
      <div
        class="context-menu"
        style={{ left: `${menuState.x}px`, top: `${menuState.y}px` }}
      >
        <For each={menuState.items}>
          {(item) => (
            <button
              class={`context-menu-item${item.danger ? " context-menu-item-danger" : ""}`}
              onClick={() => { item.action(); closeMenu(); }}
            >
              {item.label}
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}
