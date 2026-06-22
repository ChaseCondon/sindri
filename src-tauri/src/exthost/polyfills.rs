// Web API polyfills injected into every isolate after the main sindri bootstrap.
// These are not included in deno_core's minimal runtime; extensions expect them.
pub(super) const POLYFILLS: &str = r#"
if (typeof TextEncoder === 'undefined') {
    globalThis.TextEncoder = class TextEncoder {
        constructor() { this.encoding = 'utf-8'; }
        encode(s) { return Deno.core.encode(String(s ?? '')); }
        encodeInto(s, u8) {
            const b = Deno.core.encode(String(s ?? ''));
            u8.set(b.subarray(0, u8.length));
            return { read: Math.min(s.length, u8.length), written: Math.min(b.length, u8.length) };
        }
    };
}

if (typeof TextDecoder === 'undefined') {
    globalThis.TextDecoder = class TextDecoder {
        constructor(label) { this.encoding = label || 'utf-8'; }
        decode(b) { return Deno.core.decode(b instanceof Uint8Array ? b : new Uint8Array(b)); }
    };
}

// Timer polyfills backed by op_sleep_ms (tokio::time::sleep).
// Each handle is an object with an `active` flag; clearTimeout/clearInterval deactivates it.
{
    let __timerSeq = 0;
    const __timers = new Map();
    globalThis.setTimeout = function(fn, ms) {
        const id = ++__timerSeq;
        const h = { active: true };
        __timers.set(id, h);
        (async function() {
            await Deno.core.ops.op_sleep_ms(ms >>> 0);
            if (h.active) { __timers.delete(id); fn(); }
        })();
        return id;
    };
    globalThis.clearTimeout = function(id) {
        const h = __timers.get(id);
        if (h) { h.active = false; __timers.delete(id); }
    };
    globalThis.setInterval = function(fn, ms) {
        const id = ++__timerSeq;
        const h = { active: true };
        __timers.set(id, h);
        (async function loop() {
            while (h.active) {
                await Deno.core.ops.op_sleep_ms(ms >>> 0);
                if (h.active) fn();
            }
            __timers.delete(id);
        })();
        return id;
    };
    globalThis.clearInterval = function(id) {
        const h = __timers.get(id);
        if (h) { h.active = false; __timers.delete(id); }
    };
}
"#;
