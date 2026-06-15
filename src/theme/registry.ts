// Theme + icon-theme registry (ADR-0019).
//
// DATA STORAGE: plain Maps — never SolidJS proxies.
//   theme/icon data is read by buildCM6Extension() which runs outside any reactive
//   context; a SolidJS proxy outside a reactive root can silently return stale
//   values on some access patterns. Plain Maps are synchronous and unconditional.
//
// REACTIVITY: createSignal lists power the ThemeBar UI.
//   Only the selection state and the "list of registered X" are reactive.
//   Everything that runs CM6 code uses the plain Maps directly.
import { createSignal } from "solid-js";
import type { ThemeDef, IconThemeDef, UiIconPackDef } from "./tokens";
import { buildCM6Extension } from "../editor/theme";
import { themeCompartment, setCurrentCM6Extension } from "./compartment";
import { setCurrentThemeDef } from "./current-theme";
import { getAllEditorViews } from "../editor/groups";
import { emit as configEmit } from "../workbench/settings/configStore";

// ---------------------------------------------------------------------------
// Plain Map registries — the source of truth for all build/apply code
// ---------------------------------------------------------------------------

const _themes     = new Map<string, ThemeDef>();
const _iconThemes = new Map<string, IconThemeDef>();
const _uiPacks    = new Map<string, UiIconPackDef>();

// ---------------------------------------------------------------------------
// Reactive lists — for ThemeBar <select> / <For> loops only
// ---------------------------------------------------------------------------

const [_themeList,     _setThemeList]     = createSignal<ThemeDef[]>([]);
const [_iconThemeList, _setIconThemeList] = createSignal<IconThemeDef[]>([]);
const [_uiPackList,    _setUiPackList]    = createSignal<UiIconPackDef[]>([]);

export const themeList     = _themeList;
export const iconThemeList = _iconThemeList;
export const uiPackList    = _uiPackList;

// ---------------------------------------------------------------------------
// Selection state (two theme slots + link flag per ADR-0019 §3)
// ---------------------------------------------------------------------------

const STORAGE_KEY = "sindri:theme";

interface PersistedSelection {
  uiThemeId:         string;
  editorThemeId:     string;
  linkEditorToUi:    boolean;
  iconThemeId:       string;
  uiPackId:          string;
  preferredThemeKind: "dark" | "light"; // persisted so fallback can match the user's kind preference
}

function loadPersistedSelection(): Partial<PersistedSelection> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<PersistedSelection>) : {};
  } catch {
    return {};
  }
}

const saved = loadPersistedSelection();
export const [uiThemeId,           setUiThemeId]           = createSignal<string>(saved.uiThemeId           ?? "sindri-dark");
export const [editorThemeId,       setEditorThemeId]       = createSignal<string>(saved.editorThemeId       ?? "sindri-dark");
export const [linkEditorToUi,      setLinkEditorToUi]      = createSignal<boolean>(saved.linkEditorToUi     ?? true);
export const [iconThemeId,         setIconThemeId]         = createSignal<string>(saved.iconThemeId         ?? "sindri-file-icons");
export const [uiPackId,            setUiPackId]            = createSignal<string>(saved.uiPackId            ?? "sindri-ui-icons");
export const [preferredThemeKind,  setPreferredThemeKind]  = createSignal<"dark" | "light">(saved.preferredThemeKind ?? "dark");

function persistSelection(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      uiThemeId:          uiThemeId(),
      editorThemeId:      editorThemeId(),
      linkEditorToUi:     linkEditorToUi(),
      iconThemeId:        iconThemeId(),
      uiPackId:           uiPackId(),
      preferredThemeKind: preferredThemeKind(),
    }));
  } catch { /* storage unavailable */ }
}

// ---------------------------------------------------------------------------
// Registration — stores in plain Maps + updates reactive lists
// ---------------------------------------------------------------------------

export function registerTheme(def: ThemeDef): void {
  _themes.set(def.id, def);
  _setThemeList([..._themes.values()]);
}

export function unregisterTheme(id: string): void {
  if (!_themes.has(id)) return;
  _themes.delete(id);
  _setThemeList([..._themes.values()]);
  // If the removed theme was active, fall back to the first available theme
  if (uiThemeId() === id || editorThemeId() === id) {
    const fallback = [..._themes.keys()][0];
    if (fallback) { setUiTheme(fallback); }
  }
}

export function registerIconTheme(def: IconThemeDef): void {
  _iconThemes.set(def.id, def);
  _setIconThemeList([..._iconThemes.values()]);
}

export function unregisterIconTheme(id: string): void {
  if (!_iconThemes.has(id)) return;
  _iconThemes.delete(id);
  _setIconThemeList([..._iconThemes.values()]);
  if (iconThemeId() === id) {
    const fallback = [..._iconThemes.keys()][0];
    if (fallback) setIconTheme(fallback);
  }
}

export function registerUiIconPack(def: UiIconPackDef): void {
  _uiPacks.set(def.id, def);
  _setUiPackList([..._uiPacks.values()]);
}

export function unregisterUiIconPack(id: string): void {
  if (!_uiPacks.has(id)) return;
  _uiPacks.delete(id);
  _setUiPackList([..._uiPacks.values()]);
  if (uiPackId() === id) {
    const fallback = [..._uiPacks.keys()][0];
    if (fallback) setUiPack(fallback);
  }
}

export function getThemeDef(id: string): ThemeDef | undefined {
  return _themes.get(id);
}

// ---------------------------------------------------------------------------
// Apply — reads directly from Maps (no proxy, always plain objects)
// ---------------------------------------------------------------------------

// Validate persisted selections — fall back to first registered option if the stored
// ID is no longer in the registry (e.g. an installed extension was removed or hasn't
// finished re-registering yet). Call after each rehydration pass.
export function validateSelections(): void {
  if (!_iconThemes.has(iconThemeId())) {
    const first = [..._iconThemes.keys()][0];
    if (first) { setIconThemeId(first); persistSelection(); }
  }
  if (!_uiPacks.has(uiPackId())) {
    const first = [..._uiPacks.keys()][0];
    if (first) { setUiPackId(first); persistSelection(); }
  }
}

export function applyTheme(): void {
  let uiDef = _themes.get(uiThemeId());
  // Fall back: prefer a theme of the same dark/light kind the user had before
  if (!uiDef) {
    const kind = preferredThemeKind();
    const kindMatch = [..._themes.values()].find((t) => t.kind === kind);
    const fallback = kindMatch ?? [..._themes.values()][0];
    if (!fallback) return;
    setUiThemeId(fallback.id);
    persistSelection();
    uiDef = fallback;
  }

  // Editor theme: follow UI when linked; fall back to same-kind theme when stored ID is unavailable
  const storedEditorDef = _themes.get(editorThemeId());
  const editorFallback = storedEditorDef
    ?? [..._themes.values()].find((t) => t.kind === uiDef.kind)
    ?? uiDef;
  const editorDef = linkEditorToUi() ? uiDef : editorFallback;

  // 1. CSS custom properties on :root
  const root = document.documentElement;
  root.setAttribute("data-theme-kind", uiDef.kind);
  for (const [token, value] of Object.entries(uiDef.ui))   root.style.setProperty(token, value);
  for (const [token, value] of Object.entries(uiDef.glow)) root.style.setProperty(token, value);

  // 1b. Icon theme CSS variable overrides (ADR-0032 template variables).
  // A dedicated <style> element is used so switching away from a child theme
  // cleanly removes the previous overrides rather than leaving stale inline vars.
  const ICON_VARS_ID = "sindri-icon-theme-vars";
  const iconDef = _iconThemes.get(iconThemeId());
  const iconVarsEl = document.getElementById(ICON_VARS_ID);
  if (iconDef?.cssVars && Object.keys(iconDef.cssVars).length > 0) {
    const css = `:root{${Object.entries(iconDef.cssVars).map(([k, v]) => `${k}:${v}`).join(";")}}`;
    if (iconVarsEl) {
      iconVarsEl.textContent = css;
    } else {
      const style = document.createElement("style");
      style.id = ICON_VARS_ID;
      style.textContent = css;
      document.head.appendChild(style);
    }
  } else {
    iconVarsEl?.remove();
  }

  // 2. Build CM6 extension from the plain Map value — guaranteed no proxy
  setCurrentThemeDef(editorDef);
  const ext = buildCM6Extension(editorDef);
  setCurrentCM6Extension(ext);

  // 3. Reconfigure any already-open EditorViews
  for (const view of getAllEditorViews()) {
    view.dispatch({ effects: themeCompartment.reconfigure(ext) });
  }

  // 4. Notify decoration-registry so rainbow brackets rebuild with the new palette.
  configEmit(["_editorTheme"]);
}

// ---------------------------------------------------------------------------
// Setters — persist + re-apply
// ---------------------------------------------------------------------------

export function setUiTheme(id: string): void {
  setUiThemeId(id);
  // Record kind so fallback can match it after reload
  const def = _themes.get(id);
  if (def) setPreferredThemeKind(def.kind);
  persistSelection();
  applyTheme();
}

export function setEditorTheme(id: string): void {
  setEditorThemeId(id);
  persistSelection();
  applyTheme();
}

export function setLinkEditorToUiTheme(linked: boolean): void {
  // Never overwrite editorThemeId — it tracks the user's independent preference,
  // which is preserved even while the editor is following the UI theme.
  setLinkEditorToUi(linked);
  persistSelection();
  applyTheme();
}

export function setIconTheme(id: string): void {
  setIconThemeId(id);
  persistSelection();
}

export function setUiPack(id: string): void {
  setUiPackId(id);
  persistSelection();
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

export function activeIconTheme(): IconThemeDef | undefined {
  return _iconThemes.get(iconThemeId());
}

export function activeUiIconPack(): UiIconPackDef | undefined {
  return _uiPacks.get(uiPackId());
}
