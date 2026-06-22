/// CDP gateway for V8 Inspector debugging (ADR-0037).
///
/// Dev-only: bound to `127.0.0.1:9229`, never enabled in production builds.
///
/// Endpoints:
///   GET /json/version  → version metadata (CDP discovery)
///   GET /json          → target list
///   GET /json/list     → target list
///   GET /ws/<ext_id>   → WebSocket upgrade → bidirectional CDP bridge
///
/// Thread model: `start()` is spawned as a background tokio task on the main
/// runtime. Each accepted connection gets its own `tokio::spawn`.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use deno_core::{
    InspectorMsg, InspectorSessionChannels, InspectorSessionKind, InspectorSessionProxy,
};
use futures::channel::mpsc;
use futures::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::protocol::Role;
use tokio_tungstenite::WebSocketStream;

use crate::exthost::runtime::ExtensionRuntime;

// ── Target registry ───────────────────────────────────────────────────────────

/// Metadata for one debuggable extension target.
pub struct TargetEntry {
    /// Human-readable name shown in CDP target lists.
    pub name: String,
    /// Absolute path to the compiled extension bundle (surfaced as CDP `url`).
    pub bundle_path: String,
    /// Live runtime handle; used to inject inspector sessions.
    pub runtime: Arc<ExtensionRuntime>,
}

pub type TargetRegistry = Arc<Mutex<HashMap<String, TargetEntry>>>;

// ── Entry point ───────────────────────────────────────────────────────────────

/// Bind to `127.0.0.1:<port>` and serve CDP clients indefinitely.
/// Runs forever; intended to be `tokio::spawn`-ed as a background task.
pub async fn start(port: u16, registry: TargetRegistry) -> std::io::Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", port)).await?;
    loop {
        let (stream, _) = listener.accept().await?;
        let reg = Arc::clone(&registry);
        tokio::spawn(async move {
            if let Err(e) = handle_connection(stream, reg).await {
                eprintln!("[sindri cdp] connection error: {e}");
            }
        });
    }
}

// ── HTTP / WebSocket routing ──────────────────────────────────────────────────

/// Read one HTTP/1.1 request from `stream` (up to and including the blank line).
/// Returns `(path, headers_lowercase_key)` or `None` on malformed/truncated input.
async fn read_http_request(
    stream: &mut TcpStream,
) -> Option<(String, HashMap<String, String>)> {
    let mut buf = Vec::with_capacity(1024);
    let mut tmp = [0u8; 512];
    loop {
        let n = stream.read(&mut tmp).await.ok()?;
        if n == 0 { return None; }
        buf.extend_from_slice(&tmp[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") { break; }
        if buf.len() > 16 * 1024 { return None; } // guard against oversized requests
    }

    let text = String::from_utf8_lossy(&buf);
    let mut lines = text.lines();
    let request_line = lines.next()?;
    // "GET /path HTTP/1.1"
    let path = request_line.split_ascii_whitespace().nth(1)?.to_owned();

    let mut headers = HashMap::new();
    for line in lines {
        if line.is_empty() { break; }
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_lowercase(), v.trim().to_owned());
        }
    }

    Some((path, headers))
}

async fn handle_connection(
    mut stream: TcpStream,
    registry: TargetRegistry,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let Some((path, headers)) = read_http_request(&mut stream).await else {
        return Ok(());
    };

    let is_ws = headers
        .get("upgrade")
        .map_or(false, |v| v.eq_ignore_ascii_case("websocket"));

    if is_ws {
        if let Some(ext_id) = path.strip_prefix("/ws/") {
            let ext_id = ext_id.to_owned();
            let ws_key = headers.get("sec-websocket-key").cloned().unwrap_or_default();
            handle_ws_upgrade(stream, ext_id, ws_key, registry).await;
            return Ok(());
        }
        stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").await?;
        return Ok(());
    }

    // Plain HTTP discovery endpoints.
    let body = match path.as_str() {
        "/json/version" => version_json(),
        "/json" | "/json/list" => list_json(&registry),
        _ => {
            stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").await?;
            return Ok(());
        }
    };
    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
        body.len(),
        body
    );
    stream.write_all(resp.as_bytes()).await?;
    Ok(())
}

// ── CDP discovery JSON ────────────────────────────────────────────────────────

fn version_json() -> String {
    let ver = env!("CARGO_PKG_VERSION");
    format!(
        r#"{{"Browser":"Sindri/{ver}","Protocol-Version":"1.3"}}"#,
        ver = ver
    )
}

fn list_json(registry: &TargetRegistry) -> String {
    let guard = registry.lock().unwrap();
    let targets: Vec<String> = guard
        .iter()
        .map(|(id, entry)| {
            format!(
                r#"{{"id":{id_json},"title":{name_json},"type":"node","url":{url_json},"webSocketDebuggerUrl":"ws://127.0.0.1:9229/ws/{id}","description":""}}"#,
                id_json = json_str(id),
                name_json = json_str(&entry.name),
                url_json = json_str(&entry.bundle_path),
                id = id,
            )
        })
        .collect();
    format!("[{}]", targets.join(","))
}

fn json_str(s: &str) -> String {
    // Minimal JSON string escaping for ASCII-safe strings.
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

// ── WebSocket upgrade + bridge ────────────────────────────────────────────────

async fn handle_ws_upgrade(
    mut stream: TcpStream,
    ext_id: String,
    ws_key: String,
    registry: TargetRegistry,
) {
    // Build the inspector channel pair (ADR-0037 §3).
    // out_tx / out_rx: V8 → gateway (InspectorMsg)
    // in_tx  / in_rx:  gateway → V8 (raw CDP JSON strings)
    let (out_tx, out_rx) = mpsc::unbounded::<InspectorMsg>();
    let (in_tx, in_rx) = mpsc::unbounded::<String>();

    let proxy = InspectorSessionProxy {
        channels: InspectorSessionChannels::Regular { tx: out_tx, rx: in_rx },
        kind: InspectorSessionKind::NonBlocking { wait_for_disconnect: false },
    };

    // Look up the runtime and inject the session.
    let runtime = {
        let guard = registry.lock().unwrap();
        guard.get(&ext_id).map(|e| Arc::clone(&e.runtime))
    };
    let Some(runtime) = runtime else {
        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").await;
        return;
    };
    runtime.connect_inspector(proxy);

    // Complete the WebSocket handshake (RFC 6455 §4.2.2).
    let accept = ws_accept_key(&ws_key);
    let handshake = format!(
        "HTTP/1.1 101 Switching Protocols\r\n\
         Upgrade: websocket\r\n\
         Connection: Upgrade\r\n\
         Sec-WebSocket-Accept: {accept}\r\n\
         \r\n"
    );
    if stream.write_all(handshake.as_bytes()).await.is_err() {
        return;
    }

    // Wrap the raw stream as a server-side WebSocket (handshake already done).
    let ws = WebSocketStream::from_raw_socket(stream, Role::Server, None).await;
    run_bridge(ws, out_rx, in_tx).await;
}

/// Bridge a WebSocket session to a V8 inspector session.
///
/// - `out_rx`: V8-to-client channel; `InspectorMsg.content` is already a CDP JSON string.
/// - `in_tx`:  client-to-V8 channel; forwards raw WebSocket text frames.
async fn run_bridge(
    ws: WebSocketStream<TcpStream>,
    mut out_rx: mpsc::UnboundedReceiver<InspectorMsg>,
    in_tx: mpsc::UnboundedSender<String>,
) {
    use tokio_tungstenite::tungstenite::Message;

    let (mut ws_tx, mut ws_rx) = ws.split();

    loop {
        tokio::select! {
            biased;
            // V8 → WS: relay inspector messages to the CDP client.
            maybe_msg = out_rx.next() => match maybe_msg {
                Some(inspector_msg) => {
                    if ws_tx.send(Message::Text(inspector_msg.content.into())).await.is_err() {
                        break;
                    }
                }
                None => break, // inspector closed the channel
            },
            // WS → V8: forward CDP commands from the client to V8.
            maybe_frame = ws_rx.next() => match maybe_frame {
                Some(Ok(Message::Text(s))) => {
                    if in_tx.unbounded_send(s.to_string()).is_err() {
                        break;
                    }
                }
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => {} // ignore binary / ping / pong
                Some(Err(_)) => break,
            },
        }
    }
}

// ── WebSocket handshake helpers (RFC 6455 §4.2.2) ────────────────────────────

/// Derive the `Sec-WebSocket-Accept` response header value from the client's key.
/// = base64(sha1(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
fn ws_accept_key(client_key: &str) -> String {
    const MAGIC: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    let input = format!("{client_key}{MAGIC}");
    let hash = sha1(input.as_bytes());
    base64_encode(&hash)
}

/// SHA-1 (FIPS 180-4). Returns a 20-byte digest.
/// Used only for the WebSocket handshake accept-key derivation.
fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x6745_2301, 0xEFCD_AB89, 0x98BA_DCFE, 0x1032_5476, 0xC3D2_E1F0];
    let bit_len = (data.len() as u64) * 8;

    // Padding: append 0x80, then zeros, then 8-byte big-endian bit length.
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 { msg.push(0); }
    msg.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in msg.chunks(64) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([chunk[i*4], chunk[i*4+1], chunk[i*4+2], chunk[i*4+3]]);
        }
        for i in 16..80 {
            w[i] = (w[i-3] ^ w[i-8] ^ w[i-14] ^ w[i-16]).rotate_left(1);
        }

        let [mut a, mut b, mut c, mut d, mut e] = [h[0], h[1], h[2], h[3], h[4]];
        for i in 0..80 {
            let (f, k) = match i {
                0..=19  => ((b & c) | (!b & d), 0x5A82_7999u32),
                20..=39 => (b ^ c ^ d,           0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _       => (b ^ c ^ d,           0xCA62_C1D6),
            };
            let temp = a.rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(w[i]);
            e = d; d = c; c = b.rotate_left(30); b = a; a = temp;
        }
        h[0] = h[0].wrapping_add(a); h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c); h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }

    let mut out = [0u8; 20];
    for (i, word) in h.iter().enumerate() {
        out[i*4..i*4+4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

#[cfg(test)]
mod handshake_tests {
    use super::*;

    /// RFC 6455 §1.3 canonical example: key "dGhlIHNhbXBsZSBub25jZQ==" must yield
    /// accept "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=". Real Chrome validates this; if it's
    /// wrong the WS upgrade is rejected and DevTools' Sources panel stays empty.
    #[test]
    fn ws_accept_key_matches_rfc6455() {
        assert_eq!(
            ws_accept_key("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
    }

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }
}

/// Standard Base64 encoding (RFC 4648 §4).
pub(crate) fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 0x3F) as usize]);
        out.push(TABLE[((n >> 12) & 0x3F) as usize]);
        out.push(if chunk.len() > 1 { TABLE[((n >> 6) & 0x3F) as usize] } else { b'=' });
        out.push(if chunk.len() > 2 { TABLE[(n & 0x3F) as usize]         } else { b'=' });
    }
    String::from_utf8(out).unwrap()
}
