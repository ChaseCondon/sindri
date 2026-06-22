// Icon theme grid previewer — 1.5p
// Fetches icons.json at preview time (no install needed). Shows a searchable
// grid of representative icons: folders first, then file types by priority.
// Handles ADR-0032 inheritance (redirects to base's icons.json).
import { createSignal, createEffect, For, Show } from "solid-js";
import { rawFileUrl } from "../../../extensions/registry-client";
import { allEntries, type MarketplaceEntry } from "./store";

interface IconsJsonRaw {
  defaults: { file: string; folder: string; folderOpen: string };
  fileExtensions?: Record<string, string>;
  fileNames?: Record<string, string>;
  folderNames?: Record<string, string>;
  folderNamesExpanded?: Record<string, string>;
  icons: Record<string, { svg?: string; path?: string }>;
}

interface IconCell {
  label: string;
  iconUrl: string;
  kind: "folder" | "file";
}

const FILE_EXT_PRIORITY = ["ts", "tsx", "js", "jsx", "rs", "go", "py", "java", "kt", "cs", "cpp", "c", "rb", "php", "swift", "json", "toml", "yaml", "yml", "md", "css", "scss", "html", "svg", "sh"];

function buildIconGrid(raw: IconsJsonRaw, basePath: string): IconCell[] {
  function svgUrl(iconId: string): string | null {
    const src = raw.icons[iconId];
    if (!src) return null;
    if (src.svg) return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(src.svg)}`;
    if (src.path) return `${basePath}${src.path}`;
    return null;
  }

  const cells: IconCell[] = [];
  const seenIds = new Set<string>();

  function add(label: string, iconId: string, kind: "folder" | "file") {
    if (seenIds.has(iconId)) return;
    const url = svgUrl(iconId);
    if (!url) return;
    seenIds.add(iconId);
    cells.push({ label, iconUrl: url, kind });
  }

  // Defaults always shown first
  add("folder", raw.defaults.folder, "folder");
  add("folder-open", raw.defaults.folderOpen, "folder");
  add("file", raw.defaults.file, "file");

  // Named folder types (closed then open variants)
  for (const [name, id] of Object.entries(raw.folderNames ?? {})) add(name, id, "folder");
  for (const [name, id] of Object.entries(raw.folderNamesExpanded ?? {})) add(`${name} ▸`, id, "folder");

  // Prioritised file extensions first
  const extMap = raw.fileExtensions ?? {};
  for (const ext of FILE_EXT_PRIORITY) {
    if (extMap[ext]) add(`.${ext}`, extMap[ext], "file");
  }
  // Remaining extensions in alphabetical order
  for (const [ext, id] of Object.entries(extMap).sort(([a], [b]) => a.localeCompare(b))) {
    add(`.${ext}`, id, "file");
  }
  // File names (e.g. .gitignore, package.json)
  for (const [name, id] of Object.entries(raw.fileNames ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    add(name, id, "file");
  }

  return cells;
}

export function IconThemePreview(props: { entry: MarketplaceEntry }) {
  const iconThemes = () => props.entry.item.manifest.contributes?.iconThemes ?? [];
  const isIconTheme = () => iconThemes().length > 0;

  const [search, setSearch] = createSignal("");
  const [cells, setCells] = createSignal<IconCell[]>([]);
  const [loading, setLoading] = createSignal(false);

  let fetched = false;
  createEffect(() => {
    if (!fetched && isIconTheme()) { fetched = true; void loadIcons(); }
  });

  async function loadIcons() {
    const contrib = iconThemes()[0];
    if (!contrib) return;
    const { repoUrl, item } = props.entry;

    // Bundled icon themes are already active; skip the preview fetch.
    if (!repoUrl) return;

    // ADR-0032: if this theme inherits, redirect to the base's icons.json.
    let iconJsonUrl = rawFileUrl(repoUrl, item.folderPath, contrib.path);
    if (item.manifest.extends) {
      const baseEntry = allEntries().find(e => e.item.manifest.id === item.manifest.extends);
      if (baseEntry?.repoUrl) {
        const basePath = baseEntry.item.manifest.contributes?.iconThemes?.[0]?.path ?? "icons.json";
        iconJsonUrl = rawFileUrl(baseEntry.repoUrl, baseEntry.item.folderPath, basePath) ?? iconJsonUrl;
      }
    }
    if (!iconJsonUrl) return;

    setLoading(true);
    try {
      const res = await fetch(iconJsonUrl, { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json() as IconsJsonRaw;
      const base = iconJsonUrl.substring(0, iconJsonUrl.lastIndexOf("/") + 1);
      setCells(buildIconGrid(raw, base));
    } catch { /* preview unavailable */ }
    setLoading(false);
  }

  const filtered = () => {
    const q = search().toLowerCase().trim();
    if (!q) return cells();
    return cells().filter(c => c.label.toLowerCase().includes(q));
  };

  return (
    <Show when={isIconTheme()}>
      <div class="mkt-preview-block">
        <div class="mkt-preview-header">
          <span class="mkt-preview-label">Icons</span>
          <input
            class="mkt-icon-search"
            type="search"
            placeholder="Filter icons…"
            value={search()}
            onInput={(e) => setSearch(e.currentTarget.value)}
          />
          <Show when={loading()}>
            <span class="mkt-preview-loading">loading…</span>
          </Show>
        </div>
        <Show when={cells().length > 0}>
          <div class="mkt-icon-grid">
            <For each={filtered()}>
              {(cell) => (
                <div class="mkt-icon-cell">
                  <img class="mkt-icon-img" src={cell.iconUrl} alt={cell.label} loading="lazy" />
                  <span class="mkt-icon-label">{cell.label}</span>
                </div>
              )}
            </For>
            <Show when={filtered().length === 0 && !!search()}>
              <div class="mkt-icon-empty">No icons match "{search()}"</div>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  );
}
