import { createStore, produce } from "solid-js/store";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { buildDecorationCompartmentExts } from "./decoration-registry";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { go } from "@codemirror/lang-go";
import { themeCompartment } from "../theme/compartment";
import { getCurrentThemeDef } from "../theme/current-theme";
import { buildCM6Extension } from "./theme";

export interface BufferMeta {
  id: string;
  path: string | null;
  name: string;
  dirty: boolean;
}

interface BufferRegistry {
  buffers: Record<string, BufferMeta>;
}

const [registry, setRegistry] = createStore<BufferRegistry>({ buffers: {} });
export { registry };

// Occurrence key: "${groupId}\0${bufferId}" — one EditorState per (group, buffer) pair.
export const occKey = (groupId: string, bufferId: string): string => `${groupId}\0${bufferId}`;

// Plain Maps — never proxied by Solid's reactive system.
// editorStates and scrollTops are keyed by occurrence key; savedTexts by bufferId.
export const editorStates = new Map<string, EditorState>();
export const savedTexts = new Map<string, string>();
export const scrollTops = new Map<string, number>();

let _saveHandler: (() => void) | null = null;
export function registerSaveHandler(fn: () => void): void {
  _saveHandler = fn;
}

let _counter = 0;
export function freshBufferId(): string {
  return `untitled:${++_counter}`;
}

export function languageFor(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "js":   return javascript({ jsx: true });
    case "jsx":  return javascript({ jsx: true });
    case "ts":   return javascript({ typescript: true });
    case "tsx":  return javascript({ typescript: true, jsx: true });
    case "mjs":
    case "cjs":  return javascript();
    case "py":
    case "pyw":  return python();
    case "rs":   return rust();
    case "json":
    case "jsonc": return json();
    case "html":
    case "htm":  return html();
    case "css":
    case "scss":
    case "less": return css();
    case "md":
    case "mdx":  return markdown();
    case "cpp":
    case "cc":
    case "cxx":
    case "c":
    case "h":
    case "hpp":  return cpp();
    case "java": return java();
    case "go":   return go();
    default:     return [];
  }
}

// bufferId is captured in the closure so the listener marks the *right* buffer
// dirty without consulting a global activeId (ADR-0018 §2 decision 1).
export function buildEditorState(bufferId: string, doc: string, name: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      drawSelection(),
      rectangularSelection(),
      history(),
      indentOnInput(),
      bracketMatching(),
      ...buildDecorationCompartmentExts(),
      languageFor(name),
      // Build extension fresh from the plain ThemeDef reference — never from a
      // SolidJS proxy and never dependent on applyTheme() having run first.
      themeCompartment.of(
        (() => { const d = getCurrentThemeDef(); return d ? buildCM6Extension(d) : []; })()
      ),
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => { _saveHandler?.(); return true; },
        },
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.transactions.length === 0) return;
        if (!u.docChanged) return;
        const saved = savedTexts.get(bufferId) ?? "";
        const isDirty = u.state.doc.toString() !== saved;
        const buf = registry.buffers[bufferId];
        if (buf && buf.dirty !== isDirty) setBufferDirty(bufferId, isDirty);
      }),
    ],
  });
}

// ---------------------------------------------------------------------------
// Registry actions
// ---------------------------------------------------------------------------

export function createBuffer(id: string, path: string | null, name: string, contents: string): void {
  savedTexts.set(id, contents);
  setRegistry("buffers", id, { id, path, name, dirty: false });
}

export function removeBuffer(id: string): void {
  savedTexts.delete(id);
  setRegistry(produce((s) => { delete s.buffers[id]; }));
}

export function markSaved(id: string, path: string, name: string, text: string): void {
  savedTexts.set(id, text);
  setRegistry("buffers", id, { path, name, dirty: false });
}

export function setBufferDirty(id: string, dirty: boolean): void {
  setRegistry("buffers", id, "dirty", dirty);
}
