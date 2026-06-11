# ADR-0001: Shell — Tauri 2 (web UI + Rust core)

- Status: Accepted
- Date: 2026-06-01

## Context

We are building a lightweight, language-agnostic IDE. We want native-app feel (fast startup, low memory), a rich and quickly-built UI, and a strong extension story. The candidate shells:

- **Electron** — bundles Chromium; large binaries, high idle RAM. Rejected on footprint.
- **Native GPU (GPUI / Floem + wgpu)** — Zed-class rendering, but young toolkits, no web component ecosystem, and "gorgeous out-of-box panels" become months of bespoke widget work. Highest performance ceiling, slowest dev velocity.
- **Fork Zed/Gram** — fastest route to a fast editor, but GPL/AGPL copyleft and we'd inherit someone else's architecture/identity.
- **Tauri 2** — Rust core + the OS's native webview (WebView2 / WKWebView / WebKitGTK). No bundled browser: ~95% smaller binaries than Electron, low idle RAM, fast cold start.

## Decision

Use **Tauri 2** as the application shell: a Rust core process for OS-facing and performance-sensitive work, and a web frontend rendered in the system webview for UI.

## Consequences

**We get**
- Zed-class startup and idle memory (no Chromium to boot or hold in RAM).
- The entire web ecosystem for building rich panels fast, and a natural JS extension story.
- A clean Rust boundary for filesystem, search, git, and protocol hosts.

**We accept**
- **Editing latency is webview-bound, not native.** The interactive editor surface goes through a DOM pipeline (key → JS → DOM mutation → layout → paint), same class as VSCode/Electron. We will *not* match Zed's ~2ms keystroke latency for interactive editing. Positioning is "fast like a native app, unlike Electron," **not** "fast like Zed." We make this explicit to avoid building toward a goal the stack can't reach.
- **Linux/WebKitGTK is the weak platform.** Its webview is slower and quirkier than the tuned Chromium VSCode ships. Mitigation: the tiered WebGL2 scroll path (ADR-0003) and disciplined DOM hygiene.
- Two languages (Rust + TS) and an IPC seam to design and keep coarse.

## Where we *can* beat the incumbents

Startup, idle memory, and **big-file scroll** (via the tiered renderer in ADR-0003). The honest play: best-of-both on the lightweight axes, parity on interactive latency, a real win on scroll.

## Addendum (2026-06-01): reaffirmed after re-examining native GPU (Floem/GPUI)

We revisited whether a Rust-native, GPU-accelerated UI (Floem, GPUI, raw `wgpu`) should replace the web frontend, on the theory it might yield an equally or more "gorgeous" UI. Conclusion: **stay on Tauri.** The reasoning, recorded so we don't relitigate:

1. **Visual ceiling ties; cost and required skills don't.** Native GPU can render anything the DOM can (Zed proves it) and can animate the *editor surface itself* at 120fps, which a webview can't. But reaching "gorgeous" natively means hand-building the substrate the web gives free: CSS-class styling (gradients/shadows/blur/transitions), a mature layout engine, the entire widget/component ecosystem, world-class text/i18n, live DevTools, and designer accessibility. For a small team the higher-leverage spend is our *built-in IDE frameworks* (the actual wedge, ADR-0005), not rebuilding a UI toolkit.

2. **Our day-one requirements are mostly rich chrome.** Dockable/floating panels (ADR-0010), gorgeous test/run/debug panels, suggestion UIs — exactly where the web's velocity advantage is largest and where native makes you build every widget from primitives. Our own priorities lean *harder* toward web.

3. **UI-contributing extensions are tractable on web, near-impossible natively.** A webview/iframe is a natural sandbox that can draw arbitrary third-party UI in the world's largest language ecosystem; native GPU has no equivalent, which is why Zed's extensions are deliberately narrow (no arbitrary panels). Given "fully extensible from day one" includes contributed tool windows, this is a second, independent vote for Tauri. See ADR-0006/0010.

4. **The native editor-surface win is partly recovered** by the tiered WebGL2 path (ADR-0003) where it's most visible (fling-scroll), without surrendering chrome velocity or the extension story.

**Accepted permanent costs of this choice:** the *interactive* editing surface will never feel as instant as Zed's native renderer (webview pipeline ceiling), and Linux/WebKitGTK chrome may feel slightly less crisp than native. If the editing-surface feel ever becomes the product's defining soul, the correct response is to *fork an existing native core (Zed/Gram)*, not to greenfield on Floem — rebuilding the fast editor core is the multi-year part. We are explicitly not making that bet.
