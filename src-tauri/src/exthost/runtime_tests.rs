// ADR-0037 inspector diagnostics — extracted from runtime.rs (B6 remediation).
use super::*;
use crate::env::LocalEnvironment;
use deno_core::{InspectorMsg, InspectorSessionChannels, InspectorSessionKind};
use futures::channel::mpsc;
use futures::StreamExt;
use std::time::Duration;

/// Reproduction probe: attach a CDP session to a running extension isolate
/// exactly as the gateway does, drive the Debugger.enable handshake, and dump
/// every inbound message so we can see whether `Debugger.scriptParsed` fires
/// for the bundle and whether `getScriptSource` returns the source.
#[tokio::test]
async fn cdp_handshake_reports_bundle_sources() {
    let tmp = tempfile::tempdir().unwrap();
    let bundle = tmp.path().join("ext.js");
    std::fs::write(
        &bundle,
        "var sindri_ext=(function(){function activate(c){console.log('hi');} return {activate};})();\n//# sourceMappingURL=ext.js.map\n",
    )
    .unwrap();
    // Adjacent *linked* map with embedded original source (sourcesContent). The fix
    // should inline this so DevTools can show src/ext.ts without a file:// fetch.
    std::fs::write(
        bundle.with_extension("js.map"),
        r#"{"version":3,"sources":["src/ext.ts"],"sourcesContent":["export function activate(){}"],"mappings":"AAAA","names":[]}"#,
    )
    .unwrap();

    let rt = ExtensionRuntime::new(Arc::new(LocalEnvironment), None)
        .await
        .expect("runtime boot");
    rt.load_and_activate(bundle.to_str().unwrap(), Some("test.ext"), None, HashMap::new(), None)
        .await
        .expect("activate");

    // Build the session pair the way inspector_gateway does.
    let (out_tx, mut out_rx) = mpsc::unbounded::<InspectorMsg>();
    let (in_tx, in_rx) = mpsc::unbounded::<String>();
    let proxy = InspectorSessionProxy {
        channels: InspectorSessionChannels::Regular { tx: out_tx, rx: in_rx },
        kind: InspectorSessionKind::NonBlocking { wait_for_disconnect: false },
    };
    rt.connect_inspector(proxy);

    in_tx.unbounded_send(r#"{"id":1,"method":"Runtime.enable"}"#.into()).unwrap();
    in_tx.unbounded_send(r#"{"id":2,"method":"Debugger.enable"}"#.into()).unwrap();

    let mut bundle_script_id: Option<String> = None;
    let mut all = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(150), out_rx.next()).await {
            Ok(Some(msg)) => {
                let c = msg.content.clone();
                if c.contains("scriptParsed") && c.contains("ext.js") {
                    if let Some(i) = c.find(r#""scriptId":""#) {
                        let rest = &c[i + 12..];
                        if let Some(j) = rest.find('"') {
                            bundle_script_id = Some(rest[..j].to_string());
                        }
                    }
                }
                all.push(c);
            }
            Ok(None) => break,
            Err(_) => {
                if let Some(id) = bundle_script_id.clone() {
                    in_tx
                        .unbounded_send(format!(
                            r#"{{"id":3,"method":"Debugger.getScriptSource","params":{{"scriptId":"{id}"}}}}"#
                        ))
                        .unwrap();
                    bundle_script_id = Some(format!("__asked__{id}"));
                }
            }
        }
    }

    eprintln!("=== CDP messages ({}) ===", all.len());
    for m in &all {
        eprintln!("{}", &m[..m.len().min(240)]);
    }

    assert!(
        all.iter().any(|m| m.contains("scriptParsed") && m.contains("ext.js")),
        "expected Debugger.scriptParsed for the bundle ext.js"
    );
    assert!(
        all.iter().any(|m| m.contains("getScriptSource") || m.contains("scriptSource")),
        "expected getScriptSource response carrying the bundle source"
    );
    assert!(
        all.iter().any(|m| m.contains("scriptSource") && m.contains("data:application/json;base64,")),
        "expected the bundle source to carry an inline source map data URI"
    );
}

/// Same handshake but driven through the REAL gateway (HTTP discovery + WS
/// upgrade + bridge), exactly as chrome://inspect would.
#[tokio::test]
async fn cdp_through_gateway_reports_sources() {
    use crate::inspector_gateway::{self, TargetEntry, TargetRegistry};
    use std::sync::Mutex as StdMutex;
    use tokio_tungstenite::tungstenite::Message as TMsg;

    let tmp = tempfile::tempdir().unwrap();
    let bundle = tmp.path().join("ext.js");
    std::fs::write(
        &bundle,
        "var sindri_ext=(function(){function activate(c){console.log('hi');} return {activate};})();\n",
    )
    .unwrap();

    let rt = Arc::new(
        ExtensionRuntime::new(Arc::new(LocalEnvironment), None)
            .await
            .expect("runtime boot"),
    );
    rt.load_and_activate(bundle.to_str().unwrap(), Some("test.ext"), None, HashMap::new(), None)
        .await
        .expect("activate");

    let registry: TargetRegistry = Arc::new(StdMutex::new(std::collections::HashMap::new()));
    registry.lock().unwrap().insert(
        "test.ext".to_string(),
        TargetEntry {
            name: "test.ext".into(),
            bundle_path: bundle.to_string_lossy().into_owned(),
            runtime: Arc::clone(&rt),
        },
    );

    let port = 29229u16;
    let reg = Arc::clone(&registry);
    tokio::spawn(async move {
        let _ = inspector_gateway::start(port, reg).await;
    });
    tokio::time::sleep(Duration::from_millis(150)).await;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio_tungstenite::tungstenite::protocol::Role;
    let mut sock = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.expect("tcp");
    let req = "GET /ws/test.ext HTTP/1.1\r\n\
               Host: 127.0.0.1\r\n\
               Upgrade: websocket\r\n\
               Connection: Upgrade\r\n\
               Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
               Sec-WebSocket-Version: 13\r\n\r\n";
    sock.write_all(req.as_bytes()).await.unwrap();
    let mut hbuf = Vec::new();
    let mut one = [0u8; 1];
    while !hbuf.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = sock.read(&mut one).await.unwrap();
        if n == 0 { break; }
        hbuf.push(one[0]);
    }
    assert!(
        String::from_utf8_lossy(&hbuf).contains("101"),
        "expected 101 Switching Protocols, got: {}",
        String::from_utf8_lossy(&hbuf)
    );
    let mut ws =
        tokio_tungstenite::WebSocketStream::from_raw_socket(sock, Role::Client, None).await;

    use futures::SinkExt;
    ws.send(TMsg::Text(r#"{"id":1,"method":"Runtime.enable"}"#.into())).await.unwrap();
    ws.send(TMsg::Text(r#"{"id":2,"method":"Debugger.enable"}"#.into())).await.unwrap();

    let mut all = Vec::new();
    let mut script_id: Option<String> = None;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(150), ws.next()).await {
            Ok(Some(Ok(TMsg::Text(s)))) => {
                let c = s.to_string();
                if c.contains("scriptParsed") && c.contains("ext.js") && script_id.is_none() {
                    if let Some(i) = c.find(r#""scriptId":""#) {
                        let rest = &c[i + 12..];
                        if let Some(j) = rest.find('"') {
                            let id = rest[..j].to_string();
                            ws.send(TMsg::Text(format!(
                                r#"{{"id":3,"method":"Debugger.getScriptSource","params":{{"scriptId":"{id}"}}}}"#
                            ).into())).await.unwrap();
                            script_id = Some(id);
                        }
                    }
                }
                all.push(c);
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(_))) | Ok(None) => break,
            Err(_) => {}
        }
    }

    eprintln!("=== GATEWAY CDP messages ({}) ===", all.len());
    for m in &all {
        eprintln!("{}", &m[..m.len().min(200)]);
    }

    assert!(
        all.iter().any(|m| m.contains("scriptParsed") && m.contains("ext.js")),
        "gateway path: expected scriptParsed for bundle"
    );
    assert!(
        all.iter().any(|m| m.contains("scriptSource")),
        "gateway path: expected getScriptSource response with the source"
    );
}
