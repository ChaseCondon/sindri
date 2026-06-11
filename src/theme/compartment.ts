// Holds the CM6 Compartment instance and the current extension snapshot.
// Lives here (not in registry.ts) to break the registry→groups→buffers→registry cycle:
//   buffers.ts  imports from compartment.ts  ← no cycle
//   registry.ts imports from compartment.ts  ← no cycle
import { Compartment, type Extension } from "@codemirror/state";

export const themeCompartment = new Compartment();

let _currentExt: Extension = [];

export function setCurrentCM6Extension(ext: Extension): void {
  _currentExt = ext;
}

export function getCurrentCM6Extension(): Extension {
  return _currentExt;
}
