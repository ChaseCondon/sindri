import { For, Show } from "solid-js";
import { activeLocale, setLocale, installedIds } from "../store";
import { SettingsGroup, SettingsRow } from "./primitives";
import { get as getConfig, set as setConfig } from "../configStore";

export function GeneralSection() {
  const localeOptions = () => {
    void installedIds();
    const opts: { id: string; name: string }[] = [
      { id: "sindri.en-us", name: "English (United States)" },
    ];
    return opts;
  };

  const autoSave = () => !!getConfig("editor.autoSave");
  const autoSaveDelay = () => (getConfig("editor.autoSaveDelay") as number | undefined) ?? 1500;

  return (
    <div class="settings-section">
      <h2 class="settings-section-title">General</h2>

      <SettingsGroup title="Saving">
        <SettingsRow
          label="Auto save"
          description="Automatically save files after a short delay. When disabled, use ⌘S / Ctrl+S."
        >
          <label class="settings-toggle-row">
            <input
              type="checkbox"
              checked={autoSave()}
              onChange={(e) => setConfig("editor.autoSave", e.currentTarget.checked)}
            />
            <span>{autoSave() ? "Enabled" : "Disabled"}</span>
          </label>
        </SettingsRow>
        <Show when={autoSave()}>
          <SettingsRow
            label="Auto save delay"
            description="Milliseconds after the last keystroke before the file is saved."
          >
            <div class="settings-range-row">
              <input
                type="range"
                min="200"
                max="5000"
                step="100"
                value={autoSaveDelay()}
                onInput={(e) => setConfig("editor.autoSaveDelay", Number(e.currentTarget.value))}
              />
              <span class="settings-range-value">{autoSaveDelay()}ms</span>
            </div>
          </SettingsRow>
        </Show>
      </SettingsGroup>

      <SettingsGroup title="Localisation">
        <SettingsRow
          label="Language"
          description="Display language for the Sindri UI. Install localisation extensions from the Marketplace to add more options."
        >
          <select
            class="settings-select"
            value={activeLocale()}
            onChange={(e) => setLocale(e.currentTarget.value)}
          >
            <For each={localeOptions()}>{(o) => <option value={o.id}>{o.name}</option>}</For>
          </select>
        </SettingsRow>
      </SettingsGroup>
    </div>
  );
}
