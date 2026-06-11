import { createSignal, createMemo, For, Show, onMount, onCleanup } from "solid-js";
import { quickPickSession, closeQuickPick, type QuickPickItem } from "./store";
import { deliverQuickPickResult, dispatch } from "../extensions/host";

function filterItems(items: QuickPickItem[], query: string): QuickPickItem[] {
  if (!query) return items;
  const q = query.toLowerCase();
  return items.filter(
    (item) =>
      item.label.toLowerCase().includes(q) ||
      (item.description?.toLowerCase().includes(q) ?? false),
  );
}

export function QuickPickOverlay() {
  return (
    <Show when={quickPickSession.active !== null}>
      <QuickPickPalette />
    </Show>
  );
}

function QuickPickPalette() {
  const [query, setQuery] = createSignal("");
  const [activeIndex, setActiveIndex] = createSignal(0);
  let inputRef!: HTMLInputElement;

  const session = () => quickPickSession.active!;
  const filtered = createMemo(() => {
    setActiveIndex(0);
    return filterItems(session().items, query());
  });

  onMount(() => { inputRef?.focus(); });

  function accept(item: QuickPickItem) {
    const { requestId, streaming } = session();
    closeQuickPick(requestId);
    if (streaming) {
      void dispatch("__sindri.ui.quickPickResult:" + requestId,
        JSON.stringify({ type: "accept", items: [item] }));
    } else {
      void deliverQuickPickResult(requestId, JSON.stringify(item));
    }
  }

  function cancel() {
    const { requestId, streaming } = session();
    closeQuickPick(requestId);
    if (streaming) {
      void dispatch("__sindri.ui.quickPickResult:" + requestId,
        JSON.stringify({ type: "hide" }));
    } else {
      void deliverQuickPickResult(requestId, null);
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    const items = filtered();
    if (e.key === "Escape") { e.preventDefault(); cancel(); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      const item = items[activeIndex()];
      if (item) accept(item);
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIndex((i) => Math.min(i + 1, items.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIndex((i) => Math.max(i - 1, 0)); }
  }

  function onGlobalKeyDown(e: KeyboardEvent) { if (e.key === "Escape") cancel(); }
  onMount(() => document.addEventListener("keydown", onGlobalKeyDown));
  onCleanup(() => document.removeEventListener("keydown", onGlobalKeyDown));

  function onInput(e: Event) {
    const value = (e.target as HTMLInputElement).value;
    setQuery(value);
    const { requestId, streaming } = session();
    if (streaming) {
      void dispatch("__sindri.ui.quickPickResult:" + requestId,
        JSON.stringify({ type: "valueChange", value }));
    }
  }

  return (
    <div class="qp-backdrop" onClick={cancel}>
      <div class="qp-palette" onClick={(e) => e.stopPropagation()}>
        <Show when={session().title}>
          <div class="qp-title">{session().title}</div>
        </Show>
        <input
          ref={inputRef}
          class="qp-input"
          type="text"
          placeholder={session().placeholder ?? "Select an item…"}
          value={query()}
          onInput={onInput}
          onKeyDown={onKeyDown}
        />
        <div class="qp-list">
          <Show when={filtered().length === 0}>
            <div class="qp-empty">No items match</div>
          </Show>
          <For each={filtered()}>
            {(item, idx) => (
              <div
                class={`qp-item${idx() === activeIndex() ? " qp-item-active" : ""}`}
                onMouseEnter={() => setActiveIndex(idx())}
                onClick={() => accept(item)}
              >
                <span class="qp-item-label">{item.label}</span>
                <Show when={item.description}>
                  <span class="qp-item-description">{item.description}</span>
                </Show>
                <Show when={item.detail}>
                  <div class="qp-item-detail">{item.detail}</div>
                </Show>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
