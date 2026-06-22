import { liveThemePreview, setLiveThemePreview } from "../store";
import { SettingsGroup, SettingsRow } from "./primitives";

export function ExtensionPrefsSection() {
  return (
    <div class="settings-section">
      <h2 class="settings-section-title">Marketplace Preferences</h2>
      <SettingsGroup title="Previewing">
        <SettingsRow
          label="Live theme preview"
          description="When browsing the marketplace, selecting a colour theme previews it live in this settings window — without installing it."
        >
          <label class="settings-checkbox-label">
            <input
              type="checkbox"
              class="settings-checkbox"
              checked={liveThemePreview()}
              onChange={(e) => setLiveThemePreview(e.currentTarget.checked)}
            />
            Preview colour themes on selection
          </label>
        </SettingsRow>
      </SettingsGroup>
    </div>
  );
}
