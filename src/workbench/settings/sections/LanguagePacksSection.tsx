export function LanguagePacksSection(props: { onBrowse: () => void }) {
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
