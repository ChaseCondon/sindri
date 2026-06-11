/**
 * Sindri extension host API — ADR-0015 §4.
 *
 * Ambient declarations only. No imports needed in extensions — `sindri` is injected
 * as a global by the Deno/V8 extension host (ADR-0025).
 *
 * Install via: bun add --dev @sindri/api
 * Then add to tsconfig compilerOptions: "types": ["@sindri/api"]
 *
 * Only namespaces declared here are implemented in the host today.
 * Stubs for future namespaces (sindri.editor, sindri.lsp, etc.) are included for
 * type-ahead but will throw at runtime until their host implementations land.
 */

// ─── Shared types ────────────────────────────────────────────────────────────

declare interface ExtensionContext {
  /** Disposables registered here are cleaned up when the extension deactivates. */
  subscriptions: { dispose(): void }[];
}

/** Mirror of env.rs ProcessSpec (ADR-0009 / ADR-0014). */
declare interface ProcessSpec {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: "null" | "inherit";
}

declare interface ExecOutput {
  code: number | null;
  stdout: string;
  stderr: string;
}

// ─── sindri.commands (M1) ────────────────────────────────────────────────────

declare interface SindriCommands {
  register(id: string, handler: (...args: unknown[]) => unknown): void;
  execute(id: string, ...args: unknown[]): Promise<unknown>;
}

// ─── sindri.env (M2) ─────────────────────────────────────────────────────────

declare interface SindriEnvFs {
  read(path: string): Promise<string>;
  glob(pattern: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
}

declare interface SindriEnv {
  /** Absolute path to the currently open workspace folder, or null if none is open. */
  readonly workspaceRoot: string | null;
  fs: SindriEnvFs;
  exec(cmd: string, ...args: string[]): Promise<ExecOutput>;
}

// ─── sindri.ui (ADR-0026) ────────────────────────────────────────────────────

declare interface StatusBarItem {
  text: string;
  tooltip: string;
  show(): void;
  hide(): void;
  dispose(): void;
}

declare interface QuickPickItem {
  label: string;
  description?: string;
  detail?: string;
}

declare interface QuickPickOptions {
  placeholder?: string;
  title?: string;
}

declare interface Disposable {
  dispose(): void;
}

declare interface QuickPick<T extends QuickPickItem = QuickPickItem> {
  items: T[];
  readonly selectedItems: ReadonlyArray<T>;
  placeholder: string;
  title: string;
  show(): void;
  hide(): void;
  dispose(): void;
  onDidAccept(handler: () => void): Disposable;
  onDidHide(handler: () => void): Disposable;
  onDidChangeValue(handler: (value: string) => void): Disposable;
}

declare interface TreeViewProvider<T = unknown> {
  getChildren(element?: T): T[] | Promise<T[]>;
  getTreeItem(element: T): TreeItem;
}

declare interface TreeItem {
  id?: string;
  label: string;
  description?: string;
  tooltip?: string;
  iconPath?: string;
  collapsibleState?: 0 | 1 | 2;
  command?: { title: string; command: string; arguments?: unknown[] };
  contextValue?: string;
}

declare type DockId = "left-top" | "left-bottom" | "right-top" | "right-bottom" | "top" | "bottom";

declare interface WebviewContext {
  postMessage(msg: unknown): void;
}

declare interface WebviewPanelProvider {
  getHtml(context: WebviewContext): string;
  onMessage?(msg: unknown): void;
}

declare interface WebviewPanel {
  postMessage(msg: unknown): void;
  dispose(): void;
}

declare interface SindriUi {
  createStatusBarItem(id: string, options?: { text?: string; tooltip?: string }): StatusBarItem;
  registerTreeView(id: string, options: { treeDataProvider: TreeViewProvider }): Disposable;
  showQuickPick(items: QuickPickItem[], options?: QuickPickOptions): Promise<QuickPickItem | undefined>;
  createQuickPick<T extends QuickPickItem = QuickPickItem>(): QuickPick<T>;
  registerWebviewPanel(
    contribution: { id: string; title: string; icon?: string; defaultDock?: DockId },
    provider: WebviewPanelProvider,
  ): WebviewPanel;
}

// ─── sindri.output (ADR-0030) ────────────────────────────────────────────────

declare interface OutputChannel {
  /**
   * Append a line of text to the channel. A newline is appended automatically.
   * The line appears immediately in the Extension Logs panel.
   */
  appendLine(value: string): void;

  /**
   * Append text without a trailing newline. Text accumulates in a per-channel
   * buffer; a complete line is displayed whenever '\n' is encountered or
   * appendLine() is called.
   */
  append(value: string): void;

  /** Clear all output from this channel in the panel. */
  clear(): void;

  /** Focus the Extension Logs panel and select this channel. */
  show(): void;

  dispose(): void;
}

declare interface SindriOutput {
  /**
   * Create a named output channel. The channel appears under the calling
   * extension in the Extension Logs panel alongside its auto-captured
   * Console channel. No permission required.
   */
  createOutputChannel(name: string): OutputChannel;
}

// ─── sindri.events (M3) ──────────────────────────────────────────────────────

declare interface SindriEvents {
  on(eventId: string, handler: (payload: unknown) => void): void;
  emit(eventId: string, payload: unknown): void;
}

// ─── Global injection ────────────────────────────────────────────────────────

declare const sindri: {
  /** Command registry — register and execute named commands. Implemented in M1. */
  commands: SindriCommands;
  /** Environment access — all FS and process calls must go through here (ADR-0009). Implemented in M2. */
  env: SindriEnv;
  /** Event bus — broadcast and subscribe to typed events. Implemented in M3. */
  events: SindriEvents;
  /** UI components — status bar items, tree views, webview panels (ADR-0026). */
  ui: SindriUi;
  /** Extension output channels — auto-captured console + named channels (ADR-0030). */
  output: SindriOutput;
};
