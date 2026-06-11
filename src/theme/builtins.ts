// Built-in theme registration shim (ADR-0019).
// core-extensions/ holds the actual ThemeDef JSON — same format external extensions use.
// When the QuickJS host ships, this shim is replaced by the extension loader.
import type { ThemeDef } from "./tokens";
import { registerTheme } from "./registry";

import sindriDarkJson  from "../../core-extensions/sindri-dark/dark.json";
import sindriVoidJson  from "../../core-extensions/sindri-void/void.json";
import sindriLightJson from "../../core-extensions/sindri-light/light.json";

export function registerBuiltinThemes(): void {
  registerTheme(sindriDarkJson  as unknown as ThemeDef);
  registerTheme(sindriVoidJson  as unknown as ThemeDef);
  registerTheme(sindriLightJson as unknown as ThemeDef);
}
