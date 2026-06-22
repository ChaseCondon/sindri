import { createSignal, For, onMount, onCleanup, createEffect, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { get, set } from "../configStore";
import { SettingsGroup, SettingsRow } from "./primitives";
import { themeList, uiThemeId } from "../../../theme/registry";
import { resolveTerminalTheme } from "../../panels/terminal-themes";
import { cssFontStack, loadFont } from "../../panels/TerminalPanel";

// ── Installed font enumeration (loaded once, shared across mounts) ───────────

const [systemFonts, setSystemFonts] = createSignal<string[]>([]);
let fontsRequested = false;

function ensureFonts() {
  if (fontsRequested) return;
  fontsRequested = true;
  if (!("__TAURI_INTERNALS__" in globalThis)) return;
  invoke<string[]>("list_terminal_fonts")
    .then((list) => setSystemFonts(list))
    .catch(() => { /* leave empty — falls back to generic */ });
}

// ── Font picker — editable combobox + portal dropdown (escapes the card) ─────

function FontPicker() {
  const [open, setOpen] = createSignal(false);
  const [rect, setRect] = createSignal<DOMRect | null>(null);
  let wrapperRef!: HTMLDivElement;
  let dropdownRef: HTMLDivElement | undefined;
  onMount(ensureFonts);

  const current = () => get<string>("terminal.fontFamily") || "monospace";

  // Full alphabetized list — not filtered by the input (no fuzzy finder).
  const options = () => ["monospace", ...systemFonts()];

  function openDropdown() {
    setRect(wrapperRef.getBoundingClientRect());
    setOpen(true);
  }

  function selectFont(font: string) {
    set("terminal.fontFamily", font);
    setOpen(false);
  }

  function onDocPointerDown(e: PointerEvent) {
    const t = e.target as Node;
    if (!wrapperRef.contains(t) && !dropdownRef?.contains(t)) setOpen(false);
  }
  document.addEventListener("pointerdown", onDocPointerDown);
  onCleanup(() => document.removeEventListener("pointerdown", onDocPointerDown));

  return (
    <div ref={wrapperRef!} class="font-picker">
      <input
        type="text"
        class="settings-input font-picker-input"
        placeholder="monospace"
        value={current()}
        onInput={(e) => set("terminal.fontFamily", e.currentTarget.value)}
        onFocus={openDropdown}
        onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}
      />
      <button
        type="button"
        class="font-picker-chevron-btn"
        aria-label="Browse installed fonts"
        onClick={() => (open() ? setOpen(false) : openDropdown())}
      >
        ▾
      </button>
      <Show when={open() && rect()}>
        <Portal>
          <div
            ref={dropdownRef}
            class="font-picker-dropdown"
            style={{
              position: "fixed",
              top: `${rect()!.bottom + 3}px`,
              left: `${rect()!.left}px`,
              width: `${rect()!.width}px`,
            }}
          >
            <For each={options()}>
              {(font) => (
                <button
                  type="button"
                  class={`font-picker-item${font === current() ? " active" : ""}`}
                  style={{ "font-family": cssFontStack(font) }}
                  onClick={() => selectFont(font)}
                >
                  {font}
                </button>
              )}
            </For>
          </div>
        </Portal>
      </Show>
    </div>
  );
}

// ── Live terminal preview ────────────────────────────────────────────────────

const PREVIEW_LINES = [
  "\x1b[1;32m❯\x1b[0m echo \x1b[36m'Hello, Sindri!'\x1b[0m\r\n",
  "\x1b[33mHello, Sindri!\x1b[0m\r\n",
  "\x1b[1;32m❯\x1b[0m cargo build\r\n",
  "   \x1b[32mCompiling\x1b[0m sindri v1.0.0\r\n",
  "    \x1b[1;32mFinished\x1b[0m dev in \x1b[33m2.4s\x1b[0m\r\n",
  "\x1b[1;32m❯\x1b[0m git status\r\n",
  "\x1b[34mOn branch\x1b[0m \x1b[1mmain\x1b[0m\r\n",
  "\x1b[31m  M\x1b[0m src/editor/syntax.ts\r\n",
  "\x1b[1;32m❯\x1b[0m ", // prompt; the cursor cell is appended by renderPreview()
];

// A drawn cursor that reflects the chosen style. We render it ourselves (xterm's
// own cursor only shows when focused, which a preview never is).
function cursorCell(style: string): string {
  if (style === "bar") return "▏";              // ▏ left bar
  if (style === "underline") return "\x1b[4m \x1b[24m"; // underlined space
  return "\x1b[7m \x1b[27m";                          // reverse-video block
}

function TerminalPreview() {
  let containerRef!: HTMLDivElement;
  let xterm: Terminal | null = null;
  let fitAddon: FitAddon | null = null;
  let blinkTimer: number | undefined;

  function render(showCursor: boolean) {
    if (!xterm) return;
    xterm.write("\x1b[2J\x1b[H");
    PREVIEW_LINES.forEach((l) => xterm!.write(l));
    const style = get<"block" | "bar" | "underline">("terminal.cursorStyle");
    xterm.write(showCursor ? cursorCell(style) : " ");
  }

  function startCursor() {
    clearInterval(blinkTimer);
    if (get<boolean>("terminal.cursorBlink")) {
      let on = true;
      render(true);
      blinkTimer = window.setInterval(() => { on = !on; render(on); }, 530);
    } else {
      render(true);
    }
  }

  onMount(() => {
    const fontFamily = get<string>("terminal.fontFamily") || "monospace";
    const fontSize = get<number>("terminal.fontSize");
    xterm = new Terminal({
      disableStdin: true,
      cursorBlink: false,
      fontFamily: cssFontStack(fontFamily),
      fontSize,
      lineHeight: get<number>("terminal.lineHeight"),
      letterSpacing: get<number>("terminal.letterSpacing"),
      theme: resolveTerminalTheme(),
      scrollback: 0,
    });
    fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(containerRef);
    xterm.write("\x1b[?25l"); // hide xterm's own (focus-dependent) cursor
    // Render immediately so the preview is never blank, then refine after font load.
    fitAddon.fit();
    startCursor();
    loadFont(fontFamily, fontSize).then(() => {
      fitAddon?.fit();
      startCursor();
    });
  });

  onCleanup(() => {
    clearInterval(blinkTimer);
    xterm?.dispose();
  });

  createEffect(() => {
    if (!xterm) return;
    // Track reactive deps so the preview updates live.
    get("terminal.cursorStyle");
    get("terminal.cursorBlink");
    xterm.options.lineHeight = get<number>("terminal.lineHeight");
    xterm.options.letterSpacing = get<number>("terminal.letterSpacing");
    xterm.options.theme = resolveTerminalTheme();

    const fontFamily = get<string>("terminal.fontFamily") || "monospace";
    const fontSize = get<number>("terminal.fontSize");
    loadFont(fontFamily, fontSize).then(() => {
      if (!xterm) return;
      xterm.options.fontFamily = cssFontStack(fontFamily);
      xterm.options.fontSize = fontSize;
      requestAnimationFrame(() => {
        fitAddon?.fit();
        startCursor();
      });
    });
  });

  return (
    <div class="terminal-preview-wrapper">
      <div class="terminal-preview-label">Preview</div>
      <div ref={containerRef!} class="terminal-preview" />
    </div>
  );
}

// ── TerminalSection ──────────────────────────────────────────────────────────

export function TerminalSection() {
  return (
    <div class="settings-section terminal-section">
      <h2 class="settings-section-title">Terminal</h2>
      <div class="terminal-settings-layout">

        <div class="terminal-settings-controls">

          {/* ── Appearance ──────────────────────────────────────────── */}
          <SettingsGroup title="Appearance">

            <SettingsRow
              label="Use a separate color scheme"
              description="By default the terminal follows the app theme. Enable to pick its own."
            >
              <label class="settings-checkbox-label">
                <input
                  type="checkbox"
                  class="settings-checkbox"
                  checked={get<boolean>("terminal.customTheme")}
                  onChange={(e) => set("terminal.customTheme", e.currentTarget.checked)}
                />
              </label>
            </SettingsRow>

            <Show when={get<boolean>("terminal.customTheme")}>
              <SettingsRow label="Color scheme" description="Installed theme used for terminal colors.">
                <select
                  class="settings-select"
                  value={get<string>("terminal.colorScheme") || uiThemeId()}
                  onChange={(e) => set("terminal.colorScheme", e.currentTarget.value)}
                >
                  <For each={themeList()}>
                    {(t) => <option value={t.id}>{t.name}</option>}
                  </For>
                </select>
              </SettingsRow>
            </Show>

            <SettingsRow
              label="Font size"
              description="Terminal font size in pixels (8–32)."
            >
              <div class="settings-range-row">
                <input
                  type="range"
                  class="settings-range"
                  value={get<number>("terminal.fontSize")}
                  min={8}
                  max={32}
                  step={1}
                  onInput={(e) => set("terminal.fontSize", e.currentTarget.valueAsNumber)}
                />
                <span class="settings-range-value">
                  {get<number>("terminal.fontSize")}px
                </span>
              </div>
            </SettingsRow>

            <SettingsRow
              label="Font family"
              description="Type any installed font, or pick a detected monospace font from the list."
            >
              <FontPicker />
            </SettingsRow>

            <SettingsRow
              label="Line height"
              description="Line height multiplier (1.0–2.0)."
            >
              <div class="settings-range-row">
                <input
                  type="range"
                  class="settings-range"
                  value={get<number>("terminal.lineHeight")}
                  min={1.0}
                  max={2.0}
                  step={0.05}
                  onInput={(e) => set("terminal.lineHeight", e.currentTarget.valueAsNumber)}
                />
                <span class="settings-range-value">
                  {get<number>("terminal.lineHeight").toFixed(2)}×
                </span>
              </div>
            </SettingsRow>

            <SettingsRow
              label="Letter spacing"
              description="Extra horizontal space between characters, in pixels."
            >
              <div class="settings-range-row">
                <input
                  type="range"
                  class="settings-range"
                  value={get<number>("terminal.letterSpacing")}
                  min={-2}
                  max={8}
                  step={0.5}
                  onInput={(e) => set("terminal.letterSpacing", e.currentTarget.valueAsNumber)}
                />
                <span class="settings-range-value">
                  {get<number>("terminal.letterSpacing")}px
                </span>
              </div>
            </SettingsRow>

            <SettingsRow
              label="Font ligatures"
              description="Render programming ligatures (=> != ===) if the font provides them."
            >
              <label class="settings-checkbox-label">
                <input
                  type="checkbox"
                  class="settings-checkbox"
                  checked={get<boolean>("terminal.fontLigatures")}
                  onChange={(e) => set("terminal.fontLigatures", e.currentTarget.checked)}
                />
              </label>
            </SettingsRow>

          </SettingsGroup>

          {/* ── Cursor ──────────────────────────────────────────────── */}
          <SettingsGroup title="Cursor">

            <SettingsRow label="Cursor style">
              <div class="settings-radio-group">
                <For each={[
                  { value: "block", label: "Block" },
                  { value: "bar", label: "Bar" },
                  { value: "underline", label: "Underline" },
                ]}>
                  {(opt) => (
                    <label class="settings-radio-label">
                      <input
                        type="radio"
                        name="terminal.cursorStyle"
                        class="settings-radio"
                        value={opt.value}
                        checked={get<string>("terminal.cursorStyle") === opt.value}
                        onChange={() => set("terminal.cursorStyle", opt.value)}
                      />
                      {opt.label}
                    </label>
                  )}
                </For>
              </div>
            </SettingsRow>

            <SettingsRow label="Cursor blink" description="Animate the cursor.">
              <label class="settings-checkbox-label">
                <input
                  type="checkbox"
                  class="settings-checkbox"
                  checked={get<boolean>("terminal.cursorBlink")}
                  onChange={(e) => set("terminal.cursorBlink", e.currentTarget.checked)}
                />
              </label>
            </SettingsRow>

          </SettingsGroup>

          {/* ── Behavior ────────────────────────────────────────────── */}
          <SettingsGroup title="Behavior">

            <SettingsRow
              label="Scrollback lines"
              description="Lines kept in the scrollback buffer. 0 = unlimited (uses more memory)."
            >
              <input
                type="number"
                class="settings-input settings-input-sm"
                value={get<number>("terminal.scrollback")}
                min={0}
                max={100000}
                step={500}
                onInput={(e) => {
                  const v = e.currentTarget.valueAsNumber;
                  if (v >= 0) set("terminal.scrollback", v);
                }}
              />
            </SettingsRow>

            <SettingsRow
              label="Shell"
              description="Path to the shell binary. Leave empty to auto-detect ($SHELL or platform default)."
            >
              <input
                type="text"
                class="settings-input"
                placeholder="auto-detect"
                value={get<string>("terminal.shell")}
                onInput={(e) => set("terminal.shell", e.currentTarget.value)}
              />
            </SettingsRow>

            <SettingsRow
              label="Starting directory"
              description="Where new terminal sessions open."
            >
              <div class="settings-radio-group">
                <For each={[
                  { value: "workspace", label: "Project folder" },
                  { value: "home", label: "Home directory" },
                ]}>
                  {(opt) => (
                    <label class="settings-radio-label">
                      <input
                        type="radio"
                        name="terminal.cwd"
                        class="settings-radio"
                        value={opt.value}
                        checked={get<string>("terminal.cwd") === opt.value}
                        onChange={() => set("terminal.cwd", opt.value)}
                      />
                      {opt.label}
                    </label>
                  )}
                </For>
              </div>
            </SettingsRow>

            <SettingsRow
              label="Copy on select"
              description="Automatically copy selected text to the clipboard."
            >
              <label class="settings-checkbox-label">
                <input
                  type="checkbox"
                  class="settings-checkbox"
                  checked={get<boolean>("terminal.copyOnSelect")}
                  onChange={(e) => set("terminal.copyOnSelect", e.currentTarget.checked)}
                />
              </label>
            </SettingsRow>

            <SettingsRow label="Enable bell" description="Play an audio bell on BEL character (\\x07).">
              <label class="settings-checkbox-label">
                <input
                  type="checkbox"
                  class="settings-checkbox"
                  checked={get<boolean>("terminal.bell")}
                  onChange={(e) => set("terminal.bell", e.currentTarget.checked)}
                />
              </label>
            </SettingsRow>

            <SettingsRow
              label="Option key as Alt"
              description="Treat the macOS Option key as Alt, enabling alt-key sequences in vim, tmux, etc."
            >
              <label class="settings-checkbox-label">
                <input
                  type="checkbox"
                  class="settings-checkbox"
                  checked={get<boolean>("terminal.macOptionAsAlt")}
                  onChange={(e) => set("terminal.macOptionAsAlt", e.currentTarget.checked)}
                />
              </label>
            </SettingsRow>

          </SettingsGroup>

        </div>

        <TerminalPreview />

      </div>
    </div>
  );
}
