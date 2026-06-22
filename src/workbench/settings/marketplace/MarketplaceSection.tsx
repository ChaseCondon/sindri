// Marketplace storefront — ADR-0020 §3 / §7
// Search bar | Category sidebar | Extension list | Detail pane
import { createSignal, createResource, For, Show, createMemo, ErrorBoundary, createEffect, onCleanup } from "solid-js";
import type { ExtensionCategory } from "../../../extensions/manifest";
import { checkUpdatesOnly } from "../../../extensions/update-checker";
import { activateExtensionFromSinxt } from "../../../extensions/activation";
import { unregisterTheme, unregisterIconTheme, unregisterUiIconPack } from "../../../theme/registry";
import { unregisterToolWindow } from "../../layout";
import { removeExtensionLogs } from "../../panels/ext-logs-store";
import {
  registryRepos, installedIds, installedExtensions, uninstallExtension,
  setExtensionEnabled, setPreviewThemeDef,
} from "../store";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../../../lib/tauri";
import {
  CATEGORY_GROUPS, CATEGORY_ICONS, KNOWN_CATS,
  hasUpdate, fuzzyMatch, fetchAllEntries, doInstall, doUninstall, allEntries,
  type MarketplaceEntry,
} from "./store";
import { ExtensionDetail } from "./ExtensionDetail";

export function MarketplaceSection() {
  const [filterCat, setFilterCat] = createSignal<ExtensionCategory | "All">("All");
  const [selected, setSelected] = createSignal<MarketplaceEntry | null>(null);
  const [refreshKey, setRefreshKey] = createSignal(0);
  const [search, setSearch] = createSignal("");
  const [showInstalled, setShowInstalled] = createSignal(false);
  const [showUpdates, setShowUpdates] = createSignal(false);
  const [installing, setInstalling] = createSignal<string | null>(null);
  const [installFailed, setInstallFailed] = createSignal<string | null>(null);
  const [entries] = createResource(refreshKey, fetchAllEntries);

  // Clear live preview when leaving the marketplace
  onCleanup(() => setPreviewThemeDef(null));

  createEffect(() => {
    const list = filtered();
    if (list.length === 0) { setSelected(null); return; }
    // Only auto-select when nothing is selected; preserve explicit navigation.
    if (!selected()) setSelected(list[0]);
  });

  const pendingUpdates = createMemo(() =>
    (entries() ?? []).filter((e) => e.repoUrl && installedIds().has(e.item.manifest.id) && hasUpdate(e))
  );

  const searched = createMemo(() => {
    const q = search().trim();
    let list = entries() ?? [];
    if (showUpdates()) return pendingUpdates();
    if (q) list = list.filter((e) => fuzzyMatch(q, e.item));
    if (showInstalled()) list = list.filter((e) => e.repoUrl === null || installedIds().has(e.item.manifest.id));
    return list;
  });

  const filtered = createMemo(() => {
    const cat = filterCat();
    if (cat === "All") return searched();
    // For theme/icon tabs, filter by actual contributes — prevents packs from appearing here
    // just because their declared categories list these (they contribute indirectly through members).
    if (cat === "Color Theme")     return searched().filter((e) => (e.item.manifest.contributes?.themes?.length ?? 0) > 0);
    if (cat === "File Icon Theme") return searched().filter((e) => (e.item.manifest.contributes?.iconThemes?.length ?? 0) > 0);
    if (cat === "UI Icon Theme")   return searched().filter((e) => (e.item.manifest.contributes?.uiIconPacks?.length ?? 0) > 0);
    if (cat === "Extension Pack")  return searched().filter((e) => (e.item.manifest.extensionPack?.length ?? 0) > 0);
    if (cat === "Other") {
      return searched().filter((e) =>
        e.item.manifest.categories.includes("Other") ||
        e.item.manifest.categories.every((c) => !KNOWN_CATS.has(c))
      );
    }
    return searched().filter((e) => e.item.manifest.categories.includes(cat as ExtensionCategory));
  });

  const counts = createMemo(() => {
    const all = searched();
    const map: Record<string, number> = { All: all.length };
    // Theme/icon counts mirror the contributes-based filtering used in filtered()
    map["Color Theme"]     = all.filter(e => (e.item.manifest.contributes?.themes?.length ?? 0) > 0).length;
    map["File Icon Theme"] = all.filter(e => (e.item.manifest.contributes?.iconThemes?.length ?? 0) > 0).length;
    map["UI Icon Theme"]   = all.filter(e => (e.item.manifest.contributes?.uiIconPacks?.length ?? 0) > 0).length;
    map["Extension Pack"]  = all.filter(e => (e.item.manifest.extensionPack?.length ?? 0) > 0).length;
    for (const e of all) {
      for (const c of e.item.manifest.categories) {
        if (c === "Color Theme" || c === "File Icon Theme" || c === "UI Icon Theme" || c === "Extension Pack") continue;
        map[c] = (map[c] ?? 0) + 1;
      }
      if (e.item.manifest.categories.every((c) => !KNOWN_CATS.has(c))) {
        map["Other"] = (map["Other"] ?? 0) + 1;
      }
    }
    return map;
  });

  // Error detail panel is only shown when the extension's source repo has developer mode on
  const showErrorsForEntry = (me: MarketplaceEntry | null): boolean => {
    if (!me || !me.repoUrl) return false;
    const repo = registryRepos().find((r) => r.url === me.repoUrl);
    return repo?.developerMode ?? false;
  };

  async function handleInstall(e: MarketplaceEntry) {
    setInstalling(e.item.manifest.id);
    setInstallFailed(null);
    const ok = await doInstall(e);
    setInstalling(null);
    if (!ok) setInstallFailed(e.item.manifest.id);
  }

  function navigateTo(me: MarketplaceEntry) {
    setFilterCat("All");
    setSelected(me);
  }

  return (
    <div class="mkt-shell">

      {/* Search bar */}
      <div class="mkt-search-bar">
        <input
          class="mkt-search-input"
          type="search"
          placeholder="Search extensions… (@publisher: @category: @lang: @tag:)"
          value={search()}
          onInput={(e) => { setSearch(e.currentTarget.value); setSelected(null); }}
        />
        <button
          class={`mkt-filter-installed${showInstalled() ? " active" : ""}`}
          onClick={() => { setShowInstalled((v) => !v); setShowUpdates(false); setSelected(null); }}
          title="Show installed only"
        >
          Installed
        </button>
        <button
          class={`mkt-filter-installed${showUpdates() ? " active" : ""}${pendingUpdates().length > 0 ? " mkt-filter-has-updates" : ""}`}
          onClick={() => { setShowUpdates((v) => !v); setShowInstalled(false); setSelected(null); }}
          title="Show extensions with updates"
        >
          Updates{pendingUpdates().length > 0 ? ` (${pendingUpdates().length})` : ""}
        </button>
      </div>

      {/* ── Installed extensions card grid ─────────────────────────────── */}
      <Show when={showInstalled()}>
        <div class="mkt-installed-grid">
          <Show when={installedExtensions().length === 0}>
            <div class="mkt-state">No extensions installed yet.</div>
          </Show>
          <For each={installedExtensions()}>
            {(record) => {
              const entry = () => allEntries().find((e) => e.item.manifest.id === record.id) ?? null;
              const updateAvail = () => {
                const e = entry();
                return e && e.repoUrl ? hasUpdate(e) : false;
              };
              const enabled = () => record.enabled !== false;
              const category = record.manifest.categories?.[0] ?? "Other";

              async function toggleEnabled(): Promise<void> {
                if (enabled()) {
                  setExtensionEnabled(record.id, false);
                  if (isTauri()) await invoke("ext_deactivate", { extId: record.id }).catch(() => {});
                } else {
                  setExtensionEnabled(record.id, true);
                  const sinxtPath = record.sinxtPath;
                  if (sinxtPath && isTauri()) {
                    await activateExtensionFromSinxt(sinxtPath, record.manifest).catch((e) => {
                      console.warn(`[Marketplace] re-enable ${record.id}:`, e);
                    });
                  }
                }
              }

              return (
                <div class={`mkt-ext-card${enabled() ? "" : " mkt-ext-card-disabled"}`}>
                  <div class="mkt-ext-card-icon">{CATEGORY_ICONS[category as ExtensionCategory] ?? "◈"}</div>
                  <div class="mkt-ext-card-body">
                    <div class="mkt-ext-card-name">
                      {record.manifest.name}
                      <span class="mkt-ext-card-version">v{record.manifest.version}</span>
                    </div>
                    <div class="mkt-ext-card-desc">{record.manifest.description}</div>
                  </div>
                  <div class="mkt-ext-card-actions">
                    <label class="mkt-ext-toggle" title={enabled() ? "Disable extension" : "Enable extension"}>
                      <input
                        type="checkbox"
                        checked={enabled()}
                        onChange={() => { void toggleEnabled(); }}
                      />
                      <span class="mkt-ext-toggle-label">{enabled() ? "Enabled" : "Disabled"}</span>
                    </label>
                    <Show when={updateAvail()}>
                      <button
                        class="settings-btn-primary mkt-ext-btn"
                        onClick={() => { const e = entry(); if (e) void handleInstall(e); }}
                      >Update</button>
                    </Show>
                    <button
                      class="settings-btn-secondary mkt-ext-btn"
                      onClick={() => {
                        // Deregister any contributed themes/icons using data from the stored record.
                        for (const theme of record.manifest.contributes?.themes ?? []) unregisterTheme(theme.id);
                        for (const iconTheme of record.manifest.contributes?.iconThemes ?? []) unregisterIconTheme(iconTheme.id);
                        for (const uiPack of record.manifest.contributes?.uiIconPacks ?? []) unregisterUiIconPack(uiPack.id);
                        for (const wp of record.manifest.contributes?.webviewPanels ?? []) unregisterToolWindow(wp.id);
                        for (const tv of record.manifest.contributes?.treeViews ?? []) unregisterToolWindow(tv.id);
                        removeExtensionLogs(record.id);
                        uninstallExtension(record.id);
                        if (isTauri()) invoke("ext_deactivate", { extId: record.id }).catch(() => {});
                      }}
                    >Uninstall</button>
                  </div>
                </div>
              );
            }}
          </For>
        </div>
      </Show>

      <div class="mkt-body" style={showInstalled() ? "display:none" : ""}>

        {/* Category sidebar */}
        <aside class="mkt-sidebar">
          <div class="mkt-sidebar-head">
            <span>Categories</span>
            <button
              class="mkt-refresh"
              onClick={() => { setRefreshKey((k) => k + 1); setSelected(null); void checkUpdatesOnly(); }}
              disabled={entries.loading}
              title="Refresh"
            >↻</button>
          </div>
          <For each={CATEGORY_GROUPS}>
            {(group) => (
              <div class="mkt-cat-group">
                <Show when={group.label}>
                  <div class="mkt-cat-group-label">{group.label}</div>
                </Show>
                <For each={group.cats}>
                  {(cat) => (
                    <button
                      class={`mkt-cat-item${filterCat() === cat ? " active" : ""}`}
                      onClick={() => { setFilterCat(cat); setSelected(null); }}
                    >
                      <span class="mkt-cat-icon">{CATEGORY_ICONS[cat]}</span>
                      <span class="mkt-cat-name">{cat}</span>
                      <Show when={counts()[cat] !== undefined}>
                        <span class="mkt-cat-count">{counts()[cat]}</span>
                      </Show>
                    </button>
                  )}
                </For>
              </div>
            )}
          </For>
        </aside>

        {/* Results + detail */}
        <div class="mkt-main">
          <Show when={entries.loading}>
            <div class="mkt-state">Fetching extensions…</div>
          </Show>

          <Show when={entries.error && !entries.loading}>
            <div class="mkt-state mkt-state-error">
              Could not reach registry. Check your repository configuration.
            </div>
          </Show>

          <Show when={!entries.loading && !entries.error && filtered().length === 0}>
            <div class="mkt-state">
              {search().trim()
                ? `No extensions match "${search().trim()}".`
                : showInstalled()
                ? "No extensions installed yet."
                : "No extensions in this category."}
            </div>
          </Show>

          <Show when={!entries.loading && filtered().length > 0}>
            <div class="mkt-panes">
              <div class="mkt-list">
                <For each={filtered()}>
                  {(me) => {
                    const manifest = me.item.manifest;
                    const installed = () => installedIds().has(manifest.id);
                    const isBundled = me.repoUrl === null;
                    const updateAvailable = () => installed() && !isBundled && hasUpdate(me);
                    return (
                      <button
                        class={`mkt-card${selected()?.item.manifest.id === manifest.id ? " active" : ""}`}
                        onClick={() => setSelected(me)}
                      >
                        <div class="mkt-card-icon">{CATEGORY_ICONS[manifest.categories[0]] ?? "◈"}</div>
                        <div class="mkt-card-body">
                          <div class="mkt-card-name">
                            <span class="mkt-card-name-text">{manifest.name}</span>
                            <Show when={isBundled}>
                              <span class="mkt-icon-badge mkt-icon-badge-core" title="Sindri Core">◈</span>
                            </Show>
                            <Show when={updateAvailable()}>
                              <span class="mkt-icon-badge mkt-icon-badge-update" title="Update available">↑</span>
                            </Show>
                            <Show when={installed() && !isBundled && !updateAvailable()}>
                              <span class="mkt-icon-badge mkt-icon-badge-installed" title="Installed">✓</span>
                            </Show>
                          </div>
                          <div class="mkt-card-meta">{manifest.publisher} · v{manifest.version}</div>
                          <div class="mkt-card-desc">{manifest.description}</div>
                        </div>
                      </button>
                    );
                  }}
                </For>
              </div>

              <Show when={selected()} keyed>
                {(me) => (
                  <ErrorBoundary fallback={(err, reset) => showErrorsForEntry(me)
                    ? (
                      <div class="mkt-detail-error">
                        <div class="mkt-detail-error-icon">⚠</div>
                        <div class="mkt-detail-error-msg">Extension details could not be rendered.</div>
                        <code class="mkt-detail-error-code">{String(err)}</code>
                        <button class="settings-btn-secondary" onClick={reset}>Try again</button>
                      </div>
                    ) : null
                  }>
                    <ExtensionDetail
                      entry={me}
                      installing={installing() === me.item.manifest.id}
                      installFailed={installFailed() === me.item.manifest.id}
                      onInstall={() => handleInstall(me)}
                      onUninstall={() => doUninstall(me)}
                      onNavigate={navigateTo}
                    />
                  </ErrorBoundary>
                )}
              </Show>
            </div>
          </Show>
        </div>

      </div>{/* mkt-body */}
    </div>
  );
}
