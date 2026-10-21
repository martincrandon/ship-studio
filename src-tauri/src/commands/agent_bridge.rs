//! Commands for the agent preview bridge (the global loopback MCP server that
//! lets the workspace agent read the preview's console/network/DOM, interact
//! with the page, navigate it, and take screenshots). The server itself lives
//! in `crate::agent_bridge` and starts at app launch.

use crate::agent_bridge;
use crate::errors::CommandError;
use crate::utils::{validate_project_file_path, validate_project_path};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

/// The MCP URL to register for this project (starts the global bridge if it
/// isn't running yet). The project path rides inside the URL so the server
/// can route tool calls to whichever window has the project open.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn get_agent_bridge_url(
    app: tauri::AppHandle,
    project_path: String,
) -> Result<String, CommandError> {
    let validated = validate_project_path(&project_path)?;
    let canonical = validated.to_string_lossy().to_string();
    agent_bridge::agent_bridge_url_for_project(app, &canonical)
        .await
        .map_err(CommandError::from)
}

/// The "active project" MCP URL for agents with global configs (Codex,
/// Opencode, Cursor): tool calls resolve to the focused project at call time.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn get_agent_bridge_active_url(app: tauri::AppHandle) -> Result<String, CommandError> {
    agent_bridge::agent_bridge_active_url(app)
        .await
        .map_err(CommandError::from)
}

/// Register the bridge in Cursor's MCP config. Cursor's CLI has no `mcp add`
/// subcommand — its config is `~/.cursor/mcp.json` — so we merge our entry
/// in directly, preserving everything else. Returns false (without touching
/// anything) when Cursor isn't in use or its config can't be parsed: never
/// risk destroying another tool's configuration.
#[tauri::command]
#[tracing::instrument]
pub async fn register_cursor_mcp(url: String) -> Result<bool, CommandError> {
    let Some(home) = dirs::home_dir() else {
        return Err(("Could not determine home directory".to_string()).into());
    };
    let cursor_dir = home.join(".cursor");
    if !cursor_dir.is_dir() {
        // Cursor has never run on this machine — don't create its config.
        return Ok(false);
    }
    let path = cursor_dir.join("mcp.json");
    let mut root: serde_json::Value = if path.exists() {
        // EACCES on ~/.cursor (left root-owned by a sudo install) is the
        // user's environment — classify it instead of a raw OS string (#867).
        let raw = std::fs::read_to_string(&path)
            .map_err(|e| crate::utils::classify_fs_error("read Cursor's mcp.json", &path, &e))?;
        match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("Cursor mcp.json is not valid JSON — leaving it untouched: {e}");
                return Ok(false);
            }
        }
    } else {
        serde_json::json!({})
    };
    let Some(root_obj) = root.as_object_mut() else {
        tracing::warn!("Cursor mcp.json root is not an object — leaving it untouched");
        return Ok(false);
    };
    let servers = root_obj
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));
    let Some(servers_obj) = servers.as_object_mut() else {
        tracing::warn!("Cursor mcp.json mcpServers is not an object — leaving it untouched");
        return Ok(false);
    };
    let already_current = servers_obj
        .get("shipstudio-preview")
        .and_then(|s| s.get("url"))
        .and_then(|u| u.as_str())
        == Some(url.as_str());
    if !already_current {
        servers_obj.insert(
            "shipstudio-preview".to_string(),
            serde_json::json!({ "url": url }),
        );
        let serialized = serde_json::to_string_pretty(&root)
            .map_err(|e| format!("Failed to serialize Cursor mcp.json: {e}"))?;
        std::fs::write(&path, serialized)
            .map_err(|e| crate::utils::classify_fs_error("write Cursor's mcp.json", &path, &e))?;
        tracing::info!("Registered shipstudio-preview in Cursor's mcp.json");
    }
    Ok(true)
}

/// Mark this project's preview bridge listener as attached (mounted and
/// answering) or detached. Detached projects fail tool calls fast with an
/// honest "preview isn't active" message instead of a long timeout.
#[tauri::command]
#[tracing::instrument]
pub async fn agent_bridge_attach(project_path: String, attached: bool) -> Result<(), CommandError> {
    let validated = validate_project_path(&project_path)?;
    let canonical = validated.to_string_lossy().to_string();
    agent_bridge::set_project_attached(&canonical, attached);
    Ok(())
}

/// Base64 payloads above this are returned as a "read this file" note instead
/// of inline image content — huge inline images blow up the agent's context.
const MAX_INLINE_IMAGE_BASE64_CHARS: usize = 2_000_000;

/// Upper bound on one reassembled chunked result. Real results are a few MB
/// at most (images never travel this way); this only stops a runaway sender.
const MAX_CHUNKED_RESULT_BYTES: usize = 32 * 1024 * 1024;

/// A partially received chunked result.
struct ChunkBuffer {
    next_index: u32,
    total: u32,
    data: String,
}

/// Partially received chunked results, keyed by request id.
static CHUNK_BUFFERS: LazyLock<Mutex<HashMap<u64, ChunkBuffer>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, PartialEq)]
enum ChunkOutcome {
    /// More chunks are expected.
    Pending,
    /// The last chunk arrived; here is the whole serialized result.
    Complete(String),
    /// The sequence is unusable (out of order, inconsistent, too large).
    Rejected(String),
}

fn discard_chunks(request_id: u64) {
    if let Ok(mut buffers) = CHUNK_BUFFERS.lock() {
        buffers.remove(&request_id);
    }
}

/// Append one piece of a chunked result. Chunks are sent strictly in order
/// (the frontend awaits each invoke), so anything else is a broken sequence.
fn append_chunk(request_id: u64, index: u32, total: u32, chunk: &str) -> ChunkOutcome {
    let Ok(mut buffers) = CHUNK_BUFFERS.lock() else {
        return ChunkOutcome::Rejected("chunk buffer lock poisoned".to_string());
    };
    if total == 0 || index >= total {
        buffers.remove(&request_id);
        return ChunkOutcome::Rejected(format!("chunk {index} of {total} is out of range"));
    }
    if index == 0 {
        buffers.insert(
            request_id,
            ChunkBuffer {
                next_index: 0,
                total,
                data: String::new(),
            },
        );
    }
    let Some(buffer) = buffers.get_mut(&request_id) else {
        return ChunkOutcome::Rejected(format!("chunk {index} arrived without chunk 0"));
    };
    if buffer.total != total || buffer.next_index != index {
        buffers.remove(&request_id);
        return ChunkOutcome::Rejected(format!("chunk {index} of {total} arrived out of sequence"));
    }
    if buffer.data.len() + chunk.len() > MAX_CHUNKED_RESULT_BYTES {
        buffers.remove(&request_id);
        return ChunkOutcome::Rejected(format!(
            "result exceeds {} MB",
            MAX_CHUNKED_RESULT_BYTES / (1024 * 1024)
        ));
    }
    buffer.data.push_str(chunk);
    buffer.next_index += 1;
    if buffer.next_index < total {
        return ChunkOutcome::Pending;
    }
    let done = buffers
        .remove(&request_id)
        .map(|b| b.data)
        .unwrap_or_default();
    ChunkOutcome::Complete(done)
}

/// Inline image items the frontend sent by reference (`{ type: "image",
/// mimeType, path }`): read the file and put its base64 in `data`, or — past
/// the inline cap or on a read failure — swap in a text item naming the file.
/// Screenshot bytes never cross the JSON IPC this way (issue #1128).
fn inline_image_files<F>(mut result: Value, read: F) -> Value
where
    F: Fn(&str) -> Result<Vec<u8>, String>,
{
    use base64::Engine;
    let Some(items) = result.get_mut("content").and_then(Value::as_array_mut) else {
        return result;
    };
    for item in items.iter_mut() {
        let is_file_ref =
            item.get("type").and_then(Value::as_str) == Some("image") && item.get("data").is_none();
        if !is_file_ref {
            continue;
        }
        let Some(path) = item.get("path").and_then(Value::as_str).map(str::to_string) else {
            continue;
        };
        *item = match read(&path) {
            Ok(bytes) => {
                let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
                if encoded.len() > MAX_INLINE_IMAGE_BASE64_CHARS {
                    json!({ "type": "text", "text": format!(
                        "Screenshot captured but too large to return inline. It was saved to: {path} — read that file to view it."
                    ) })
                } else {
                    let mime = item
                        .get("mimeType")
                        .and_then(Value::as_str)
                        .unwrap_or("image/png")
                        .to_string();
                    json!({ "type": "image", "data": encoded, "mimeType": mime })
                }
            }
            Err(e) => json!({ "type": "text", "text": format!(
                "Screenshot was saved to {path} but Ship Studio couldn't read it back to return inline ({e}). Read that file to view it."
            ) }),
        };
    }
    result
}

fn read_project_file(path: &str) -> Result<Vec<u8>, String> {
    let validated = validate_project_file_path(path).map_err(|e| e.to_string())?;
    std::fs::read(&validated).map_err(|e| e.to_string())
}

fn deliver(request_id: u64, result: Value) {
    let result = inline_image_files(result, read_project_file);
    if !agent_bridge::resolve_bridge_request(request_id, result) {
        // Not an error worth failing on: the call likely timed out server-side
        // moments before the frontend answered.
        tracing::warn!(
            "[AgentBridge] Response for request {} arrived after timeout (dropped)",
            request_id
        );
    }
}

/// Answer an in-flight bridge tool call. `result` must be a full MCP
/// CallToolResult ({ content: [...], isError? }) — it is passed through to
/// the agent verbatim, after image items sent by path are inlined. Only for
/// small results: larger ones go through `agent_bridge_respond_chunk`.
#[tauri::command]
#[tracing::instrument(skip(result))]
pub async fn agent_bridge_respond(request_id: u64, result: Value) -> Result<(), CommandError> {
    deliver(request_id, result);
    Ok(())
}

/// Answer a bridge tool call whose result is too large for one IPC request.
/// On macOS a large invoke body can reach Rust truncated (wry reads WebKit's
/// body stream only while bytes are already available), which surfaced as
/// "unexpected end of hex escape" and left the agent's call hanging (issue
/// #1128). The frontend sends the serialized result in ordered pieces; the
/// last one triggers parsing and delivery. Anything that goes wrong is
/// answered in-band so the agent is told instead of timing out.
#[tauri::command]
#[tracing::instrument(skip(chunk), fields(chunk_len = chunk.len()))]
pub async fn agent_bridge_respond_chunk(
    request_id: u64,
    index: u32,
    total: u32,
    chunk: String,
) -> Result<(), CommandError> {
    if !agent_bridge::is_bridge_request_pending(request_id) {
        discard_chunks(request_id);
        tracing::warn!(
            "[AgentBridge] Chunk for request {} arrived after timeout (dropped)",
            request_id
        );
        return Ok(());
    }
    let result = match append_chunk(request_id, index, total, &chunk) {
        ChunkOutcome::Pending => return Ok(()),
        ChunkOutcome::Complete(serialized) => match serde_json::from_str::<Value>(&serialized) {
            Ok(value) => value,
            Err(e) => {
                tracing::error!(
                    "[AgentBridge] Reassembled result for request {} ({} bytes) is not valid JSON: {}",
                    request_id,
                    serialized.len(),
                    e
                );
                agent_bridge::tool_error_result(&format!(
                    "Ship Studio ran the tool but its result was corrupted on the way back ({e}). This is a Ship Studio bug, not a problem with the page. Retrying may help."
                ))
            }
        },
        ChunkOutcome::Rejected(reason) => {
            tracing::error!(
                "[AgentBridge] Chunked result for request {} rejected: {}",
                request_id,
                reason
            );
            agent_bridge::tool_error_result(&format!(
                "Ship Studio ran the tool but couldn't hand its result back ({reason}). This is a Ship Studio bug, not a problem with the page. Retrying may help."
            ))
        }
    };
    deliver(request_id, result);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_reassemble_in_order() {
        let id = 9_000_001;
        assert_eq!(append_chunk(id, 0, 3, "{\"con"), ChunkOutcome::Pending);
        assert_eq!(append_chunk(id, 1, 3, "tent\":"), ChunkOutcome::Pending);
        assert_eq!(
            append_chunk(id, 2, 3, "[]}"),
            ChunkOutcome::Complete("{\"content\":[]}".to_string())
        );
        // The buffer is released once complete.
        assert!(matches!(
            append_chunk(id, 1, 3, "x"),
            ChunkOutcome::Rejected(_)
        ));
    }

    #[test]
    fn single_chunk_completes_immediately() {
        assert_eq!(
            append_chunk(9_000_002, 0, 1, "{}"),
            ChunkOutcome::Complete("{}".to_string())
        );
    }

    #[test]
    fn out_of_sequence_chunk_is_rejected_and_buffer_dropped() {
        let id = 9_000_003;
        assert_eq!(append_chunk(id, 0, 3, "a"), ChunkOutcome::Pending);
        assert!(matches!(
            append_chunk(id, 2, 3, "c"),
            ChunkOutcome::Rejected(_)
        ));
        assert!(matches!(
            append_chunk(id, 1, 3, "b"),
            ChunkOutcome::Rejected(_)
        ));
    }

    #[test]
    fn inconsistent_total_or_range_is_rejected() {
        let id = 9_000_004;
        assert_eq!(append_chunk(id, 0, 3, "a"), ChunkOutcome::Pending);
        assert!(matches!(
            append_chunk(id, 1, 4, "b"),
            ChunkOutcome::Rejected(_)
        ));
        assert!(matches!(
            append_chunk(id, 0, 0, ""),
            ChunkOutcome::Rejected(_)
        ));
        assert!(matches!(
            append_chunk(id, 5, 3, ""),
            ChunkOutcome::Rejected(_)
        ));
    }

    #[test]
    fn non_ascii_and_escapes_survive_reassembly() {
        let original = json!({ "content": [{ "type": "text", "text": "\u{1b}[31mrød 🚀 \"q\"" }] });
        let serialized = serde_json::to_string(&original).unwrap();
        let (a, b) = serialized.split_at(serialized.find('r').unwrap());
        let id = 9_000_005;
        assert_eq!(append_chunk(id, 0, 2, a), ChunkOutcome::Pending);
        let ChunkOutcome::Complete(joined) = append_chunk(id, 1, 2, b) else {
            panic!("expected completion");
        };
        assert_eq!(serde_json::from_str::<Value>(&joined).unwrap(), original);
    }

    #[test]
    fn image_file_refs_are_inlined() {
        let result = json!({ "content": [
            { "type": "image", "mimeType": "image/png", "path": "/p/s.png" },
            { "type": "text", "text": "Screenshot (saved to /p/s.png)." },
        ] });
        let out = inline_image_files(result, |p| {
            assert_eq!(p, "/p/s.png");
            Ok(b"hello".to_vec())
        });
        assert_eq!(
            out["content"][0],
            json!({ "type": "image", "data": "aGVsbG8=", "mimeType": "image/png" })
        );
        assert_eq!(out["content"][1]["type"], "text");
    }

    #[test]
    fn inline_images_are_left_alone() {
        let result =
            json!({ "content": [{ "type": "image", "data": "abc", "mimeType": "image/png" }] });
        let out = inline_image_files(result.clone(), |_| panic!("must not read"));
        assert_eq!(out, result);
    }

    #[test]
    fn oversized_image_becomes_a_path_note() {
        let result = json!({ "content": [{ "type": "image", "mimeType": "image/png", "path": "/p/big.png" }] });
        let out = inline_image_files(result, |_| Ok(vec![0u8; MAX_INLINE_IMAGE_BASE64_CHARS]));
        assert_eq!(out["content"][0]["type"], "text");
        let text = out["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("too large") && text.contains("/p/big.png"));
    }

    #[test]
    fn unreadable_image_becomes_an_in_band_note() {
        let result = json!({ "content": [{ "type": "image", "mimeType": "image/png", "path": "/p/gone.png" }] });
        let out = inline_image_files(result, |_| Err("not found".to_string()));
        let text = out["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("/p/gone.png") && text.contains("not found"));
    }
}
