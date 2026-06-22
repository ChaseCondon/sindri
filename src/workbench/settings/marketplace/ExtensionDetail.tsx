// Extension detail pane — ADR-0020 §3
import { createSignal, createEffect, createMemo, For, Show, onCleanup } from "solid-js";
import { rawFileUrl } from "../../../extensions/registry-client";
import { getThemeDef, setUiTheme, setIconTheme, setUiPack } from "../../../theme/registry";
import type { ThemeDef } from "../../../theme/tokens";
import { registryRepos, installedIds, liveThemePreview, setPreviewThemeDef } from "../store";
import {
  allEntries, hasUpdate, isPrerelease, isExtensionPack, CATEGORY_ICONS,
  type MarketplaceEntry,
} from "./store";
import { safeRenderMarkdown } from "./markdown";
import { ThemePreview } from "./ThemePreview";
import { IconThemePreview } from "./IconThemePreview";

export function ExtensionDetail(props: {
  entry: MarketplaceEntry;
  installing: boolean;
  installFailed: boolean;
  onInstall: () => void;
  onUninstall: () => void;
  onNavigate: (entry: MarketplaceEntry) => void;
}) {
  const manifest = props.entry.item.manifest;
  const isBundled = props.entry.repoUrl === null;
  const installed = () => installedIds().has(manifest.id);
  const isPack = isExtensionPack(manifest);
  const updateAvailable = () => installed() && !isBundled && hasUpdate(props.entry);
  // available === false means stub/WIP — no .sinxt exists yet. Absent means available.
  const needsHost = !isPack && !!manifest.main && manifest.available === false;

  // README: fetch on demand; undefined = loading, null = not found, string = content
  const [readmeContent, setReadmeContent] = createSignal<string | null | undefined>(undefined);
  createEffect(() => {
    const { repoUrl } = props.entry;
    if (!repoUrl) { setReadmeContent(null); return; }
    const url = rawFileUrl(repoUrl, props.entry.item.folderPath, "README.md");
    if (!url) { setReadmeContent(null); return; }
    fetch(url, { cache: "no-cache" })
      .then(res => res.ok ? res.text() : null)
      .then(text => setReadmeContent(text))
      .catch(() => setReadmeContent(null));
  });

  // Available version tags — filter pre-release based on the repo's showPrerelease setting
  const availableTags = () => {
    const tags = props.entry.item.tags ?? [];
    if (!props.entry.repoUrl) return tags;
    const repo = registryRepos().find((r) => r.url === props.entry.repoUrl);
    const showPre = repo?.showPrerelease ?? false;
    return showPre ? tags : tags.filter((t) => !isPrerelease(t));
  };

  const [selectedVersion, setSelectedVersion] = createSignal(
    availableTags()[0] ?? manifest.version
  );

  // Live preview: when this is a colour theme + liveThemePreview is on, fetch + apply theme
  createEffect(() => {
    const isColorTheme = manifest.categories.includes("Color Theme");
    if (!isColorTheme || !liveThemePreview()) {
      setPreviewThemeDef(null);
      return;
    }
    const themeContrib = manifest.contributes?.themes?.[0];
    if (!themeContrib) { setPreviewThemeDef(null); return; }

    // Bundled themes are already in the registry
    if (!props.entry.repoUrl) {
      const existing = getThemeDef(themeContrib.id);
      setPreviewThemeDef(existing ?? null);
      return;
    }

    const url = rawFileUrl(props.entry.repoUrl, props.entry.item.folderPath, themeContrib.path);
    if (!url) { setPreviewThemeDef(null); return; }

    fetch(url, { cache: "no-cache" })
      .then((res) => res.ok ? res.json() : null)
      .then((def) => setPreviewThemeDef(def as ThemeDef | null))
      .catch(() => setPreviewThemeDef(null));
  });

  onCleanup(() => setPreviewThemeDef(null));

  // Developer mode: shown only when the source repo has developer mode enabled
  const isDeveloperMode = () => {
    if (!props.entry.repoUrl) return false;
    const repo = registryRepos().find((r) => r.url === props.entry.repoUrl);
    return repo?.developerMode ?? false;
  };

  const contribSummary = () => {
    const c = manifest.contributes ?? {};
    const lines: string[] = [];
    if (c.themes?.length)       lines.push(`${c.themes.length} colour theme${c.themes.length > 1 ? "s" : ""}`);
    if (c.iconThemes?.length)   lines.push(`${c.iconThemes.length} icon theme${c.iconThemes.length > 1 ? "s" : ""}`);
    if (c.uiIconPacks?.length)  lines.push(`${c.uiIconPacks.length} UI icon pack${c.uiIconPacks.length > 1 ? "s" : ""}`);
    if (c.lsp?.length)          lines.push(`${c.lsp.length} language server${c.lsp.length > 1 ? "s" : ""}`);
    if (c.dap?.length)          lines.push(`${c.dap.length} debugger${c.dap.length > 1 ? "s" : ""}`);
    if (c.taskAdapters?.length) lines.push(`${c.taskAdapters.length} task adapter${c.taskAdapters.length > 1 ? "s" : ""}`);
    if (c.panels?.length)       lines.push(`${c.panels.length} panel${c.panels.length > 1 ? "s" : ""}`);
    return lines;
  };

  const packResolved = () => (manifest.extensionPack ?? []).map((id) => ({
    id,
    entry: allEntries().find((e) => e.item.manifest.id === id) ?? null,
  }));

  const packAllInstalled = () => packResolved().every(
    ({ entry }) => entry && (entry.repoUrl === null || installedIds().has(entry.item.manifest.id))
  );

  // Flat list of all pack members including sub-pack members, with depth for visual indentation.
  const packMembersDeep = createMemo(() => {
    function resolve(ids: string[], depth: number): Array<{ id: string; entry: MarketplaceEntry | null; depth: number }> {
      const result: Array<{ id: string; entry: MarketplaceEntry | null; depth: number }> = [];
      for (const id of ids) {
        const entry = allEntries().find((e) => e.item.manifest.id === id) ?? null;
        result.push({ id, entry, depth });
        if (entry && (entry.item.manifest.extensionPack?.length ?? 0) > 0 && depth < 2) {
          result.push(...resolve(entry.item.manifest.extensionPack!, depth + 1));
        }
      }
      return result;
    }
    return resolve(manifest.extensionPack ?? [], 0);
  });

  // Packs/collections that declare this extension as a member
  const parentEntries = () => allEntries().filter(e => e.item.manifest.extensionPack?.includes(manifest.id));

  // "Apply theme" only if direct members actually carry theme contributes.
  // Collections' direct members are sub-packs with contributes:{} → some() = false.
  // This avoids depending on manifest.type (absent from old GitHub manifests) or packKind.
  const isThemePack = () => isPack && packResolved().some(({ entry }) => entry && (
    (entry.item.manifest.contributes?.themes?.length ?? 0) > 0 ||
    (entry.item.manifest.contributes?.iconThemes?.length ?? 0) > 0 ||
    (entry.item.manifest.contributes?.uiIconPacks?.length ?? 0) > 0
  ));

  function applyThemePack() {
    for (const { entry } of packResolved()) {
      if (!entry) continue;
      const c = entry.item.manifest.contributes;
      if (c?.themes?.[0])      setUiTheme(c.themes[0].id);
      if (c?.iconThemes?.[0])  setIconTheme(c.iconThemes[0].id);
      if (c?.uiIconPacks?.[0]) setUiPack(c.uiIconPacks[0].id);
    }
  }

  return (
    <div class="mkt-detail">

      {/* Top section: header + actions + description + preview — scrolls with the rest */}
      <div class="mkt-detail-fixed-top">
      <div class="mkt-detail-top">
        <div class="mkt-detail-icon">{CATEGORY_ICONS[manifest.categories[0]] ?? "◈"}</div>
        <div class="mkt-detail-head">
          <div class="mkt-detail-name">{manifest.name}</div>
          <div class="mkt-detail-pub-row">
            <span class="mkt-detail-pub">{manifest.publisher}</span>
            <Show when={availableTags().length > 1} fallback={<span class="mkt-detail-pub"> · v{manifest.version}</span>}>
              <select
                class="mkt-version-select"
                value={selectedVersion()}
                onChange={(e) => setSelectedVersion(e.currentTarget.value)}
              >
                <For each={availableTags()}>
                  {(tag) => <option value={tag}>{tag}</option>}
                </For>
              </select>
            </Show>
          </div>
          <div class="mkt-detail-cats">
            <For each={manifest.categories}>
              {(cat) => <span class="mkt-detail-cat">{cat}</span>}
            </For>
            <Show when={isBundled}>
              <span class="mkt-detail-cat mkt-detail-cat-bundled">Sindri Core</span>
            </Show>
          </div>
        </div>
      </div>

      <div class="mkt-detail-actions">
        <Show when={isBundled}>
          <div class="mkt-detail-bundled-note">Bundled with Sindri — always available</div>
        </Show>
        <Show when={!isBundled && !needsHost && !isPack && !installed()}>
          <button
            class="settings-btn-primary mkt-install-btn"
            disabled={props.installing}
            onClick={props.onInstall}
          >
            {props.installing ? "Installing…" : "Install"}
          </button>
        </Show>
        <Show when={!isBundled && !needsHost && !isPack && installed()}>
          <div class="mkt-installed-row">
            <span class="mkt-installed-label">✓ Installed</span>
            <Show when={updateAvailable()}>
              <button
                class="settings-btn-primary"
                disabled={props.installing}
                onClick={props.onInstall}
              >{props.installing ? "Updating…" : "Update"}</button>
            </Show>
            <button class="settings-btn-secondary" onClick={props.onUninstall}>Uninstall</button>
          </div>
        </Show>
        <Show when={!isBundled && isPack && !packAllInstalled()}>
          <button
            class="settings-btn-primary mkt-install-btn"
            disabled={props.installing}
            onClick={props.onInstall}
          >
            {props.installing ? "Installing pack…" : "Install Pack"}
          </button>
        </Show>
        <Show when={!isBundled && isPack && packAllInstalled()}>
          <div class="mkt-installed-row">
            <span class="mkt-installed-label">✓ Pack installed</span>
            <Show when={isThemePack()}>
              <button class="settings-btn-primary" onClick={applyThemePack}>Apply theme</button>
            </Show>
            <button class="settings-btn-secondary" onClick={props.onUninstall}>Remove</button>
          </div>
        </Show>
        <Show when={needsHost}>
          <div class="mkt-detail-host-note">
            Remote install coming soon — load a local build via{" "}
            <strong>Extensions &gt; Active Extension</strong>.
          </div>
        </Show>
        <Show when={props.installFailed}>
          <div class="mkt-install-error">
            Install failed — the extension bundle could not be downloaded. Check the browser console for details.
          </div>
        </Show>
        <Show when={manifest.bugs?.url || manifest.bugs?.email}>
          <a
            class="mkt-bugs-link"
            href={manifest.bugs!.url ?? `mailto:${manifest.bugs!.email}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Report issue
          </a>
        </Show>
      </div>

      <p class="mkt-detail-desc">{manifest.description}</p>
      <ThemePreview entry={props.entry} />
      <IconThemePreview entry={props.entry} />
      </div>{/* /mkt-detail-fixed-top */}

      <Show when={readmeContent() === undefined}>
        <div class="mkt-detail-readme mkt-detail-readme-empty" style={{ opacity: "0.45" }}>Loading…</div>
      </Show>
      <Show when={readmeContent() !== undefined && !!readmeContent()}>
        <div class="mkt-detail-readme" innerHTML={safeRenderMarkdown(readmeContent() as string)} />
      </Show>
      <Show when={readmeContent() !== undefined && !readmeContent()}>
        <div class="mkt-detail-readme mkt-detail-readme-empty">No description provided.</div>
      </Show>

      <div class="mkt-detail-meta">
        <Show when={isPack && packMembersDeep().length > 0}>
          <div class="mkt-detail-section">
            <div class="mkt-detail-section-label">Includes</div>
            <div class="mkt-pack-members">
              <For each={packMembersDeep()}>
                {({ id, entry, depth }) => {
                  const memberInstalled = () => entry && (entry.repoUrl === null || installedIds().has(id));
                  return (
                    <button
                      class={`mkt-pack-member${!entry ? " mkt-pack-member-missing" : ""}`}
                      style={depth > 0 ? { "padding-left": `${10 + depth * 18}px`, "border-left": "2px solid var(--border-subtle)" } : {}}
                      disabled={!entry}
                      onClick={() => entry && props.onNavigate(entry)}
                    >
                      <span class="mkt-pack-member-icon">
                        {entry ? (CATEGORY_ICONS[entry.item.manifest.categories[0]] ?? "◈") : "⚠"}
                      </span>
                      <span class="mkt-pack-member-name">
                        {entry ? entry.item.manifest.name : id}
                        <Show when={!entry}><span class="mkt-pack-member-unresolved"> (not found)</span></Show>
                      </span>
                      <Show when={entry}>
                        <span class="mkt-pack-member-version">v{entry!.item.manifest.version}</span>
                        <Show when={memberInstalled()}>
                          <span class="mkt-badge mkt-badge-installed" style={{ "font-size": "9px", padding: "1px 5px" }}>Installed</span>
                        </Show>
                      </Show>
                    </button>
                  );
                }}
              </For>
            </div>
          </div>
        </Show>

        <Show when={parentEntries().length > 0}>
          <div class="mkt-detail-section">
            <div class="mkt-detail-section-label">Included in</div>
            <div class="mkt-pack-members">
              <For each={parentEntries()}>
                {(parent) => (
                  <button
                    class="mkt-pack-member"
                    onClick={() => props.onNavigate(parent)}
                  >
                    <span class="mkt-pack-member-icon">{CATEGORY_ICONS[parent.item.manifest.categories[0]] ?? "◈"}</span>
                    <span class="mkt-pack-member-name">{parent.item.manifest.name}</span>
                    <span class="mkt-pack-member-version">v{parent.item.manifest.version}</span>
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>

        {/* Contributes section: only shown in developer mode — end users don't need raw contribution metadata */}
        <Show when={isDeveloperMode() && contribSummary().length > 0}>
          <div class="mkt-detail-section">
            <div class="mkt-detail-section-label">Contributes <span class="mkt-devmode-tag">dev</span></div>
            <ul class="mkt-detail-contrib-list">
              <For each={contribSummary()}>{(line) => <li>{line}</li>}</For>
            </ul>
          </div>
        </Show>

        <Show when={manifest.languages?.length}>
          <div class="mkt-detail-section">
            <div class="mkt-detail-section-label">Languages</div>
            <div class="mkt-detail-tags">
              <For each={manifest.languages}>{(l) => <span class="mkt-detail-tag">{l}</span>}</For>
            </div>
          </div>
        </Show>

        <Show when={manifest.tags?.length}>
          <div class="mkt-detail-section">
            <div class="mkt-detail-section-label">Tags</div>
            <div class="mkt-detail-tags">
              <For each={manifest.tags}>{(t) => <span class="mkt-detail-tag">{t}</span>}</For>
            </div>
          </div>
        </Show>

        <div class="mkt-detail-section">
          <div class="mkt-detail-section-label">Permissions</div>
          <Show
            when={(manifest.permissions ?? []).length > 0}
            fallback={<p class="mkt-detail-none">None</p>}
          >
            <div class="mkt-detail-perms">
              <For each={manifest.permissions}>{(p) => <code class="mkt-detail-perm">{p}</code>}</For>
            </div>
          </Show>
        </div>

        <Show when={manifest.license || (manifest.credits && manifest.credits.length > 0)}>
          <div class="mkt-detail-section">
            <div class="mkt-detail-section-label">Credits &amp; Licenses</div>
            <Show when={manifest.license}>
              <div class="mkt-detail-license-row">
                <span class="mkt-detail-license-label">Extension license</span>
                <code class="mkt-detail-spdx">{manifest.license}</code>
              </div>
            </Show>
            <Show when={manifest.credits?.length}>
              <div class="mkt-detail-credits">
                <For each={manifest.credits}>
                  {(credit) => (
                    <div class="mkt-detail-credit">
                      <div class="mkt-detail-credit-header">
                        <Show when={credit.url} fallback={<span class="mkt-detail-credit-name">{credit.name}</span>}>
                          <a class="mkt-detail-credit-name mkt-detail-credit-link" href={credit.url} target="_blank" rel="noreferrer">{credit.name}</a>
                        </Show>
                        <Show when={credit.spdx}>
                          <code class="mkt-detail-spdx">{credit.spdx}</code>
                        </Show>
                      </div>
                      <Show when={credit.notice}>
                        <p class="mkt-detail-credit-notice">{credit.notice}</p>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
}
