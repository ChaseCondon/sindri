// Material-inspired SVG icons for Sindri's file/folder tree.
// 24x24 viewBox, rendered at 16x16 CSS px.
// Design: neutral document base + language-colored bottom strip.
// Key languages get actual path-based logo symbols above the strip.
// Mono mode: currentColor throughout.

import type { IconSource } from "../theme/tokens";

// ---------------------------------------------------------------------------
// Document geometry
// ---------------------------------------------------------------------------

const DOC = "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z";
const FOLD = "M14 2v6h6";
// Bottom strip: y=15→22, follows the doc's bottom corner radii
const STRIP = "M4 15H20V20A2 2 0 0 1 18 22H6A2 2 0 0 1 4 20Z";

const docBase = (opacity = 1) =>
  `<path d="${DOC}" fill="#455A64" opacity="${opacity}"/>` +
  `<path d="${FOLD}" fill="none" stroke="#37474F" stroke-width="1.5"/>`;

const monoDocBase = () =>
  `<path d="${DOC}" fill="currentColor" opacity=".18"/>` +
  `<path d="${FOLD}" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".35"/>`;

const strip = (color: string) => `<path d="${STRIP}" fill="${color}"/>`;
const monoStrip = () => `<path d="${STRIP}" fill="currentColor" opacity=".45"/>`;

const lbl = (text: string) => {
  const size = text.length > 3 ? "5" : text.length === 3 ? "5.8" : "6.5";
  return `<text x="12" y="20.5" font-size="${size}" font-family="Arial,Helvetica,sans-serif" font-weight="900" fill="white" text-anchor="middle">${text}</text>`;
};

// ---------------------------------------------------------------------------
// Generic builder  (colored strip + label)
// ---------------------------------------------------------------------------

function fileIcon(label: string, color: string, logo?: string): IconSource {
  const strip_ = strip(color);
  const svg = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">${docBase()}${logo ?? ""}${strip_}${lbl(label)}</svg>`;
  const monoSvg = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">${monoDocBase()}${logo ? colorToMono(logo) : ""}${monoStrip()}${lbl(label)}</svg>`;
  return { svg, monoSvg };
}

/** Strip all non-white, non-none fill/stroke colors → currentColor for mono mode */
function colorToMono(s: string): string {
  return s
    .replace(/fill="(?!none|white)[^"]+"/g, 'fill="currentColor"')
    .replace(/stroke="(?!none)[^"]+"/g, 'stroke="currentColor"');
}

// ---------------------------------------------------------------------------
// Logo symbols — positioned in the doc body (y ≈ 3–14)
// ---------------------------------------------------------------------------

// React atom  (JSX / TSX)
const REACT_LOGO = (c: string) =>
  `<circle cx="12" cy="9.5" r="1.6" fill="${c}"/>` +
  `<ellipse cx="12" cy="9.5" rx="2.2" ry="6" fill="none" stroke="${c}" stroke-width="1"/>` +
  `<ellipse cx="12" cy="9.5" rx="2.2" ry="6" fill="none" stroke="${c}" stroke-width="1" transform="rotate(60 12 9.5)"/>` +
  `<ellipse cx="12" cy="9.5" rx="2.2" ry="6" fill="none" stroke="${c}" stroke-width="1" transform="rotate(120 12 9.5)"/>`;

// Vue  V chevron
const VUE_LOGO =
  `<path d="M5 3h3l4 7 4-7h3L12 14z" fill="#41B883"/>` +
  `<path d="M8.5 3h2.2L12 5.8 13.3 3h2.2L12 9.5z" fill="#34495E"/>`;

// Svelte  stylised S
const SVELTE_LOGO =
  `<path d="M15 3.2c-1.6-1.1-3.9-.7-5 1l-4.5 7c-.8 1.2-.5 2.8.7 3.6 1 .7 2.3.6 3.2 0l.3-.3c-.4.7-.3 1.6.3 2.1.8.6 2 .4 2.7-.4l4.5-7c.8-1.2.5-2.8-.7-3.6-.4-.3-.9-.5-1.3-.5z" fill="#FF3E00"/>` +
  `<path d="M9 13.8c.6 1.1 1.9 1.5 3 .8.7-.4 1.1-1.2 1-2l-.3.3c-.9.6-2.2.7-3.2 0-1.2-.8-1.5-2.4-.7-3.6l1-1.5c-1.1.7-1.7 2-1.3 3.3.1.3.3.5.5.7z" fill="#FF3E00" opacity=".5"/>`;

// HTML5  angled bracket pair
const HTML_LOGO =
  `<path d="M6 5l-2 4.5L6 14h1.3L5.5 9.5 7.3 5z" fill="#E34C26"/>` +
  `<path d="M18 5l2 4.5L18 14h-1.3l1.8-4.5L16.7 5z" fill="#E34C26"/>` +
  `<path d="M9.5 12.5l.5 1.5H13l.5-1.5-2-.7z" fill="#EBEBEB"/>` +
  `<path d="M9 10l.3 1h5.4l.3-1z" fill="#EBEBEB"/>`;

// CSS3  shield outline
const CSS_LOGO =
  `<path d="M12 4L6 5.5l1 5.5c.5 2.5 2 4 5 5 3-1 4.5-2.5 5-5l1-5.5z" fill="#563D7C"/>` +
  `<path d="M12 6.5V13c2-.7 3-2 3.5-3.5l.7-3z" fill="#6534AC"/>`;

// Docker  simplified whale + containers
const DOCKER_LOGO =
  `<path d="M4 10h4v2H4zM9 10h4v2H9zM4 7.5h4v2H4zM9 7.5h4v2H9zM14 7.5h4v2h-4z" fill="#2496ED"/>` +
  `<path d="M20 11.5c0-.6-.4-1-1-1h-.5c-.1-.8-.6-1.5-1.3-1.8l-.3-.1-.2.3c-.2.4-.2.8-.1 1.1-.3-.1-.7-.4-.9-.8H4.5c-.1.5-.2 1-.2 1.5C4.3 13.2 6 14 8.5 14h9c1.2 0 2.2-.5 2.5-1.5l.1-.3c.3-.1.9-.4.9-.7z" fill="#2496ED"/>`;

// Rust  simplified gear
const RUST_LOGO =
  `<circle cx="12" cy="9" r="2.2" fill="none" stroke="#CE422B" stroke-width="1.5"/>` +
  `<path d="M12 4v1.5M12 12v1.5M7 7l1 1M16 10l1 1M7 11l1-1M16 7l1-1M4.5 9H6M18 9h1.5" stroke="#CE422B" stroke-width="1.5" stroke-linecap="round"/>` +
  `<circle cx="12" cy="9" r=".8" fill="#CE422B"/>`;

// Python  two interlinked circles (simplified snake heads)
const PYTHON_LOGO =
  `<path d="M12 4c-2.2 0-4 .9-4 2v2c0 .5.4.9 1 1h6c.9 0 1.5.7 1.5 1.5v1H9c-1.1 0-2 .9-2 2v2c0 1.1 1.8 2 4 2s4-.9 4-2v-2c0-.5-.4-.9-1-1H8c-.9 0-1.5-.7-1.5-1.5V9.5H15c1.1 0 2-.9 2-2v-2c0-1.1-1.8-2-4-2z" fill="#3776AB"/>` +
  `<circle cx="10" cy="6" r=".8" fill="#FFD43B"/>` +
  `<circle cx="14" cy="12" r=".8" fill="#FFD43B"/>`;

// Markdown  M↓
const MD_LOGO =
  `<path d="M4 6h2v6l3-3 3 3V6h2v8H4z" fill="#083FA1"/>` +
  `<path d="M16 10l2 4 2-4" fill="none" stroke="#083FA1" stroke-width="1.5"/>` +
  `<line x1="18" y1="6" x2="18" y2="14" stroke="#083FA1" stroke-width="1.5"/>`;

// JSON  {} brackets
const JSON_LOGO =
  `<path d="M9 4c-1.5 0-2 .7-2 1.5V7c0 .8-.5 1-1 1v2c.5 0 1 .2 1 1v1.5c0 .8.5 1.5 2 1.5" fill="none" stroke="#8BC34A" stroke-width="1.5" stroke-linecap="round"/>` +
  `<path d="M15 4c1.5 0 2 .7 2 1.5V7c0 .8.5 1 1 1v2c-.5 0-1 .2-1 1v1.5c0 .8-.5 1.5-2 1.5" fill="none" stroke="#8BC34A" stroke-width="1.5" stroke-linecap="round"/>`;

// YAML  horizontal lines with indentation
const YAML_LOGO =
  `<line x1="5" y1="5.5" x2="19" y2="5.5" stroke="#CB171E" stroke-width="1.5" stroke-linecap="round"/>` +
  `<line x1="5" y1="8.5" x2="14" y2="8.5" stroke="#CB171E" stroke-width="1.5" stroke-linecap="round"/>` +
  `<line x1="8" y1="11.5" x2="19" y2="11.5" stroke="#CB171E" stroke-width="1.5" stroke-linecap="round"/>`;

// TOML  bracket + equals
const TOML_LOGO =
  `<path d="M6 5h12M8 8h8M6 11l1-1v2l-1-1M9 11h6M6 14h12" stroke="#9C4221" stroke-width="1.4" stroke-linecap="round"/>`;

// ---------------------------------------------------------------------------
// File icons
// ---------------------------------------------------------------------------

export const FILE    = fileIcon("",    "#607D8B");
export const JS      = fileIcon("JS",  "#F7DF1E");
export const TS      = fileIcon("TS",  "#3178C6");
export const JSX     = fileIcon("JSX", "#61DAFB", REACT_LOGO("#61DAFB"));
export const TSX     = fileIcon("TSX", "#61DAFB", REACT_LOGO("#61DAFB"));
export const PY      = fileIcon("PY",  "#3776AB", PYTHON_LOGO);
export const RS      = fileIcon("RS",  "#CE422B", RUST_LOGO);
export const GO      = fileIcon("GO",  "#00ACD7");
export const JAVA    = fileIcon("JV",  "#B07219");
export const CPP     = fileIcon("C++", "#F34B7D");
export const C       = fileIcon("C",   "#6E6E6E");
export const CS      = fileIcon("C#",  "#239120");
export const HTML    = fileIcon("",    "#E34C26", HTML_LOGO);
export const CSS     = fileIcon("CSS", "#563D7C", CSS_LOGO);
export const SCSS    = fileIcon("SCSS","#CD6799");
export const JSON    = fileIcon("",    "#8BC34A", JSON_LOGO);
export const TOML    = fileIcon("",    "#9C4221", TOML_LOGO);
export const YAML    = fileIcon("",    "#CB171E", YAML_LOGO);
export const MD      = fileIcon("",    "#083FA1", MD_LOGO);
export const SVG_ICO = fileIcon("SVG", "#FFB300");
export const IMG     = fileIcon("IMG", "#26A69A");
export const SH      = fileIcon("SH",  "#4CAF50");
export const TXT     = fileIcon("TXT", "#9E9E9E");
export const XML     = fileIcon("XML", "#F44336");
export const SQL     = fileIcon("SQL", "#E38D44");
export const ENV     = fileIcon(".env","#ECD53F");
export const GIT     = fileIcon("GIT", "#F14C28");
export const LOCK    = fileIcon("LCK", "#607D8B");
export const PKG     = fileIcon("PKG", "#CB3837");
export const CONFIG  = fileIcon("CFG", "#78909C");
export const DOCKER  = fileIcon("",    "#2496ED", DOCKER_LOGO);
export const RB      = fileIcon("RB",  "#CC342D");
export const PHP     = fileIcon("PHP", "#4F5D95");
export const KT      = fileIcon("KT",  "#7F52FF");
export const SWIFT   = fileIcon("SW",  "#FA7343");
export const VUE     = fileIcon("",    "#41B883", VUE_LOGO);
export const SVELTE  = fileIcon("",    "#FF3E00", SVELTE_LOGO);
export const ASTRO   = fileIcon("AS",  "#FF5A03");
export const WASM    = fileIcon("WASM","#654FF0");
export const LUA     = fileIcon("LUA", "#2C2D72");
export const DART    = fileIcon("DRT", "#00BCD4");
export const NIM     = fileIcon("NIM", "#F3D400");
export const ZIG     = fileIcon("ZIG", "#F7A41D");
export const R_FILE  = fileIcon("R",   "#1E6FBB");

// ---------------------------------------------------------------------------
// Folder icons — closed = solid fill; open = same shape as outline
// ---------------------------------------------------------------------------

const FOLDER_PATH = "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5.17l2 3H20a2 2 0 0 1 2 2z";

function folderIcon(color: string): IconSource {
  const svg = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="${FOLDER_PATH}" fill="${color}"/></svg>`;
  const monoSvg = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="${FOLDER_PATH}" fill="currentColor" opacity=".6"/></svg>`;
  return { svg, monoSvg };
}

function folderIconOpen(color: string): IconSource {
  // Same shape as closed but rendered as outline only
  const svg = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="${FOLDER_PATH}" fill="${color}" opacity=".15"/><path d="${FOLDER_PATH}" fill="none" stroke="${color}" stroke-width="1.5"/></svg>`;
  const monoSvg = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="${FOLDER_PATH}" fill="currentColor" opacity=".1"/><path d="${FOLDER_PATH}" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".6"/></svg>`;
  return { svg, monoSvg };
}

export const FOLDER        = folderIcon("#FFA726");
export const FOLDER_OPEN   = folderIconOpen("#FFA726");
export const FOLDER_SRC    = folderIcon("#42A5F5");
export const FOLDER_SRC_O  = folderIconOpen("#42A5F5");
export const FOLDER_TEST   = folderIcon("#EF5350");
export const FOLDER_TEST_O = folderIconOpen("#EF5350");
export const FOLDER_NODE   = folderIcon("#43A047");
export const FOLDER_NODE_O = folderIconOpen("#43A047");
export const FOLDER_GIT    = folderIcon("#F14C28");
export const FOLDER_GIT_O  = folderIconOpen("#F14C28");
export const FOLDER_DIST   = folderIcon("#7E57C2");
export const FOLDER_DIST_O = folderIconOpen("#7E57C2");
export const FOLDER_DOCS   = folderIcon("#26C6DA");
export const FOLDER_DOCS_O = folderIconOpen("#26C6DA");
export const FOLDER_CFG    = folderIcon("#78909C");
export const FOLDER_CFG_O  = folderIconOpen("#78909C");
export const FOLDER_ASSET  = folderIcon("#EC407A");
export const FOLDER_ASSET_O= folderIconOpen("#EC407A");
export const FOLDER_PUBLIC = folderIcon("#26A69A");
export const FOLDER_PUBLIC_O=folderIconOpen("#26A69A");
export const FOLDER_MOCK   = folderIcon("#FFA000");
export const FOLDER_MOCK_O = folderIconOpen("#FFA000");
