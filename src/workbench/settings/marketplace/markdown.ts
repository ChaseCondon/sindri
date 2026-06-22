// Markdown renderer + syntax tokenizer for the marketplace detail pane.

export type TokenKind = "keyword" | "string" | "number" | "comment" | "type" | "fn" | "default";

const KEYWORD_SETS: Record<string, RegExp> = {
  TypeScript:  /\b(interface|type|const|let|var|function|class|async|await|return|import|export|from|if|throw|new|extends|implements|void|string|number|boolean|null|undefined|true|false|Promise)\b/g,
  JavaScript:  /\b(const|let|var|function|class|async|await|return|import|export|from|if|throw|new|true|false|null|undefined)\b/g,
  Rust:        /\b(pub|fn|let|mut|struct|impl|use|return|if|self|for|in|match|Some|None|Ok|Err|true|false|String|HashMap|Vec|Option|Result)\b/g,
  Python:      /\b(def|class|import|from|return|if|else|elif|for|in|True|False|None|self|raise|with|as|not|and|or|yield|async|await)\b/g,
  Go:          /\b(package|import|func|var|type|struct|interface|return|if|else|for|range|make|new|defer|go|chan|map|true|false|nil|sync|string|error)\b/g,
  Java:        /\b(public|private|class|interface|void|return|new|import|static|final|if|throws|String|Optional|Map|HashMap)\b/g,
  Kotlin:      /\b(fun|val|var|class|data|interface|object|companion|when|is|in|return|import|package|private|public|override|suspend|null|true|false|String|Int|Boolean|List|Map|check|withContext)\b/g,
  HTML:        /\b(DOCTYPE|html|head|body|div|span|h1|h2|h3|p|a|img|input|button|form|ul|ol|li|meta|link|script|style|main|section|header|footer|nav|article|class|id|href|src|type|lang|charset|onclick)\b/g,
  Svelte:      /\b(let|const|function|if|else|each|await|import|export|from|\$state|\$derived|\$effect|script|style|main|div|span|button|h1|p|true|false|null)\b/g,
  JSON:        /null|true|false/g,
  XML:         /</g,
};

export function tokenise(code: string, lang: string): Array<{ text: string; kind: TokenKind }> {
  const tokens: Array<{ text: string; kind: TokenKind }> = [];
  let rest = code;

  while (rest.length > 0) {
    const lineComment = rest.match(/^(\/\/[^\n]*|#[^\n]*)/);
    if (lineComment) { tokens.push({ text: lineComment[0], kind: "comment" }); rest = rest.slice(lineComment[0].length); continue; }
    const blockComment = rest.match(/^\/\*[\s\S]*?\*\//);
    if (blockComment) { tokens.push({ text: blockComment[0], kind: "comment" }); rest = rest.slice(blockComment[0].length); continue; }
    const xmlComment = rest.match(/^<!--[\s\S]*?-->/);
    if (xmlComment) { tokens.push({ text: xmlComment[0], kind: "comment" }); rest = rest.slice(xmlComment[0].length); continue; }
    const strMatch = rest.match(/^(`[^`]*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/);
    if (strMatch) { tokens.push({ text: strMatch[0], kind: "string" }); rest = rest.slice(strMatch[0].length); continue; }
    const numMatch = rest.match(/^\b\d+(\.\d+)?\b/);
    if (numMatch) { tokens.push({ text: numMatch[0], kind: "number" }); rest = rest.slice(numMatch[0].length); continue; }
    const kwRe = KEYWORD_SETS[lang];
    if (kwRe) {
      kwRe.lastIndex = 0;
      const m = kwRe.exec(rest);
      if (m && m.index === 0) { tokens.push({ text: m[0], kind: "keyword" }); rest = rest.slice(m[0].length); continue; }
    }
    const typeMatch = rest.match(/^[A-Z][A-Za-z0-9_<>]*/);
    if (typeMatch) { tokens.push({ text: typeMatch[0], kind: "type" }); rest = rest.slice(typeMatch[0].length); continue; }
    const fnMatch = rest.match(/^([a-z_][a-zA-Z0-9_]*)(?=\s*\()/);
    if (fnMatch) { tokens.push({ text: fnMatch[0], kind: "fn" }); rest = rest.slice(fnMatch[0].length); continue; }
    tokens.push({ text: rest[0], kind: "default" });
    rest = rest.slice(1);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Markdown → sanitized HTML renderer
// ---------------------------------------------------------------------------

export function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inlineMd(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "`") {
      const end = s.indexOf("`", i + 1);
      if (end !== -1) {
        out += `<code>${escHtml(s.slice(i + 1, end))}</code>`;
        i = end + 1;
        continue;
      }
    }
    out += s[i++];
  }
  return out
    .replace(/\*\*([^*\n]{1,200})\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]{1,100})\*/g, "<em>$1</em>");
}

function renderMarkdown(md: string): string {
  const lines = md.split("\n");
  const parts: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("```")) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      parts.push(`<pre><code>${escHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    if (line.startsWith("|") && i + 1 < lines.length && /^\|[\s\-|:]+\|/.test(lines[i + 1])) {
      const header = line.split("|").filter(Boolean);
      i += 2;
      const th = header.map((c) => `<th>${inlineMd(c.trim())}</th>`).join("");
      const trs: string[] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        const cells = lines[i].split("|").filter(Boolean);
        const td = cells.map((c) => `<td>${inlineMd(c.trim())}</td>`).join("");
        trs.push(`<tr>${td}</tr>`);
        i++;
      }
      parts.push(`<table><thead><tr>${th}</tr></thead><tbody>${trs.join("")}</tbody></table>`);
      continue;
    }

    if (line.startsWith("### ")) { parts.push(`<h3>${inlineMd(line.slice(4))}</h3>`); i++; continue; }
    if (line.startsWith("## "))  { parts.push(`<h2>${inlineMd(line.slice(3))}</h2>`); i++; continue; }
    if (line.startsWith("# "))   { parts.push(`<h1>${inlineMd(line.slice(2))}</h1>`); i++; continue; }

    if (line.startsWith("> ")) {
      parts.push(`<blockquote>${inlineMd(line.slice(2))}</blockquote>`);
      i++; continue;
    }

    if (line.startsWith("- ") || line.startsWith("* ")) {
      const items: string[] = [];
      while (i < lines.length && (lines[i].startsWith("- ") || lines[i].startsWith("* "))) {
        items.push(`<li>${inlineMd(lines[i].slice(2))}</li>`);
        i++;
      }
      parts.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    if (line.trim() === "") { i++; continue; }

    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("#") &&
      !lines[i].startsWith(">") &&
      !lines[i].startsWith("- ") &&
      !lines[i].startsWith("* ") &&
      !lines[i].startsWith("|") &&
      !lines[i].startsWith("```")
    ) {
      paraLines.push(inlineMd(lines[i]));
      i++;
    }
    if (paraLines.length > 0) parts.push(`<p>${paraLines.join(" ")}</p>`);
  }

  return parts.join("\n");
}

export function safeRenderMarkdown(md: string): string {
  try { return renderMarkdown(md); } catch { return `<pre>${escHtml(md)}</pre>`; }
}
