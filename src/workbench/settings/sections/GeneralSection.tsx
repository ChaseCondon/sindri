import { For } from "solid-js";
import { activeLocale, setLocale, installedIds } from "../store";
import { SettingsGroup, SettingsRow } from "./primitives";

export function GeneralSection() {
  const localeOptions = () => {
    void installedIds();
    const opts: { id: string; name: string }[] = [
      { id: "sindri.en-us", name: "English (United States)" },
    ];
    return opts;
  };

  return (
    <div class="settings-section">
      <h2 class="settings-section-title">General</h2>
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
