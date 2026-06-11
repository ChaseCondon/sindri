import { createStore, produce } from "solid-js/store";

export interface QuickPickItem {
  label: string;
  description?: string;
  detail?: string;
}

export interface QuickPickSession {
  requestId: string;
  items: QuickPickItem[];
  placeholder: string | null;
  title: string | null;
  /** true = createQuickPick (streaming events); false = showQuickPick (one-shot) */
  streaming: boolean;
}

const [quickPickSession, setQuickPickSession] = createStore<{ active: QuickPickSession | null }>({
  active: null,
});
export { quickPickSession };

export function openQuickPick(session: QuickPickSession): void {
  setQuickPickSession("active", session);
}

export function updateQuickPickItems(requestId: string, items: QuickPickItem[]): void {
  setQuickPickSession(produce((s) => {
    if (s.active?.requestId === requestId) s.active.items = items;
  }));
}

export function closeQuickPick(requestId: string): void {
  setQuickPickSession(produce((s) => {
    if (s.active?.requestId === requestId) s.active = null;
  }));
}
