import { registerToolWindow, openToolWindow } from "./layout";
import { FileExplorer, FileExplorerHeaderActions } from "./panels/FileExplorer";
import { TerminalPanel } from "./panels/TerminalPanel";
import { ExtensionLogsPanel } from "./panels/ExtensionLogsPanel";
import { makePlaceholder } from "./panels/PlaceholderPanel";
import {
  ICON_EXPLORER,
  ICON_SEARCH,
  ICON_GIT,
  ICON_DEBUG,
  ICON_RUN,
  ICON_TEST,
  ICON_EXTENSIONS,
  ICON_TERMINAL,
  ICON_PROBLEMS,
  ICON_OUTPUT,
  ICON_EXT_LOGS,
  ICON_DATABASE,
  ICON_REMOTE,
  ICON_SETTINGS,
  ICON_CONTAINERS,
  ICON_SNIPPETS,
  ICON_BOOKMARKS,
} from "../icons/ui-icons";

export function registerBuiltins(): void {
  // ── Left top zone ────────────────────────────────────────────────
  registerToolWindow({
    id: "explorer",
    title: "Explorer",
    icon: ICON_EXPLORER,
    defaultDock: "left-top",
    render: FileExplorer,
    headerActions: FileExplorerHeaderActions,
  });
  registerToolWindow({
    id: "search",
    title: "Search",
    icon: ICON_SEARCH,
    defaultDock: "left-top",
    render: makePlaceholder("Search"),
  });
  registerToolWindow({
    id: "git",
    title: "Source Control",
    icon: ICON_GIT,
    defaultDock: "left-top",
    render: makePlaceholder("Source Control"),
  });
  registerToolWindow({
    id: "run",
    title: "Run",
    icon: ICON_RUN,
    defaultDock: "left-top",
    render: makePlaceholder("Run"),
  });
  registerToolWindow({
    id: "debug",
    title: "Debug",
    icon: ICON_DEBUG,
    defaultDock: "left-top",
    render: makePlaceholder("Debug"),
  });
  registerToolWindow({
    id: "test",
    title: "Tests",
    icon: ICON_TEST,
    defaultDock: "left-top",
    render: makePlaceholder("Tests"),
  });
  registerToolWindow({
    id: "extensions",
    title: "Extensions",
    icon: ICON_EXTENSIONS,
    defaultDock: "left-top",
    render: makePlaceholder("Extensions"),
  });
  registerToolWindow({
    id: "remote",
    title: "Remote",
    icon: ICON_REMOTE,
    defaultDock: "left-top",
    render: makePlaceholder("Remote"),
  });
  registerToolWindow({
    id: "database",
    title: "Database",
    icon: ICON_DATABASE,
    defaultDock: "left-top",
    render: makePlaceholder("Database"),
  });
  registerToolWindow({
    id: "containers",
    title: "Containers",
    icon: ICON_CONTAINERS,
    defaultDock: "left-top",
    render: makePlaceholder("Containers"),
  });
  registerToolWindow({
    id: "snippets",
    title: "Snippets",
    icon: ICON_SNIPPETS,
    defaultDock: "left-top",
    render: makePlaceholder("Snippets"),
  });
  registerToolWindow({
    id: "bookmarks",
    title: "Bookmarks",
    icon: ICON_BOOKMARKS,
    defaultDock: "left-top",
    render: makePlaceholder("Bookmarks"),
  });
  registerToolWindow({
    id: "settings",
    title: "Settings",
    icon: ICON_SETTINGS,
    defaultDock: "left-top",
    render: makePlaceholder("Settings"),
  });

  // ── Bottom dock ──────────────────────────────────────────────────
  registerToolWindow({
    id: "terminal",
    title: "Terminal",
    icon: ICON_TERMINAL,
    defaultDock: "bottom",
    render: TerminalPanel,
  });
  registerToolWindow({
    id: "problems",
    title: "Problems",
    icon: ICON_PROBLEMS,
    defaultDock: "bottom",
    render: makePlaceholder("Problems"),
  });
  registerToolWindow({
    id: "output",
    title: "Output",
    icon: ICON_OUTPUT,
    defaultDock: "bottom",
    render: makePlaceholder("Output"),
  });
  registerToolWindow({
    id: "ext-logs",
    title: "Extension Logs",
    icon: ICON_EXT_LOGS,
    defaultDock: "bottom",
    render: ExtensionLogsPanel,
  });

  // Open defaults on first launch
  openToolWindow("explorer");
  openToolWindow("terminal");
}
