/**
 * Bundle a Sindri extension via esbuild.
 *
 * Usage: bun run scripts/build-extension.ts <extension-dir> [--bundle]
 * Example: bun run scripts/build-extension.ts ../sindri-extensions/sindri-csv-grid
 *          bun run scripts/build-extension.ts ../sindri-extensions/sindri-csv-grid --bundle
 *
 * Extension bundle (built when src/extension.ts exists):
 *   Input:  <ext-dir>/src/extension.ts
 *   Output: <ext-dir>/dist/extension.js      (IIFE, globalName: sindri_ext)
 *           <ext-dir>/dist/extension.js.map
 *
 * Webview bundle (built when a webview entry is detected):
 *   Candidates (first match wins):
 *     src/webview/index.tsx  src/webview/index.ts
 *     src/webview.tsx        src/webview.ts
 *   Output: <ext-dir>/dist/webview.js        (IIFE, platform: browser)
 *           <ext-dir>/dist/webview.js.map
 *           <ext-dir>/dist/webview.css        (emitted when entry imports .scss files)
 *
 * Framework detection (from extension's package.json):
 *   solid-js  → jsx: automatic, jsxImportSource: solid-js
 *   react     → jsx: automatic, jsxImportSource: react
 *   preact    → jsx: automatic, jsxImportSource: preact
 *   svelte    → esbuild-svelte plugin with svelte-preprocess (TypeScript + SCSS in .svelte)
 *
 * --bundle flag: validates the manifest, then produces a .sinxt archive at
 *   <ext-dir>/dist/<id>-<version>.sinxt
 *   Format: deterministic zip (sorted paths, mtime=1980-01-01, level 6) of manifest.json,
 *   dist/** (excluding any existing .sinxt), and all manifest-referenced assets.
 *
 * Data-only extensions (icon themes, colour themes) have no src/extension.ts.
 * The JS build steps are silently skipped when the entry is absent.
 */

import * as esbuild from "esbuild";
import * as path from "path";
import * as fs from "fs";
import { sassPlugin } from "esbuild-sass-plugin";
import * as fflate from "fflate";

// ─── Args ────────────────────────────────────────────────────────────────────

const extDir = process.argv[2];
if (!extDir) {
  console.error("Usage: bun run scripts/build-extension.ts <extension-dir> [--bundle]");
  process.exit(1);
}
const bundleFlag = process.argv.slice(3).includes("--bundle");

const root = new URL("..", import.meta.url).pathname; // sindri-ide/
const absExtDir = path.resolve(root, extDir);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtBytes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)} KB`;
  return `${n} B`;
}

function logBuilt(file: string): void {
  const size = fs.statSync(file).size;
  const label = path.basename(file).padEnd(20);
  console.log(`  built  ${label}  ${fmtBytes(size)}`);
}

// ─── Validation ──────────────────────────────────────────────────────────────

interface ValidationIssue {
  field: string;
  message: string;
}

const VALID_CATEGORIES = new Set([
  "Color Theme", "File Icon Theme", "UI Icon Theme", "Language Support",
  "Language Pack", "Test & Task Adapter", "UI Extension", "Extension Pack",
  "Icon Theme Base",
]);

function validateManifest(manifest: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (typeof manifest !== "object" || manifest === null) {
    return [{ field: "(root)", message: "manifest is not an object" }];
  }

  const m = manifest as Record<string, unknown>;

  // Required string fields
  for (const f of ["id", "name", "version", "publisher", "description"] as const) {
    if (typeof m[f] !== "string" || !(m[f] as string).trim()) {
      issues.push({ field: f, message: "required string field is missing or empty" });
    }
  }

  if (typeof m.id === "string") {
    if (!/^[a-z0-9-]+\.[a-z0-9-]+$/.test(m.id)) {
      issues.push({ field: "id", message: `"${m.id}" must match ^[a-z0-9-]+\\.[a-z0-9-]+$` });
    } else if (typeof m.publisher === "string" && !m.id.startsWith(`${m.publisher}.`)) {
      issues.push({
        field: "publisher",
        message: `"${m.publisher}" must be the dot-prefix of id "${m.id}"`,
      });
    }
  }

  if (typeof m.version === "string" && !/^\d+\.\d+\.\d+$/.test(m.version)) {
    issues.push({ field: "version", message: `"${m.version}" must be semver (x.y.z)` });
  }

  if (!Array.isArray(m.categories) || m.categories.length === 0) {
    issues.push({ field: "categories", message: "must be a non-empty array" });
  } else {
    for (const cat of m.categories as unknown[]) {
      if (typeof cat !== "string" || !VALID_CATEGORIES.has(cat)) {
        issues.push({
          field: "categories",
          message: `unknown category "${cat}" — valid values: ${[...VALID_CATEGORIES].join(", ")}`,
        });
      }
    }
  }

  if (!Array.isArray(m.permissions)) {
    issues.push({ field: "permissions", message: "must be an array (use [] for data-only extensions)" });
  }

  const engines = m.engines as Record<string, unknown> | undefined;
  if (typeof engines !== "object" || engines === null || typeof engines.sindri !== "string") {
    issues.push({ field: "engines.sindri", message: "required — e.g. \">=0.1.0\"" });
  }

  if (typeof m.contributes !== "object" || m.contributes === null) {
    issues.push({ field: "contributes", message: "required object (use {} for no contributions)" });
  }

  return issues;
}

/** Post-build check: all paths declared in the manifest actually exist on disk. */
function validateManifestPaths(extDir: string, manifest: SinxtManifest): string[] {
  const missing: string[] = [];
  const check = (rel: string, ctx: string) => {
    if (!fs.existsSync(path.join(extDir, rel))) missing.push(`${rel}  (${ctx})`);
  };

  if (manifest.main) check(manifest.main, "main");
  if (manifest.icon) check(manifest.icon, "icon");

  const contrib = manifest.contributes ?? {};
  for (const t of contrib.themes ?? [])       check(t.path,    "contributes.themes[].path");
  for (const t of contrib.grammars ?? [])     check(t.path,    "contributes.grammars[].path");

  // Inherited icon themes (ADR-0032 `extends`) declare a path to icons.json that the runtime
  // generates by merging the base. The file won't exist until runtime — skip the check.
  if (!manifest.extends) {
    for (const t of contrib.iconThemes ?? [])  check(t.path,   "contributes.iconThemes[].path");
    for (const t of contrib.uiIconPacks ?? []) check(t.path,   "contributes.uiIconPacks[].path");
  }
  for (const t of contrib.treeViews ?? [])    { if (t.icon) check(t.icon, "contributes.treeViews[].icon"); }
  for (const t of contrib.webviewPanels ?? []) { if (t.icon) check(t.icon, "contributes.webviewPanels[].icon"); }

  return missing;
}

// ─── Read + validate manifest ─────────────────────────────────────────────────

const manifestPath = path.join(absExtDir, "manifest.json");
if (!fs.existsSync(manifestPath)) {
  console.error(`✘ No manifest.json at ${path.relative(root, absExtDir)}`);
  process.exit(1);
}

const rawManifest: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const manifestIssues = validateManifest(rawManifest);
if (manifestIssues.length > 0) {
  console.error(`✘ manifest.json validation failed (${path.relative(root, absExtDir)}):`);
  for (const { field, message } of manifestIssues) {
    console.error(`    ${field}: ${message}`);
  }
  process.exit(1);
}

// Minimal manifest shape used by the packager
interface SinxtManifest {
  id: string;
  version: string;
  icon?: string;
  main?: string;
  extends?: string; // ADR-0032: inherited icon theme — icons.json is generated at runtime from the base
  contributes?: {
    themes?: Array<{ path: string }>;
    iconThemes?: Array<{ path: string }>;
    uiIconPacks?: Array<{ path: string }>;
    treeViews?: Array<{ icon?: string }>;
    webviewPanels?: Array<{ icon?: string }>;
    grammars?: Array<{ path: string }>;
  };
}

const manifest = rawManifest as SinxtManifest;

// ─── Ensure @sindri/api is built ─────────────────────────────────────────────

const sindriApiDir  = path.join(root, "packages/sindri-api");
const sindriApiSrc  = path.join(sindriApiDir, "helpers.ts");
const sindriApiOut  = path.join(sindriApiDir, "dist/helpers.js");

const apiStale =
  !fs.existsSync(sindriApiOut) ||
  fs.statSync(sindriApiSrc).mtimeMs > fs.statSync(sindriApiOut).mtimeMs;

if (apiStale) {
  console.log("⚙  building @sindri/api...");
  const result = Bun.spawnSync(["bun", "run", "build"], {
    cwd: sindriApiDir,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    console.error("✘ @sindri/api build failed");
    process.exit(1);
  }
}

const sindriApiAlias: Record<string, string> = {
  "@sindri/api/helpers": sindriApiOut,
};

// ─── Extension bundle (IIFE, V8 isolate) ─────────────────────────────────────

const entry  = path.join(absExtDir, "src/extension.ts");
const outfile = path.join(absExtDir, "dist/extension.js");

if (fs.existsSync(entry)) {
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    outfile,
    format: "iife",
    globalName: "sindri_ext",
    platform: "neutral",
    target: "es2020",
    sourcemap: "linked",
    external: [],
    alias: sindriApiAlias,
    logLevel: "warning",
  });
  logBuilt(outfile);
}

// ─── Webview bundle (IIFE, browser) ──────────────────────────────────────────

const webviewCandidates = [
  "src/webview/index.tsx",
  "src/webview/index.ts",
  "src/webview.tsx",
  "src/webview.ts",
].map((f) => path.join(absExtDir, f)).filter(fs.existsSync);

if (webviewCandidates.length > 0) {
  const webviewEntry = webviewCandidates[0];
  const webviewOut   = path.join(absExtDir, "dist/webview.js");

  const pkgPath = path.join(absExtDir, "package.json");
  const pkg = fs.existsSync(pkgPath)
    ? (JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      })
    : {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  let jsxOptions: Partial<esbuild.BuildOptions> = {};
  if (webviewEntry.endsWith(".tsx") || webviewEntry.endsWith(".ts")) {
    if      (deps["solid-js"]) jsxOptions = { jsx: "automatic", jsxImportSource: "solid-js" };
    else if (deps["react"])    jsxOptions = { jsx: "automatic", jsxImportSource: "react" };
    else if (deps["preact"])   jsxOptions = { jsx: "automatic", jsxImportSource: "preact" };
  }

  const plugins: esbuild.Plugin[] = [sassPlugin()];
  if (deps["svelte"]) {
    const { default: esbuildSvelte } = await import("esbuild-svelte");
    const sveltePreprocess = (await import("svelte-preprocess")).default;
    plugins.push(esbuildSvelte({
      compilerOptions: { css: "injected" },
      preprocess: sveltePreprocess(),
    }));
  }

  await esbuild.build({
    entryPoints: [webviewEntry],
    bundle: true,
    outfile: webviewOut,
    format: "iife",
    platform: "browser",
    target: "es2020",
    sourcemap: "linked",
    external: [],
    alias: sindriApiAlias,
    plugins,
    logLevel: "warning",
    ...jsxOptions,
  });

  logBuilt(webviewOut);

  const webviewCss = webviewOut.replace(/\.js$/, ".css");
  if (fs.existsSync(webviewCss)) logBuilt(webviewCss);
}

// ─── .sinxt packaging (--bundle flag) ────────────────────────────────────────

if (!bundleFlag) process.exit(0);

// Post-build path validation — now that dist/ is built, all referenced files must exist
const missingPaths = validateManifestPaths(absExtDir, manifest);
if (missingPaths.length > 0) {
  console.error("✘ manifest references missing files:");
  for (const p of missingPaths) console.error(`    ${p}`);
  process.exit(1);
}

/** Recursively enumerate all files under a directory, returning absolute paths. */
function walkDir(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkDir(full));
    else results.push(full);
  }
  return results;
}

/**
 * Collect all files to include in the .sinxt archive, as sorted relative paths.
 *
 * Includes: manifest.json, dist/** (excluding .sinxt files), and all assets
 * declared in the manifest (theme JSONs, icon SVGs, grammar files). For icon
 * theme and UI icon pack JSONs, also includes any SVG files referenced inside
 * them via icons[*].path (relative to the JSON file's directory).
 */
function collectPackageFiles(extDir: string, manifest: SinxtManifest): string[] {
  const files = new Set<string>();
  const add = (rel: string) => {
    const full = path.join(extDir, rel);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) files.add(rel);
  };

  files.add("manifest.json");

  const distDir = path.join(extDir, "dist");
  if (fs.existsSync(distDir)) {
    for (const abs of walkDir(distDir)) {
      if (!abs.endsWith(".sinxt")) { // never bundle a previous .sinxt into the new one
        files.add(path.relative(extDir, abs));
      }
    }
  }

  const contrib = manifest.contributes ?? {};

  if (manifest.icon) add(manifest.icon);
  for (const t of contrib.treeViews ?? [])    { if (t.icon) add(t.icon); }
  for (const t of contrib.webviewPanels ?? []) { if (t.icon) add(t.icon); }
  for (const t of contrib.themes ?? [])       add(t.path);
  for (const t of contrib.grammars ?? [])     add(t.path);

  for (const t of contrib.iconThemes ?? []) {
    add(t.path);
    const jsonAbs = path.join(extDir, t.path);
    if (fs.existsSync(jsonAbs)) {
      const def = JSON.parse(fs.readFileSync(jsonAbs, "utf8")) as {
        icons?: Record<string, { path?: string }>;
      };
      const jsonDir = path.dirname(t.path);
      for (const icon of Object.values(def.icons ?? {})) {
        if (icon.path) add(path.join(jsonDir, icon.path));
      }
    }
  }

  for (const t of contrib.uiIconPacks ?? []) {
    add(t.path);
    const jsonAbs = path.join(extDir, t.path);
    if (fs.existsSync(jsonAbs)) {
      const def = JSON.parse(fs.readFileSync(jsonAbs, "utf8")) as {
        icons?: Record<string, { path?: string }>;
      };
      const jsonDir = path.dirname(t.path);
      for (const icon of Object.values(def.icons ?? {})) {
        if (icon.path) add(path.join(jsonDir, icon.path));
      }
    }
  }

  return [...files].sort();
}

const fileList = collectPackageFiles(absExtDir, manifest);

const entries: fflate.Zippable = {};
for (const rel of fileList) {
  const content = new Uint8Array(fs.readFileSync(path.join(absExtDir, rel)));
  entries[rel] = [content, { mtime: new Date(315532800000) }]; // 1980-01-01T00:00:00Z — earliest ZIP-legal date
}

const zipped = fflate.zipSync(entries, { level: 6 });

// Ensure dist/ exists and remove any previous .sinxt there
const distOut = path.join(absExtDir, "dist");
fs.mkdirSync(distOut, { recursive: true });
for (const f of fs.readdirSync(distOut)) {
  if (f.endsWith(".sinxt")) fs.unlinkSync(path.join(distOut, f));
}

const outName = `${manifest.id}-${manifest.version}.sinxt`;
const outPath = path.join(distOut, outName);
fs.writeFileSync(outPath, zipped);

const rel = path.relative(root, outPath);
console.log(`  ✓ ${rel}  (${fileList.length} files · ${fmtBytes(zipped.length)})`);
