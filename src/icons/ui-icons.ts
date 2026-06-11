// Sindri runic UI icon set — activity bar, dock bars, toolbar.
// SVG sources live in core-extensions/sindri-ui-icons/icons/ — same layout
// as a third-party UI icon extension. This file is the v0 registration shim.

import { registerUiIconPack } from "../theme/registry";
import explorerSvg    from "../../core-extensions/sindri-ui-icons/icons/explorer.svg?raw";
import searchSvg      from "../../core-extensions/sindri-ui-icons/icons/search.svg?raw";
import gitSvg         from "../../core-extensions/sindri-ui-icons/icons/git.svg?raw";
import runSvg         from "../../core-extensions/sindri-ui-icons/icons/run.svg?raw";
import debugSvg       from "../../core-extensions/sindri-ui-icons/icons/debug.svg?raw";
import testSvg        from "../../core-extensions/sindri-ui-icons/icons/test.svg?raw";
import extensionsSvg  from "../../core-extensions/sindri-ui-icons/icons/extensions.svg?raw";
import terminalSvg    from "../../core-extensions/sindri-ui-icons/icons/terminal.svg?raw";
import problemsSvg    from "../../core-extensions/sindri-ui-icons/icons/problems.svg?raw";
import outputSvg      from "../../core-extensions/sindri-ui-icons/icons/output.svg?raw";
import databaseSvg    from "../../core-extensions/sindri-ui-icons/icons/database.svg?raw";
import remoteSvg      from "../../core-extensions/sindri-ui-icons/icons/remote.svg?raw";
import settingsSvg    from "../../core-extensions/sindri-ui-icons/icons/settings.svg?raw";
import containersSvg  from "../../core-extensions/sindri-ui-icons/icons/containers.svg?raw";
import snippetsSvg    from "../../core-extensions/sindri-ui-icons/icons/snippets.svg?raw";
import bookmarksSvg   from "../../core-extensions/sindri-ui-icons/icons/bookmarks.svg?raw";
import extLogsSvg     from "../../core-extensions/sindri-ui-icons/icons/ext-logs.svg?raw";

export const ICON_EXPLORER     = explorerSvg;
export const ICON_SEARCH       = searchSvg;
export const ICON_GIT          = gitSvg;
export const ICON_RUN          = runSvg;
export const ICON_DEBUG        = debugSvg;
export const ICON_TEST         = testSvg;
export const ICON_EXTENSIONS   = extensionsSvg;
export const ICON_TERMINAL     = terminalSvg;
export const ICON_PROBLEMS     = problemsSvg;
export const ICON_OUTPUT       = outputSvg;
export const ICON_DATABASE     = databaseSvg;
export const ICON_REMOTE       = remoteSvg;
export const ICON_SETTINGS     = settingsSvg;
export const ICON_CONTAINERS   = containersSvg;
export const ICON_SNIPPETS     = snippetsSvg;
export const ICON_BOOKMARKS    = bookmarksSvg;
export const ICON_EXT_LOGS     = extLogsSvg;

// ---------------------------------------------------------------------------
// Register built-in "Sindri UI" pack
// Call this at startup alongside registerBuiltinThemes / registerBuiltinIconThemes
// ---------------------------------------------------------------------------

export function registerBuiltinUiPack(): void {
  registerUiIconPack({
    id:   "sindri-ui-icons",
    name: "Sindri UI Icons",
    icons: {
      explorer:   explorerSvg,
      search:     searchSvg,
      git:        gitSvg,
      run:        runSvg,
      debug:      debugSvg,
      test:       testSvg,
      extensions: extensionsSvg,
      terminal:   terminalSvg,
      problems:   problemsSvg,
      output:     outputSvg,
      database:   databaseSvg,
      remote:     remoteSvg,
      settings:   settingsSvg,
      containers: containersSvg,
      snippets:   snippetsSvg,
      bookmarks:  bookmarksSvg,
      "ext-logs": extLogsSvg,
    },
  });
}
