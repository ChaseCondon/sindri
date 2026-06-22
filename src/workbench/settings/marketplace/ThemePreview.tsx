// Theme preview block — language dropdown + syntax-coloured code preview.
import { createSignal, createEffect, For, Show } from "solid-js";
import type { ThemeDef } from "../../../theme/tokens";
import { rawFileUrl } from "../../../extensions/registry-client";
import { getThemeDef } from "../../../theme/registry";
import type { MarketplaceEntry } from "./store";
import { tokenise, type TokenKind } from "./markdown";

// ---------------------------------------------------------------------------
// Default preview code — used when a colour theme has no explicit previews
// ---------------------------------------------------------------------------

const DEFAULT_PREVIEW: Record<string, string> = {
  TypeScript: `interface User {\n  id: string;\n  name: string;\n  role: "admin" | "viewer";\n}\n\nasync function getUser(id: string): Promise<User> {\n  const res = await fetch(\`/api/users/\${id}\`);\n  if (!res.ok) throw new Error(\`HTTP \${res.status}\`);\n  return res.json() as Promise<User>;\n}`,
  JavaScript: `const CACHE_TTL = 5 * 60 * 1000;\n\nclass RegistryClient {\n  #cache = new Map();\n\n  async fetchIndex(repoUrl) {\n    const cached = this.#cache.get(repoUrl);\n    if (cached && Date.now() - cached.ts < CACHE_TTL) {\n      return cached.data;\n    }\n    const res = await fetch(\`\${toRawBase(repoUrl)}/index.json\`);\n    if (!res.ok) return null;\n    const data = await res.json();\n    this.#cache.set(repoUrl, { data, ts: Date.now() });\n    return data;\n  }\n}`,
  Rust: `use std::collections::HashMap;\n\n#[derive(Debug, Clone)]\npub struct Registry<T> {\n    entries: HashMap<String, T>,\n}\n\nimpl<T: Clone> Registry<T> {\n    pub fn new() -> Self {\n        Self { entries: HashMap::new() }\n    }\n\n    pub fn register(&mut self, id: impl Into<String>, value: T) {\n        self.entries.insert(id.into(), value);\n    }\n\n    pub fn get(&self, id: &str) -> Option<&T> {\n        self.entries.get(id)\n    }\n}`,
  Python: `from dataclasses import dataclass, field\n\n@dataclass\nclass Extension:\n    id: str\n    name: str\n    version: str\n    installed: bool = False\n    tags: list[str] = field(default_factory=list)\n\n    def matches(self, query: str) -> bool:\n        q = query.lower()\n        return q in self.name.lower() or any(q in t for t in self.tags)\n\n    def install(self) -> None:\n        if self.installed:\n            raise ValueError(f"{self.name!r} is already installed")\n        self.installed = True`,
  Go: `package registry\n\nimport "sync"\n\ntype Registry[T any] struct {\n    mu      sync.RWMutex\n    entries map[string]T\n}\n\nfunc New[T any]() *Registry[T] {\n    return &Registry[T]{entries: make(map[string]T)}\n}\n\nfunc (r *Registry[T]) Register(id string, value T) {\n    r.mu.Lock()\n    defer r.mu.Unlock()\n    r.entries[id] = value\n}\n\nfunc (r *Registry[T]) Get(id string) (T, bool) {\n    r.mu.RLock()\n    defer r.mu.RUnlock()\n    v, ok := r.entries[id]\n    return v, ok\n}`,
  Java: `import java.util.HashMap;\nimport java.util.Map;\nimport java.util.Optional;\n\npublic class Registry<T> {\n    private final Map<String, T> entries = new HashMap<>();\n\n    public void register(String id, T value) {\n        if (entries.containsKey(id)) {\n            throw new IllegalStateException("Already registered: " + id);\n        }\n        entries.put(id, value);\n    }\n\n    public Optional<T> get(String id) {\n        return Optional.ofNullable(entries.get(id));\n    }\n\n    public boolean isRegistered(String id) {\n        return entries.containsKey(id);\n    }\n}`,
  JSON: `{\n  "$schema": "../manifest.schema.json",\n  "id": "yourname.my-theme",\n  "name": "My Theme",\n  "version": "1.0.0",\n  "publisher": "yourname",\n  "categories": ["Color Theme"],\n  "permissions": [],\n  "engines": { "sindri": ">=0.1.0" },\n  "contributes": {\n    "themes": [\n      {\n        "id": "my-theme-dark",\n        "name": "My Theme Dark",\n        "kind": "dark",\n        "path": "dark.json"\n      }\n    ]\n  }\n}`,
  XML: `<?xml version="1.0" encoding="UTF-8"?>\n<project xmlns="http://maven.apache.org/POM/4.0.0">\n  <modelVersion>4.0.0</modelVersion>\n  <groupId>com.example</groupId>\n  <artifactId>sindri-extension</artifactId>\n  <version>1.0.0</version>\n\n  <dependencies>\n    <dependency>\n      <groupId>org.junit.jupiter</groupId>\n      <artifactId>junit-jupiter</artifactId>\n      <version>5.10.0</version>\n      <scope>test</scope>\n    </dependency>\n  </dependencies>\n</project>`,
  HTML: `<!DOCTYPE html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>Sindri Extension</title>\n    <link rel="stylesheet" href="styles.css" />\n  </head>\n  <body>\n    <div class="container" id="app">\n      <h1 class="title">Hello, Sindri</h1>\n      <p class="subtitle">A human-first IDE</p>\n      <button class="btn-primary" onclick="greet()">Click me</button>\n    </div>\n    <script type="module" src="main.js"></script>\n  </body>\n</html>`,
  Kotlin: `import kotlinx.coroutines.*\n\ndata class Extension(\n    val id: String,\n    val name: String,\n    val version: String,\n    val installed: Boolean = false,\n)\n\nclass Registry<T : Any> {\n    private val entries = mutableMapOf<String, T>()\n\n    fun register(id: String, value: T) {\n        check(id !in entries) { "Already registered: $id" }\n        entries[id] = value\n    }\n\n    fun get(id: String): T? = entries[id]\n\n    suspend fun loadAsync(id: String, loader: suspend () -> T): T =\n        withContext(Dispatchers.IO) { loader().also { register(id, it) } }\n}`,
  Svelte: `<script lang="ts">\n  let name = $state("World");\n  let count = $state(0);\n  let doubled = $derived(count * 2);\n\n  function greet() {\n    count++;\n  }\n<\/script>\n\n<main>\n  <h1>Hello, {name}!</h1>\n  <p>Clicked {count} times &mdash; doubled: {doubled}</p>\n  <button onclick={greet}>Click me</button>\n  {#if count > 5}\n    <p class="note">You really like clicking.</p>\n  {/if}\n</main>\n\n<style>\n  main { font-family: sans-serif; padding: 2rem; }\n  h1   { color: var(--accent); margin-bottom: 0.5rem; }\n  .note { opacity: 0.6; font-style: italic; }\n<\/style>`,
};

// Canonical order — web (TS/JS/Svelte/HTML), systems (Rust/Go), scripting (Python), JVM (Java/Kotlin), data (JSON/XML)
const DEFAULT_PREVIEW_LANGS = ["TypeScript", "JavaScript", "Svelte", "HTML", "Rust", "Go", "Python", "Java", "Kotlin", "JSON", "XML"];

const PREVIEW_LANGUAGES = ["TypeScript", "JavaScript", "Svelte", "HTML", "Rust", "Go", "Python", "Java", "Kotlin", "JSON", "XML"];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ThemePreview(props: { entry: MarketplaceEntry }) {
  const themes = () => props.entry.item.manifest.contributes?.themes ?? [];
  const isColorTheme = () => props.entry.item.manifest.categories.includes("Color Theme");
  // Always show preview for colour themes; show for others only if previews are defined
  const hasPreview = () => isColorTheme() && themes().length > 0;

  const [activeLang, setActiveLang] = createSignal(PREVIEW_LANGUAGES[0]);
  const [themeDef, setThemeDef] = createSignal<ThemeDef | null>(null);
  const [loading, setLoading] = createSignal(false);

  const loadTheme = async () => {
    const t = themes()[0];
    if (!t) return;

    // Bundled themes are already in the registry — use them directly (no network needed)
    if (!props.entry.repoUrl) {
      const existing = getThemeDef(t.id);
      if (existing) setThemeDef(existing);
      return;
    }

    setLoading(true);
    try {
      const url = rawFileUrl(props.entry.repoUrl, props.entry.item.folderPath, t.path);
      if (!url) return;
      const res = await fetch(url, { cache: "no-cache" });
      if (res.ok) setThemeDef(await res.json() as ThemeDef);
    } catch { /* preview unavailable */ }
    setLoading(false);
  };

  let fetched = false;
  createEffect(() => {
    if (!fetched && hasPreview()) { fetched = true; loadTheme(); }
  });

  const previewCode = () => {
    const lang = activeLang();
    // Try manifest-defined previews first
    for (const t of themes()) {
      if (t.previews?.[lang]) return t.previews[lang];
    }
    // Fallback to first available manifest preview language
    for (const t of themes()) {
      if (t.previews) {
        const first = Object.entries(t.previews)[0];
        if (first) { setActiveLang(first[0]); return first[1]; }
      }
    }
    // Final fallback: built-in default snippets
    const defaultCode = DEFAULT_PREVIEW[lang];
    if (defaultCode) return defaultCode;
    const firstDefault = DEFAULT_PREVIEW_LANGS[0];
    setActiveLang(firstDefault);
    return DEFAULT_PREVIEW[firstDefault] ?? "";
  };

  const availableLangs = () => {
    // Prefer manifest-declared languages; fall back to defaults for colour themes
    const langs: string[] = [];
    for (const t of themes()) {
      for (const lang of Object.keys(t.previews ?? {})) {
        if (!langs.includes(lang)) langs.push(lang);
      }
    }
    return langs.length > 0 ? langs : (isColorTheme() ? DEFAULT_PREVIEW_LANGS : []);
  };

  const def = () => themeDef();

  const previewStyle = () => {
    const d = def();
    if (!d) return {};
    return { background: d.editor.bg, color: d.editor.fg };
  };

  const tokenColor = (kind: TokenKind): string => {
    const d = def();
    if (!d) return "";
    const s = d.syntax;
    switch (kind) {
      case "keyword":  return s.keyword?.color ?? s.controlKeyword?.color ?? "";
      case "string":   return s.string?.color ?? "";
      case "number":   return s.number?.color ?? "";
      case "comment":  return s.comment?.color ?? "";
      case "type":     return s.type?.color ?? "";
      case "fn":       return s.function?.color ?? "";
      default:         return d.editor.fg;
    }
  };

  return (
    <Show when={hasPreview()}>
      <div class="mkt-preview-block">
        <div class="mkt-preview-header">
          <span class="mkt-preview-label">Preview</span>
          <div class="mkt-preview-langs">
            <For each={availableLangs()}>
              {(lang) => (
                <button
                  class={`mkt-preview-lang${activeLang() === lang ? " active" : ""}`}
                  onClick={() => setActiveLang(lang)}
                >{lang}</button>
              )}
            </For>
          </div>
          <Show when={loading()}>
            <span class="mkt-preview-loading">loading colours…</span>
          </Show>
        </div>
        <pre class="mkt-preview-code" style={previewStyle()}>
          <Show when={def()} fallback={<code style={{ color: "var(--text-dim)" }}>{previewCode()}</code>}>
            <code>
              <For each={tokenise(previewCode(), activeLang())}>
                {(tok) => (
                  <span style={{ color: tokenColor(tok.kind) || undefined }}>{tok.text}</span>
                )}
              </For>
            </code>
          </Show>
        </pre>
      </div>
    </Show>
  );
}
