// Plain JS reference to the current editor ThemeDef — NOT a SolidJS reactive value.
// Used by buildEditorState() to build a fresh CM6 extension every time a new
// EditorView is created, guaranteeing the editor always has a theme regardless
// of applyTheme() timing. Not a proxy, so CM6 reads are always plain strings.
import type { ThemeDef } from "./tokens";

let _current: ThemeDef | null = null;

export function setCurrentThemeDef(def: ThemeDef): void {
  _current = def;
}

export function getCurrentThemeDef(): ThemeDef | null {
  return _current;
}
