import { createSignal, For, Show } from "solid-js";
import {
  uiThemeId, setUiTheme,
  editorThemeId, setEditorTheme,
  linkEditorToUi, setLinkEditorToUiTheme,
  iconThemeId, setIconTheme,
  uiPackId, setUiPack,
  themeList, iconThemeList, uiPackList,
  getThemeDef,
} from "../../../theme/registry";
import { checkThemeCoverage, COVERAGE_TOTAL } from "../../../theme/coverage";
import { registryRepos, installedExtensions } from "../store";
import { SettingsGroup, SettingsRow } from "./primitives";

function ThemeCoveragePanel() {
  const devRepo = () => registryRepos().find(r => r.developerMode);
  const coverage = () => {
    const def = getThemeDef(uiThemeId());
    return def ? checkThemeCoverage(def) : null;
  };

  return (
    <Show when={devRepo()}>
      <div class="settings-coverage">
        <div class="settings-coverage-header">
          <span class="settings-coverage-title">Theme Coverage <span class="settings-devmode-tag">dev</span></span>
          <Show when={coverage()}>
            {(cov) => (
              <span class={`settings-coverage-badge ${cov().covered === COVERAGE_TOTAL ? "settings-coverage-full" : "settings-coverage-partial"}`}>
                {cov().covered}/{COVERAGE_TOTAL}
              </span>
            )}
          </Show>
        </div>
        <Show when={coverage()}>
          {(cov) => (
            <>
              <div class="settings-coverage-bar">
                <div class="settings-coverage-fill" style={{ width: `${(cov().covered / COVERAGE_TOTAL) * 100}%` }} />
              </div>
              <Show when={cov().missing.length > 0}>
                <div class="settings-coverage-missing-label">Missing extended tokens:</div>
                <div class="settings-coverage-missing">
                  <For each={cov().missing}>{(t) => <code class="settings-coverage-token">{t}</code>}</For>
                </div>
              </Show>
              <Show when={cov().missing.length === 0}>
                <p class="settings-coverage-ok">Full coverage — all 35 extended tokens defined.</p>
              </Show>
            </>
          )}
        </Show>
      </div>
    </Show>
  );
}

export function AppearanceSection() {
  const [activeSetId, setActiveSetId] = createSignal<string>("__custom__");

  const themeSets = () => {
    const all = installedExtensions();
    return all.filter((r) => {
      if (!r.manifest.extensionPack?.length) return false;
      return r.manifest.extensionPack.some((memberId) => {
        const m = all.find((ir) => ir.id === memberId)?.manifest;
        return m && (m.contributes?.themes?.length || m.contributes?.iconThemes?.length || m.contributes?.uiIconPacks?.length);
      });
    });
  };

  function applyThemeSet(packId: string) {
    setActiveSetId(packId);
    if (packId === "__custom__") return;
    const all = installedExtensions();
    const pack = all.find((r) => r.id === packId);
    for (const memberId of pack?.manifest.extensionPack ?? []) {
      const m = all.find((r) => r.id === memberId)?.manifest;
      if (!m) continue;
      if (m.contributes?.themes?.[0])      setUiTheme(m.contributes.themes[0].id);
      if (m.contributes?.iconThemes?.[0])  setIconTheme(m.contributes.iconThemes[0].id);
      if (m.contributes?.uiIconPacks?.[0]) setUiPack(m.contributes.uiIconPacks[0].id);
    }
  }

  function onUiThemeChange(id: string) { setUiTheme(id); setActiveSetId("__custom__"); }
  function onEditorThemeChange(id: string) { setEditorTheme(id); setActiveSetId("__custom__"); }
  function onIconThemeChange(id: string) { setIconTheme(id); setActiveSetId("__custom__"); }
  function onUiPackChange(id: string) { setUiPack(id); setActiveSetId("__custom__"); }

  return (
    <div class="settings-section">
      <h2 class="settings-section-title">Themes & Icons</h2>

      <Show when={themeSets().length > 0}>
        <SettingsGroup title="Theme Set">
          <SettingsRow label="Theme set" description="Apply a complete set of colour theme, file icons, and UI icons at once. Changing any individual setting below resets this to Custom.">
            <select class="settings-select" value={activeSetId()} onChange={(e) => applyThemeSet(e.currentTarget.value)}>
              <option value="__custom__">Custom</option>
              <For each={themeSets()}>{(p) => <option value={p.id}>{p.manifest.name}</option>}</For>
            </select>
          </SettingsRow>
        </SettingsGroup>
      </Show>

      <SettingsGroup title="Colours">
        <SettingsRow label="Colour theme" description="The UI chrome colour palette.">
          <select class="settings-select" value={uiThemeId()} onChange={(e) => onUiThemeChange(e.currentTarget.value)}>
            <For each={themeList()}>{(t) => <option value={t.id}>{t.name}</option>}</For>
          </select>
        </SettingsRow>
        <SettingsRow label="Editor theme" description="Syntax and editor surface colours.">
          <div class="settings-editor-theme">
            <select
              class="settings-select"
              classList={{ "settings-select-disabled": linkEditorToUi() }}
              value={editorThemeId()}
              disabled={linkEditorToUi()}
              onChange={(e) => onEditorThemeChange(e.currentTarget.value)}
            >
              <For each={themeList()}>{(t) => <option value={t.id}>{t.name}</option>}</For>
            </select>
            <label class="settings-checkbox-label">
              <input
                type="checkbox"
                class="settings-checkbox"
                checked={!linkEditorToUi()}
                onChange={(e) => setLinkEditorToUiTheme(!e.currentTarget.checked)}
              />
              Use a different editor theme
            </label>
          </div>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Icons">
        <SettingsRow label="File icon theme" description="Icons shown in the file explorer.">
          <select class="settings-select" value={iconThemeId()} onChange={(e) => onIconThemeChange(e.currentTarget.value)}>
            <For each={iconThemeList()}>{(t) => <option value={t.id}>{t.name}</option>}</For>
          </select>
        </SettingsRow>
        <SettingsRow label="UI icon pack" description="Icons in the activity bar and toolbars.">
          <select class="settings-select" value={uiPackId()} onChange={(e) => onUiPackChange(e.currentTarget.value)}>
            <For each={uiPackList()}>{(p) => <option value={p.id}>{p.name}</option>}</For>
          </select>
        </SettingsRow>
      </SettingsGroup>

      <ThemeCoveragePanel />

    </div>
  );
}
