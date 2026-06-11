/**
 * Pure utility helpers for Sindri extensions.
 *
 * Import these explicitly in extension source — they are bundled into the
 * extension output by the build pipeline (not injected by the host).
 *
 *   import { createWebviewHtml } from "@sindri/api/helpers";
 */

export interface WebviewHtmlOptions {
  /** Document <title>. Defaults to empty (no title element). */
  title?: string;
  /** <html lang="...">. Defaults to "en". */
  lang?: string;
  /** Whether to include a <link> for dist/webview.css. Defaults to true. */
  css?: boolean;
}

/**
 * Generate the standard HTML shell for a webview panel.
 *
 * Produces a minimal, null-origin-safe document that loads the extension's
 * compiled webview bundle via sindri-resource://. Use this in getHtml() to
 * avoid hand-writing the boilerplate in every extension:
 *
 *   import { createWebviewHtml } from "@sindri/api/helpers";
 *
 *   getHtml(_ctx: WebviewContext): string {
 *     return createWebviewHtml("my-publisher.my-ext");
 *   }
 *
 * The generated document mounts a <div id="root"> and loads:
 *   sindri-resource://<extId>/dist/webview.js   (always)
 *   sindri-resource://<extId>/dist/webview.css  (unless css: false)
 */
export function createWebviewHtml(extId: string, options: WebviewHtmlOptions = {}): string {
  const { title, lang = "en", css = true } = options;
  const titleTag = title ? `\n  <title>${title}</title>` : "";
  const cssTag = css
    ? `\n  <link rel="stylesheet" href="sindri-resource://${extId}/dist/webview.css">`
    : "";
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">${titleTag}${cssTag}
</head>
<body>
  <div id="root"></div>
  <script src="sindri-resource://${extId}/dist/webview.js"></script>
</body>
</html>`;
}
