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
  installedIds, installedExtensions,
  liveThemePreview, setLiveThemePreview,
  previewThemeDef,
  activeBundlePath, setActiveBundlePath,
} from "./store";
import { activateExtensionWithManifest } from "../../extensions/activation";
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
      { id: "extensions-active", label: "Active Extension" },
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
// Active Extension
// ---------------------------------------------------------------------------

function ActiveExtensionSection() {
  const [activating, setActivating] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const bundleName = () => {
    const p = activeBundlePath();
    if (!p) return null;
    return p.split(/[/\\]/).pop() ?? p;
  };

  async function handleLoadFromFile() {
    setError(null);
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Extension Bundle", extensions: ["js"] }],
    });
    if (!selected || typeof selected !== "string") return;
    setActivating(true);
    try {
      await activateExtensionWithManifest(selected);
      setActiveBundlePath(selected);
    } catch (e) {
      setError(String(e));
    } finally {
      setActivating(false);
    }
  }

  return (
    <div class="settings-section">
      <h2 class="settings-section-title">Active Extension</h2>
      <p class="settings-section-desc">
        Load a pre-built extension bundle from disk to activate it for this session.
        Remote install from the Marketplace is coming once the download pipeline is wired up.
      </p>

      <SettingsGroup title="Current">
        <Show
          when={activeBundlePath()}
          fallback={<div class="ext-active-empty">No extension active</div>}
        >
          <div class="ext-active-row">
            <code class="ext-active-name">{bundleName()}</code>
            <span class="ext-active-badge">Active</span>
          </div>
        </Show>
      </SettingsGroup>

      <Show when={isTauri()}>
        <div class="ext-active-actions">
          <button
            class="settings-btn-primary"
            disabled={activating()}
            onClick={handleLoadFromFile}
          >
            {activating() ? "Activating…" : activeBundlePath() ? "Load different extension" : "Load from file…"}
          </button>
        </div>
        <Show when={error()}>
          <div class="settings-field-error">{error()}</div>
        </Show>
      </Show>

      <Show when={!isTauri()}>
        <div class="langpacks-host-note">
          Extension loading requires the Tauri desktop app.
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
