// Theme coverage checker — computes how many optional extended tokens a ThemeDef provides.
// Used by the dev toggle UI to surface gaps before a theme is published.
import type { ThemeDef } from "./tokens";

export interface ThemeCoverageResult {
  total: number;
  covered: number;
  missing: string[];
}

const TERMINAL_KEYS = [
  "black","red","green","yellow","blue","magenta","cyan","white",
  "brightBlack","brightRed","brightGreen","brightYellow",
  "brightBlue","brightMagenta","brightCyan","brightWhite",
] as const;

const DIFF_KEYS        = ["added","modified","deleted"] as const;
const FIND_KEYS        = ["match","matchHighlight","wordHighlight"] as const;
const DIAGNOSTIC_KEYS  = ["error","warning","info"] as const;
const SYNTAX_EXT_KEYS  = ["class","interface","enum","namespace","decorator","constant","macro","typeParameter"] as const;

export const COVERAGE_TOTAL =
  TERMINAL_KEYS.length + DIFF_KEYS.length + FIND_KEYS.length +
  DIAGNOSTIC_KEYS.length + SYNTAX_EXT_KEYS.length; // 35

export function checkThemeCoverage(theme: ThemeDef): ThemeCoverageResult {
  const missing: string[] = [];

  for (const k of TERMINAL_KEYS)    { if (!theme.terminal?.[k])           missing.push(`terminal.${k}`); }
  for (const k of DIFF_KEYS)        { if (!theme.diff?.[k])               missing.push(`diff.${k}`); }
  for (const k of FIND_KEYS)        { if (!theme.find?.[k])               missing.push(`find.${k}`); }
  for (const k of DIAGNOSTIC_KEYS)  { if (!theme.diagnostic?.[k])         missing.push(`diagnostic.${k}`); }
  for (const k of SYNTAX_EXT_KEYS)  { if (!theme.syntaxExtended?.[k])     missing.push(`syntaxExtended.${k}`); }

  return { total: COVERAGE_TOTAL, covered: COVERAGE_TOTAL - missing.length, missing };
}
