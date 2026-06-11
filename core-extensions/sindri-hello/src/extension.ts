/**
 * sindri-hello — M1 proof extension.
 *
 * Registers `hello.ping` to exercise the full host spine:
 *   bundle load → activate() → sindri.commands.register → execute_command → return to webview.
 *
 * M2 addition: `hello.readFile` exercises the async env bridge (sindri.env.fs.read).
 */

export function activate(context: ExtensionContext): void {
  context.subscriptions.push(
    sindri.commands.register("hello.ping", () => "pong from Deno") as unknown as { dispose(): void },
  );
}

export function deactivate(): void {
  // subscriptions are cleaned up by the host via context.subscriptions
}
