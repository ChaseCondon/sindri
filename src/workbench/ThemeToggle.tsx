// Theme control bar — statusbar, temporary home until the Settings panel lands.
// TODO: move to Settings panel (ADR-0019, future milestone).
import { For, Show } from "solid-js";
import {
  uiThemeId,    setUiTheme,
  editorThemeId, setEditorTheme,
  linkEditorToUi, setLinkEditorToUiTheme,
  iconThemeId,  setIconTheme,
  uiPackId,     setUiPack,
  themeList, iconThemeList, uiPackList,
} from "../theme/registry";

export function ThemeBar() {
  return (
    <div class="theme-bar">

      {/* Colour — UI color theme + optional independent editor theme */}
      <span class="theme-bar-label">Colour</span>
      <select
        class="theme-bar-select"
        value={uiThemeId()}
        onChange={(e) => setUiTheme(e.currentTarget.value)}
      >
        <For each={themeList()}>
          {(t) => <option value={t.id}>{t.name}</option>}
        </For>
      </select>
      <button
        class={`theme-bar-btn theme-bar-link${linkEditorToUi() ? " active" : ""}`}
        onClick={() => setLinkEditorToUiTheme(!linkEditorToUi())}
        title={linkEditorToUi() ? "Editor follows colour theme — click to use a different editor theme" : "Editor theme is independent — click to link to colour theme"}
      >
        {linkEditorToUi() ? "= Editor" : "Editor…"}
      </button>
      <Show when={!linkEditorToUi()}>
        <select
          class="theme-bar-select"
          value={editorThemeId()}
          onChange={(e) => setEditorTheme(e.currentTarget.value)}
        >
          <For each={themeList()}>
            {(t) => <option value={t.id}>{t.name}</option>}
          </For>
        </select>
      </Show>

      <div class="theme-bar-divider" />

      {/* Icon — file / folder icon theme */}
      <span class="theme-bar-label">Icon</span>
      <select
        class="theme-bar-select"
        value={iconThemeId()}
        onChange={(e) => setIconTheme(e.currentTarget.value)}
      >
        <For each={iconThemeList()}>
          {(t) => <option value={t.id}>{t.name}</option>}
        </For>
      </select>

      <div class="theme-bar-divider" />

      {/* UI — activity bar / toolbar icon pack */}
      <span class="theme-bar-label">UI</span>
      <select
        class="theme-bar-select"
        value={uiPackId()}
        onChange={(e) => setUiPack(e.currentTarget.value)}
      >
        <For each={uiPackList()}>
          {(p) => <option value={p.id}>{p.name}</option>}
        </For>
      </select>

    </div>
  );
}
