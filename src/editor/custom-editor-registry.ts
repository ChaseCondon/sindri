// ADR-0028 — custom editor registration registry.
// Stores registrations from extension manifests + runtime registerEditor calls.
// Provides matching helpers for default-editor routing and "Open With…".

export interface CustomEditorRegistration {
  viewType: string;
  displayName: string;
  selector: Array<{ scheme?: string; language?: string; pattern?: string }>;
  priority: "default" | "option";
  extId: string;
}

const _registrations: CustomEditorRegistration[] = [];

export function addCustomEditorRegistration(reg: CustomEditorRegistration): void {
  const idx = _registrations.findIndex((r) => r.viewType === reg.viewType);
  if (idx >= 0) _registrations.splice(idx, 1);
  _registrations.push(reg);
}

export function getCustomEditorRegistrations(): readonly CustomEditorRegistration[] {
  return _registrations;
}

/** First default-priority match for a path — used for plain open routing. */
export function matchDefaultCustomEditor(path: string): CustomEditorRegistration | null {
  const name = basename(path);
  for (const reg of _registrations) {
    if (reg.priority !== "default") continue;
    if (_selectorMatches(reg.selector, path, name)) return reg;
  }
  return null;
}

/** All matching registrations (any priority) — used for "Open With…" list. */
/** Remove all registrations contributed by a given extension (called on uninstall). */
export function removeCustomEditorRegistrationsByExtId(extId: string): void {
  const before = _registrations.length;
  _registrations.splice(0, _registrations.length, ..._registrations.filter(r => r.extId !== extId));
  if (_registrations.length !== before) {
    console.log(`[sindri] removed ${before - _registrations.length} customEditor registration(s) for extId=${extId}`);
  }
}

export function matchAllCustomEditors(path: string): CustomEditorRegistration[] {
  const name = basename(path);
  return _registrations.filter((reg) => _selectorMatches(reg.selector, path, name));
}

function basename(p: string): string {
  return p.split(/[/\\]/).pop() ?? p;
}

function _selectorMatches(
  selectors: Array<{ scheme?: string; language?: string; pattern?: string }>,
  path: string,
  name: string,
): boolean {
  for (const sel of selectors) {
    if (sel.pattern && _globMatch(sel.pattern, name)) return true;
    if (sel.language && _langId(name) === sel.language) return true;
    if (sel.scheme) {
      const scheme = path.includes("://") ? path.split("://")[0] : "file";
      if (scheme === sel.scheme) return true;
    }
  }
  return false;
}

function _globMatch(pattern: string, name: string): boolean {
  const re = new RegExp(
    "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "$",
    "i",
  );
  return re.test(name);
}

function _langId(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "js": case "jsx": case "mjs": case "cjs": return "javascript";
    case "ts": case "tsx": return "typescript";
    case "py": case "pyw": return "python";
    case "rs": return "rust";
    case "json": case "jsonc": return "json";
    case "html": case "htm": return "html";
    case "css": case "scss": case "less": return "css";
    case "md": case "mdx": return "markdown";
    case "cpp": case "cc": case "cxx": case "h": case "hpp": return "cpp";
    case "c": return "c";
    case "java": return "java";
    case "go": return "go";
    default: return "plaintext";
  }
}
