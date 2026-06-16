import { createStore, produce } from "solid-js/store";

export interface StatusBarItem {
  id: string;
  text: string;
  tooltip: string;
  visible: boolean;
  /** If set, clicking this item toggles the named tool window as a popup panel. */
  popupPanelId?: string;
}

const [statusBarItems, setStatusBarItems] = createStore<Record<string, StatusBarItem>>({});
export { statusBarItems };

export function registerStatusBarItem(id: string, text: string, tooltip: string, popupPanelId?: string): void {
  setStatusBarItems(produce((s) => {
    s[id] = { id, text, tooltip, visible: false, popupPanelId };
  }));
}

export function updateStatusBarItem(id: string, patch: Partial<Omit<StatusBarItem, "id">>): void {
  if (!statusBarItems[id]) return;
  setStatusBarItems(produce((s) => {
    if (s[id]) Object.assign(s[id], patch);
  }));
}

export function removeStatusBarItem(id: string): void {
  setStatusBarItems(produce((s) => { delete s[id]; }));
}
