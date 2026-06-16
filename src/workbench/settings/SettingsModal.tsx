// Settings modal overlay — ADR-0021
// Core shell: modal focus-traps, ESC closes. Nav has collapsible groups.
import { createSignal, For, Show, onMount, onCleanup, createEffect, createResource } from "solid-js";
import {
  uiThemeId, setUiTheme,
  editorThemeId, setEditorTheme,
  linkEditorToUi, setLinkEditorToUiTheme,
  iconThemeId, setIconTheme,
  uiPackId, setUiPack,
  themeList, iconThemeList, uiPackList,
  getThemeDef,
} from "../../theme/registry";
import { checkThemeCoverage, COVERAGE_TOTAL } from "../../theme/coverage";
import {
  registryRepos, addRepo, removeRepo, toggleRepoPrerelease, toggleRepoDeveloperMode,
  activeLocale, setLocale,
  installedIds, installedExtensions, installExtension, uninstallExtension, updateInstalledExtension,
  loadDevExtension, setLocalSinxtAlt, switchExtensionVariant, activeSinxtPath, activeManifest,
  liveThemePreview, setLiveThemePreview,
  previewThemeDef,
} from "./store";
import { activateExtensionFromSinxt, activateExtensionWithManifest } from "../../extensions/activation";
import { deregisterExtDecorations } from "../../editor/editor-state-bridge";
import { unregisterToolWindow } from "../../workbench/layout";
import type { ExtensionManifest } from "../../extensions/manifest";
import { isTauri } from "../../lib/tauri";
import { get as cfgGet, set as cfgSet, EDITOR_DECORATIONS_SCHEMA } from "./configStore";
import type { ConfigurationSchema, ConfigurationField } from "../../extensions/manifest";
import { MarketplaceSection } from "./MarketplaceSection";
import { getRegistryClient } from "../../extensions/registry-client";

export type SettingsSectionId =
  | "general"
  | "appearance"
  | "editor"
  | "extensions-active"
  | "extensions-repos"
  | "extensions-prefs"
  | "marketplace"
  | "language-packs";

interface NavSection { id: SettingsSectionId; label: string }
interface NavGroup { id: string; label: string; sections: NavSection[] }

const NAV_GROUPS: NavGroup[] = [
  {
    id: "general",
    label: "General",
    sections: [
      { id: "general", label: "General" },
    ],
  },
  {
    id: "appearance",
    label: "Appearance",
    sections: [
      { id: "appearance", label: "Themes & Icons" },
      { id: "editor", label: "Editor" },
    ],
  },
  {
    id: "languages",
    label: "Languages",
    sections: [
      { id: "language-packs", label: "Language Packs" },
    ],
  },
  {
    id: "extensions",
    label: "Extensions",
    sections: [
      { id: "extensions-active", label: "Install Extension" },
      { id: "extensions-repos",  label: "Repositories" },
      { id: "extensions-prefs",  label: "Marketplace Preferences" },
      { id: "marketplace",       label: "Marketplace" },
    ],
  },
];

interface Props { onClose: () => void }

export function SettingsModal(props: Props) {
  const [activeSection, setActiveSection] = createSignal<SettingsSectionId>("appearance");
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());
  let backdropRef!: HTMLDivElement;
  let closeRef!: HTMLButtonElement;
  let dialogRef!: HTMLDivElement;

  onMount(() => {
    closeRef?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") props.onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    onCleanup(() => document.removeEventListener("keydown", onKeyDown));
  });

  // Live theme preview: apply/clear CSS vars on the dialog element
  createEffect(() => {
    const def = previewThemeDef();
    const dialog = dialogRef;
    if (!dialog) return;
    if (!def) {
      // Clear all CSS var overrides we applied
      const toRemove: string[] = [];
      for (let i = 0; i < dialog.style.length; i++) {
        const prop = dialog.style.item(i);
        if (prop.startsWith("--")) toRemove.push(prop);
      }
      toRemove.forEach((p) => dialog.style.removeProperty(p));
      return;
    }
    for (const [token, value] of Object.entries(def.ui))   dialog.style.setProperty(token, value);
    for (const [token, value] of Object.entries(def.glow)) dialog.style.setProperty(token, value);
  });

  function toggleGroup(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function onBackdropClick(e: MouseEvent) {
    if (e.target === backdropRef) props.onClose();
  }

  return (
    <div class="settings-backdrop" ref={backdropRef} onClick={onBackdropClick}>
      <div class="settings-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-label="Settings">

        <div class="settings-header">
          <span class="settings-title">Settings</span>
          <button class="settings-close" ref={closeRef} onClick={props.onClose} aria-label="Close">✕</button>
        </div>

        <div class="settings-body">
          <nav class="settings-nav">
            <For each={NAV_GROUPS}>
              {(group) => (
                <>
                  <button
                    class="settings-nav-group-header"
                    onClick={() => toggleGroup(group.id)}
                  >
                    <span class={`settings-nav-chevron${collapsed().has(group.id) ? " collapsed" : ""}`}>›</span>
                    {group.label}
                  </button>
                  <Show when={!collapsed().has(group.id)}>
                    <For each={group.sections}>
                      {(sec) => (
                        <button
                          class={`settings-nav-item${activeSection() === sec.id ? " active" : ""}`}
                          onClick={() => setActiveSection(sec.id)}
                        >
                          {sec.label}
                        </button>
                      )}
                    </For>
                  </Show>
                </>
              )}
            </For>
          </nav>

          <div class="settings-content">
            <Show when={activeSection() === "general"}>
              <GeneralSection />
            </Show>
            <Show when={activeSection() === "appearance"}>
              <AppearanceSection />
            </Show>
            <Show when={activeSection() === "editor"}>
              <SchemaSection title="Editor" schema={EDITOR_DECORATIONS_SCHEMA} />
            </Show>
            <Show when={activeSection() === "language-packs"}>
              <LanguagePacksSection onBrowse={() => setActiveSection("marketplace")} />
            </Show>
            <Show when={activeSection() === "extensions-active"}>
              <ActiveExtensionSection />
            </Show>
            <Show when={activeSection() === "extensions-repos"}>
              <ExtensionReposSection />
            </Show>
            <Show when={activeSection() === "extensions-prefs"}>
              <ExtensionPrefsSection />
            </Show>
            <Show when={activeSection() === "marketplace"}>
              <MarketplaceSection />
            </Show>
          </div>
        </div>

      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// General
// ---------------------------------------------------------------------------

function GeneralSection() {
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

// ---------------------------------------------------------------------------
// Theme coverage panel — dev mode only
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------

function AppearanceSection() {
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

  // Any manual individual change reverts the theme set back to "Custom"
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

// ---------------------------------------------------------------------------
// Generic schema-driven section (ADR-0023)
// Fields with the same groupTitle are rendered together in a card group.
// ---------------------------------------------------------------------------

function SchemaSection(props: { title: string; schema: ConfigurationSchema }) {
  type Entry = { key: string; field: ConfigurationField };
  type Group = { title: string | undefined; entries: Entry[] };

  const groups = (): Group[] => {
    const sorted = Object.entries(props.schema)
      .sort(([, a], [, b]) => (a.order ?? 999) - (b.order ?? 999));
    const result: Group[] = [];
    for (const [key, field] of sorted) {
      const last = result[result.length - 1];
      if (!last || (field.groupTitle !== undefined && field.groupTitle !== last.title)) {
        result.push({ title: field.groupTitle, entries: [{ key, field }] });
      } else {
        last.entries.push({ key, field });
      }
    }
    return result;
  };

  return (
    <div class="settings-section">
      <h2 class="settings-section-title">{props.title}</h2>
      <For each={groups()}>
        {(group) => (
          <div class={group.title !== undefined ? "settings-group" : undefined}>
            <Show when={group.title !== undefined}>
              <div class="settings-group-header">{group.title}</div>
            </Show>
            <For each={group.entries}>
              {({ key, field }) => (
                <Show when={!field.when || cfgGet<boolean>(field.when)}>
                  <SchemaField settingKey={key} field={field} />
                </Show>
              )}
            </For>
          </div>
        )}
      </For>
    </div>
  );
}

function SchemaField(props: { settingKey: string; field: ConfigurationField }) {
  const { settingKey: key, field } = props;

  const label = field.title ?? keyLabel(key);

  if (field.type === "boolean") {
    return (
      <SettingsRow label={label} description={field.description}>
        <label class="settings-checkbox-label">
          <input
            type="checkbox"
            class="settings-checkbox"
            checked={cfgGet<boolean>(key)}
            onChange={(e) => cfgSet(key, e.currentTarget.checked)}
          />
        </label>
      </SettingsRow>
    );
  }

  if (field.type === "enum") {
    const opts = field.enum ?? [];
    const labels = field.enumLabels ?? opts;
    if (field.presentation === "radio") {
      return (
        <SettingsRow label={label} description={field.description}>
          <div class="settings-radio-group">
            <For each={opts}>
              {(val, i) => (
                <label class="settings-radio-label">
                  <input
                    type="radio"
                    name={key}
                    class="settings-radio"
                    value={val}
                    checked={cfgGet<string>(key) === val}
                    onChange={() => cfgSet(key, val)}
                  />
                  {labels[i()]}
                </label>
              )}
            </For>
          </div>
        </SettingsRow>
      );
    }
    return (
      <SettingsRow label={label} description={field.description}>
        <select
          class="settings-select"
          value={cfgGet<string>(key)}
          onChange={(e) => cfgSet(key, e.currentTarget.value)}
        >
          <For each={opts}>{(val, i) => <option value={val}>{labels[i()]}</option>}</For>
        </select>
      </SettingsRow>
    );
  }

  if (field.type === "number") {
    if (field.presentation === "range") {
      return (
        <SettingsRow label={label} description={field.description}>
          <div class="settings-range-row">
            <input
              type="range"
              class="settings-range"
              value={cfgGet<number>(key)}
              min={field.minimum ?? 0}
              max={field.maximum ?? 1}
              step={field.step ?? 0.05}
              onInput={(e) => cfgSet(key, e.currentTarget.valueAsNumber)}
            />
            <span class="settings-range-value">{Math.round(cfgGet<number>(key) * 100)}%</span>
          </div>
        </SettingsRow>
      );
    }
    return (
      <SettingsRow label={label} description={field.description}>
        <input
          type="number"
          class="settings-input"
          value={cfgGet<number>(key)}
          min={field.minimum}
          max={field.maximum}
          step={field.step}
          onInput={(e) => cfgSet(key, e.currentTarget.valueAsNumber)}
        />
      </SettingsRow>
    );
  }

  // string fallback
  return (
    <SettingsRow label={label} description={field.description}>
      <input
        type="text"
        class="settings-input"
        value={cfgGet<string>(key)}
        onInput={(e) => cfgSet(key, e.currentTarget.value)}
      />
    </SettingsRow>
  );
}

function keyLabel(key: string): string {
  const segment = key.split(".").pop() ?? key;
  return segment.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Language Packs
// ---------------------------------------------------------------------------

function LanguagePacksSection(props: { onBrowse: () => void }) {
  return (
    <div class="settings-section">
      <h2 class="settings-section-title">Language Packs</h2>
      <p class="settings-section-desc">
        Language packs add full programming-language support — Tree-sitter grammars,
        LSP integration, and debugger adapters — via the Sindri Adapter Protocol.
      </p>

      <div class="langpacks-installed">
        <div class="langpacks-empty">
          <div class="langpacks-empty-icon">⬡</div>
          <div class="langpacks-empty-label">No language packs installed</div>
          <div class="langpacks-empty-desc">
            Built-in syntax highlighting covers JS/TS, Python, Rust, Go, and more.
            Install a language pack to add LSP hover, completions, and diagnostics.
          </div>
          <div class="langpacks-host-note">
            Language pack installation requires the extension host — coming in a future update.
          </div>
          <button class="settings-btn-secondary langpacks-browse-btn" onClick={props.onBrowse}>
            Browse Marketplace
          </button>
        </div>
      </div>

      <div class="settings-section-divider" />

      <h3 class="settings-subsection-title">Built-in syntax support</h3>
      <div class="langpacks-builtin-grid">
        {(["JavaScript", "TypeScript", "JSX / TSX", "Python", "Rust", "Go", "Java", "C / C++", "HTML", "CSS / SCSS", "JSON", "Markdown"] as string[]).map((lang) => (
          <div class="langpacks-builtin-chip">
            <span class="langpacks-builtin-dot" />
            {lang}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Installed Extensions — Dev and Marketplace/Local sections
// ---------------------------------------------------------------------------

type InstallStatus =
  | { kind: "ok"; name: string; version: string }
  | { kind: "err"; msg: string };

function ActiveExtensionSection() {
  const [activeTab, setActiveTab] = createSignal<"installed" | "dev">("installed");
  const [loadingSource, setLoadingSource] = createSignal(false);
  const [installing, setInstalling] = createSignal(false);
  const [status, setStatus] = createSignal<InstallStatus | null>(null);
  const [debuggerUrls, setDebuggerUrls] = createSignal<Map<string, string>>(new Map());

  const devExtensions = () => installedExtensions().filter((r) => r.repoUrl === "dev");
  const localExts = () => installedExtensions().filter((r) => r.repoUrl === "local");
  const marketplaceExts = () => installedExtensions().filter((r) => r.repoUrl !== "dev" && r.repoUrl !== "local");

  async function handleLoadFromSource() {
    setStatus(null);
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Extension Manifest", extensions: ["json"] }],
      title: "Select manifest.json",
    });
    if (!selected || typeof selected !== "string") return;
    const dir = selected.replace(/[/\\][^/\\]*$/, "") || selected;
    setLoadingSource(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<{ manifest_json: string; dev_dir: string }>(
        "ext_load_from_source",
        { dir },
      );
      const manifest = JSON.parse(result.manifest_json) as ExtensionManifest;
      if (!manifest.id) throw new Error("manifest.json missing 'id'");
      loadDevExtension(manifest.id, selected, manifest);
      await activateExtensionWithManifest(`${result.dev_dir}/extension.js`);
      setStatus({ kind: "ok", name: manifest.name ?? manifest.id, version: manifest.version ?? "" });
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    } finally {
      setLoadingSource(false);
    }
  }

  async function handleInstallFromFile() {
    setStatus(null);
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Sindri Extension", extensions: ["sinxt"] }],
    });
    if (!selected || typeof selected !== "string") return;
    setInstalling(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<{ sinxt_path: string; manifest_json: string }>(
        "install_sinxt_from_path",
        { path: selected },
      );
      const manifest = JSON.parse(result.manifest_json) as ExtensionManifest;
      if (!manifest.id) throw new Error("manifest.json missing 'id'");
      const existing = installedExtensions().find((r) => r.id === manifest.id);
      if (existing && existing.repoUrl !== "local" && existing.repoUrl !== "dev") {
        setLocalSinxtAlt(manifest.id, result.sinxt_path, manifest);
      } else if (existing) {
        updateInstalledExtension(manifest.id, manifest, result.sinxt_path);
      } else {
        installExtension(manifest.id, "local", "", manifest, result.sinxt_path);
      }
      await activateExtensionFromSinxt(result.sinxt_path, manifest);
      setStatus({ kind: "ok", name: manifest.name ?? manifest.id, version: manifest.version ?? "" });
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    } finally {
      setInstalling(false);
    }
  }

  async function handleRemoveDev(id: string) {
    deregisterExtDecorations(id);
    const restored = uninstallExtension(id);
    setDebuggerUrls((prev) => { const m = new Map(prev); m.delete(id); return m; });
    if (isTauri()) {
      const { invoke } = await import("@tauri-apps/api/core");
      invoke("ext_stop_dev_watch", { extId: id }).catch(() => {});
      if (restored) {
        const sinxt = activeSinxtPath(restored);
        const mf = activeManifest(restored);
        if (sinxt) activateExtensionFromSinxt(sinxt, mf).catch(() => {});
      }
    }
  }

  async function handleAttachDebugger(id: string) {
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      const wsUrl = await invoke<string>("ext_attach_debugger", { extId: id });
      setDebuggerUrls((prev) => new Map([...prev, [id, wsUrl]]));
    } catch (e) {
      alert(`Attach debugger failed: ${e}`);
    }
  }

  async function handleStopDebugger(id: string) {
    setDebuggerUrls((prev) => { const m = new Map(prev); m.delete(id); return m; });
    if (isTauri()) {
      const { invoke } = await import("@tauri-apps/api/core");
      invoke("ext_stop_debugger", { extId: id }).catch(() => {});
    }
  }

  function handleCopyDebugUrl(url: string) {
    navigator.clipboard.writeText(url).catch(() => {});
  }

  return (
    <div class="settings-section">
      <h2 class="settings-section-title">Extensions</h2>

      {/* Tab bar */}
      <div class="ext-tabs">
        <button
          class={`ext-tab${activeTab() === "installed" ? " active" : ""}`}
          onClick={() => setActiveTab("installed")}
        >
          Installed Extensions
        </button>
        <button
          class={`ext-tab${activeTab() === "dev" ? " active" : ""}`}
          onClick={() => setActiveTab("dev")}
        >
          Dev Extensions
        </button>
      </div>

      {/* ── Installed Extensions tab ────────────────────────────────────────── */}
      <Show when={activeTab() === "installed"}>
        <p class="settings-section-desc">
          Extensions installed from the marketplace or a local <code>.sinxt</code> package.
        </p>

        {/* Locally installed */}
        <h3 class="settings-subsection-title">From file</h3>
        <Show when={localExts().length > 0} fallback={
          <div class="ext-active-empty">No locally installed extensions.</div>
        }>
          <For each={localExts()}>
            {(record) => (
              <div class="ext-active-row">
                <span class="ext-active-name">{record.manifest.name ?? record.id}</span>
                <span class="ext-active-badge">v{record.manifest.version ?? "?"}</span>
                <button
                  class="settings-btn-secondary ext-active-uninstall"
                  onClick={async () => {
                    deregisterExtDecorations(record.id);
                    for (const wp of record.manifest.contributes?.webviewPanels ?? []) unregisterToolWindow(wp.id);
                    for (const tv of record.manifest.contributes?.treeViews ?? []) unregisterToolWindow(tv.id);
                    uninstallExtension(record.id);
                    if (isTauri()) {
                      const { invoke } = await import("@tauri-apps/api/core");
                      await invoke("ext_deactivate", { extId: record.id }).catch(() => {});
                    }
                  }}
                >
                  Uninstall
                </button>
              </div>
            )}
          </For>
        </Show>

        <Show when={isTauri()}>
          <div class="ext-active-actions">
            <button
              class="settings-btn-secondary"
              disabled={installing()}
              title="Install a pre-built .sinxt extension package from your local disk."
              onClick={handleInstallFromFile}
            >
              {installing() ? "Installing…" : "Install from .sinxt…"}
            </button>
          </div>
        </Show>

        {/* Marketplace installed */}
        <Show when={marketplaceExts().length > 0}>
          <h3 class="settings-subsection-title" style="margin-top: 1.25rem">From marketplace</h3>
          <For each={marketplaceExts()}>
            {(record) => {
              const activeVariant = () => record.activeVariant ?? "marketplace";
              async function handleSwitch(variant: "marketplace" | "local") {
                switchExtensionVariant(record.id, variant);
                const sinxt = variant === "local" && record.localSinxtAlt
                  ? record.localSinxtAlt.sinxtPath
                  : record.sinxtPath;
                const mf = variant === "local" && record.localSinxtAlt
                  ? record.localSinxtAlt.manifest
                  : record.manifest;
                if (sinxt) await activateExtensionFromSinxt(sinxt, mf).catch(() => {});
              }
              return (
                <div class="ext-active-row">
                  <span class="ext-active-name">{record.manifest.name ?? record.id}</span>
                  <Show when={record.localSinxtAlt}
                    fallback={
                      <span class="ext-active-badge">v{record.manifest.version ?? "?"}</span>
                    }
                  >
                    <select
                      class="ext-variant-select"
                      value={activeVariant()}
                      onChange={(e) => handleSwitch(e.currentTarget.value as "marketplace" | "local")}
                    >
                      <option value="marketplace">marketplace v{record.manifest.version ?? "?"}</option>
                      <option value="local">local .sinxt v{record.localSinxtAlt!.manifest.version ?? "?"}</option>
                    </select>
                  </Show>
                  <button
                    class="settings-btn-secondary ext-active-uninstall"
                    onClick={async () => {
                      deregisterExtDecorations(record.id);
                      for (const wp of record.manifest.contributes?.webviewPanels ?? []) unregisterToolWindow(wp.id);
                      for (const tv of record.manifest.contributes?.treeViews ?? []) unregisterToolWindow(tv.id);
                      uninstallExtension(record.id);
                      if (isTauri()) {
                        const { invoke } = await import("@tauri-apps/api/core");
                        await invoke("ext_deactivate", { extId: record.id }).catch(() => {});
                      }
                    }}
                  >
                    Uninstall
                  </button>
                </div>
              );
            }}
          </For>
        </Show>

        <Show when={localExts().length === 0 && marketplaceExts().length === 0}>
          <div class="ext-active-empty" style="margin-top: 0.75rem">No extensions installed yet. Browse the Marketplace to get started.</div>
        </Show>

        <Show when={!isTauri()}>
          <div class="langpacks-host-note">
            Extension installation requires the Tauri desktop app.
          </div>
        </Show>
      </Show>

      {/* ── Dev Extensions tab ─────────────────────────────────────────────── */}
      <Show when={activeTab() === "dev"}>
        <p class="settings-section-desc">
          Extensions loaded from source. Sindri builds and hot-reloads them on every
          file save — no packaging or manual reinstall needed.
        </p>

        <Show when={isTauri()}>
          <div class="ext-debug-help">
            <div class="ext-debug-help-title">Debugger setup</div>

            <div class="ext-debug-help-option">
              <strong>Option A — Chrome DevTools</strong>
              <ol class="ext-debug-steps">
                <li>Open <code>chrome://inspect</code> in Chrome or Edge</li>
                <li>Click <strong>Configure…</strong> and add <code>127.0.0.1:9229</code></li>
                <li>Click <strong>Attach Debugger</strong> on an extension below — it appears under <em>Remote Targets</em></li>
              </ol>
              <p class="ext-debug-help-note">Or use the <strong>Dev Tools</strong> button in the menu bar (⌘⌥I / Ctrl+Shift+I) to open the app's own inspector.</p>
            </div>

            <div class="ext-debug-help-option">
              <strong>Option B — VS Code</strong>
              <p class="ext-debug-help-note">Add to <code>.vscode/launch.json</code>:</p>
              <pre class="ext-debug-launch-json">{`{
  "type": "node",
  "request": "attach",
  "name": "Attach to Sindri extension",
  "address": "127.0.0.1",
  "port": 9229,
  "sourceMaps": true
}`}</pre>
            </div>
          </div>
        </Show>

        <Show when={devExtensions().length > 0} fallback={
          <div class="ext-active-empty">No dev extensions loaded.</div>
        }>
          <For each={devExtensions()}>
            {(record) => (
              <div class="ext-active-row ext-active-row--stack">
                <div class="ext-active-row-main">
                  <span class="ext-active-name">{record.manifest.name ?? record.id}</span>
                  <span class="ext-active-badge">v{record.manifest.version ?? "?"}</span>
                  <Show when={debuggerUrls().has(record.id)}
                    fallback={
                      <span class="ext-active-badge ext-active-badge--dev" title="Loaded from source — Sindri watches and hot-reloads on save">dev ◉</span>
                    }
                  >
                    <span class="ext-active-badge ext-active-badge--debug" title="CDP debugger session active">◉ debugging</span>
                  </Show>
                  <Show when={isTauri()}>
                    <button
                      class="settings-btn-secondary"
                      title={debuggerUrls().has(record.id) ? "Re-attach a fresh CDP session" : "Open a CDP debugger session (debug builds only)"}
                      onClick={() => handleAttachDebugger(record.id)}
                    >
                      {debuggerUrls().has(record.id) ? "Re-attach" : "Attach Debugger"}
                    </button>
                    <Show when={debuggerUrls().has(record.id)}>
                      <button
                        class="settings-btn-secondary"
                        title="Close the inspector session and return to idle mode"
                        onClick={() => handleStopDebugger(record.id)}
                      >
                        Stop
                      </button>
                    </Show>
                  </Show>
                  <button
                    class="settings-btn-secondary ext-active-uninstall"
                    onClick={() => handleRemoveDev(record.id)}
                  >
                    Remove
                  </button>
                </div>
                <Show when={debuggerUrls().get(record.id)}>
                  {(url) => (
                    <div class="ext-debug-url-row">
                      <code class="ext-debug-url">{url()}</code>
                      <button
                        class="settings-btn-secondary ext-debug-copy"
                        title="Copy WebSocket URL to clipboard"
                        onClick={() => handleCopyDebugUrl(url())}
                      >
                        Copy
                      </button>
                    </div>
                  )}
                </Show>
              </div>
            )}
          </For>
        </Show>

        <Show when={isTauri()}>
          <div class="ext-active-actions">
            <button
              class="settings-btn-primary"
              disabled={loadingSource()}
              title="Select the manifest.json of a TypeScript extension. Sindri builds it and hot-reloads on every file save."
              onClick={handleLoadFromSource}
            >
              {loadingSource() ? "Building…" : "Load from manifest.json…"}
            </button>
          </div>
        </Show>

        <Show when={!isTauri()}>
          <div class="langpacks-host-note">
            Dev extension loading requires the Tauri desktop app.
          </div>
        </Show>
      </Show>

      {/* Status feedback — shared between tabs */}
      <Show when={status()?.kind === "ok"}>
        <div class="settings-success-note">
          {(status() as Extract<InstallStatus, { kind: "ok" }>).name}{" "}
          v{(status() as Extract<InstallStatus, { kind: "ok" }>).version} activated.
        </div>
      </Show>
      <Show when={status()?.kind === "err"}>
        <div class="settings-field-error">
          {(status() as Extract<InstallStatus, { kind: "err" }>).msg}
        </div>
      </Show>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Extension Repositories
// ---------------------------------------------------------------------------

function validateRepoUrl(raw: string): string | null {
  const url = raw.trim();
  if (!url) return "URL is required";
  if (!url.startsWith("https://")) return "Must start with https://";
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return "Must point to a repository — e.g. https://github.com/owner/repo";
    return null;
  } catch {
    return "Invalid URL";
  }
}

function ExtensionReposSection() {
  const [newUrl, setNewUrl] = createSignal("");
  const [adding, setAdding] = createSignal(false);
  const [urlError, setUrlError] = createSignal<string | null>(null);
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function submitAdd() {
    const url = newUrl().trim();
    const err = validateRepoUrl(url);
    if (err) { setUrlError(err); return; }
    addRepo(url);
    setNewUrl("");
    setAdding(false);
    setUrlError(null);
  }

  function onUrlInput(val: string) {
    setNewUrl(val);
    if (urlError()) setUrlError(validateRepoUrl(val));
  }

  return (
    <div class="settings-section">
      <h2 class="settings-section-title">Extension Repositories</h2>
      <p class="settings-section-desc">
        Repositories are git repos. Sindri fetches each repo's <code>index.json</code> to discover extensions.
      </p>

      <div class="settings-repo-list">
        <For each={registryRepos()}>
          {(repo) => {
            const [meta] = createResource(() => repo.url, (url) => getRegistryClient().fetchMeta(url));

            return (
              <div class="settings-repo-item">
                <div
                  class="settings-repo-row settings-repo-row-clickable"
                  onClick={() => toggleExpand(repo.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleExpand(repo.id); } }}
                >
                  <div class="settings-repo-info">
                    <div class="settings-repo-label-stack">
                      <span class="settings-repo-name">{meta()?.name ?? repo.url}</span>
                      <Show when={meta()?.name}>
                        <span class="settings-repo-url-secondary">{repo.url}</span>
                      </Show>
                    </div>
                    <Show when={repo.trusted}><span class="settings-repo-badge">first-party</span></Show>
                    <Show when={repo.showPrerelease}>
                      <span class="settings-repo-badge settings-repo-badge-prerelease">pre-release</span>
                    </Show>
                    <Show when={repo.developerMode}>
                      <span class="settings-repo-badge settings-repo-badge-errors">dev</span>
                    </Show>
                  </div>
                  <div class="settings-repo-actions">
                    <Show when={!repo.trusted}>
                      <button
                        class="settings-repo-btn"
                        onClick={(e) => { e.stopPropagation(); removeRepo(repo.id); }}
                      >Remove</button>
                    </Show>
                    <span
                      class={`settings-repo-expand-btn${expanded().has(repo.id) ? " open" : ""}`}
                      aria-expanded={expanded().has(repo.id)}
                    >›</span>
                  </div>
                </div>
                <Show when={expanded().has(repo.id)}>
                  <div class="settings-repo-drawer">
                    <Show when={meta()?.description}>
                      <p class="settings-repo-meta-desc">{meta()?.description}</p>
                    </Show>
                    <Show when={meta()?.homepage}>
                      <div class="settings-repo-meta-item">
                        <a class="settings-repo-meta-link" href={meta()?.homepage} target="_blank" rel="noopener noreferrer">{meta()?.homepage}</a>
                      </div>
                    </Show>
                    <label class="settings-checkbox-label settings-repo-drawer-item">
                      <input
                        type="checkbox"
                        class="settings-checkbox"
                        checked={!!repo.showPrerelease}
                        onChange={() => toggleRepoPrerelease(repo.id)}
                      />
                      Get pre-release / beta extensions
                    </label>
                    <label class="settings-checkbox-label settings-repo-drawer-item">
                      <input
                        type="checkbox"
                        class="settings-checkbox"
                        checked={!!repo.developerMode}
                        onChange={() => toggleRepoDeveloperMode(repo.id)}
                      />
                      Enable developer mode
                      <span class="settings-repo-devmode-hint"> — shows a "Contributes" section and error stack traces in the marketplace for extensions from this repo. Intended for extension authors testing their own registry.</span>
                    </label>
                  </div>
                </Show>
              </div>
            );
          }}
        </For>
      </div>

      <Show
        when={adding()}
        fallback={
          <button class="settings-btn-secondary" onClick={() => setAdding(true)}>+ Add repository</button>
        }
      >
        <div class="settings-repo-add">
          <div class="settings-repo-add-row">
            <input
              class={`settings-input${urlError() ? " settings-input-error" : ""}`}
              type="url"
              placeholder="https://github.com/owner/repo"
              value={newUrl()}
              onInput={(e) => onUrlInput(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitAdd();
                if (e.key === "Escape") { setAdding(false); setNewUrl(""); setUrlError(null); }
              }}
              autofocus
            />
            <button class="settings-btn-primary" onClick={submitAdd}>Add</button>
            <button class="settings-btn-secondary" onClick={() => { setAdding(false); setNewUrl(""); setUrlError(null); }}>Cancel</button>
          </div>
          <Show when={urlError()}>
            <div class="settings-field-error">{urlError()}</div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Extension Preferences
// ---------------------------------------------------------------------------

function ExtensionPrefsSection() {
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

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** Wraps one or more SettingsRow elements in a labelled card group. */
export function SettingsGroup(props: { title: string; children: unknown }) {
  return (
    <div class="settings-group">
      <div class="settings-group-header">{props.title}</div>
      {props.children as any}
    </div>
  );
}

export function SettingsRow(props: { label: string; description?: string; children: unknown }) {
  return (
    <div class="settings-row">
      <div class="settings-row-label">
        <span class="settings-row-name">{props.label}</span>
        <Show when={props.description}>
          <span class="settings-row-desc">{props.description}</span>
        </Show>
      </div>
      <div class="settings-row-control">{props.children as any}</div>
    </div>
  );
}
