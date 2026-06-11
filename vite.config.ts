import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import basicSsl from "@vitejs/plugin-basic-ssl";

export default defineConfig(({ mode }) => {
  // TAURI_DEV_HOST is set for remote/mobile targets; desktop tauri dev leaves it unset.
  const host = process.env.TAURI_DEV_HOST;

  return {
    // basicSsl only in pure browser dev (bun run dev).
    // When mode === "tauri", devUrl is http:// so WebView2 would get ERR_EMPTY_RESPONSE
    // if Vite serves https. Use `bun run dev:tauri` (--mode tauri) from beforeDevCommand.
    plugins: [solid(), ...(mode !== "tauri" ? [basicSsl()] : [])],
    // Prevent Vite from obscuring Rust errors.
    clearScreen: false,
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? { protocol: "ws", host, port: 1421 }
        : undefined,
      watch: {
        // Don't watch the Rust side; Cargo handles it.
        ignored: ["**/src-tauri/**"],
      },
    },
    // Tauri uses a fixed set of modern targets; no need to down-level.
    build: {
      target: "es2022",
      minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
      sourcemap: !!process.env.TAURI_DEBUG,
    },
  };
});
