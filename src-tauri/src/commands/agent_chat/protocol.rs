use super::types::{
    truncate_utf8, ChatAttachment, ChatItem, ChatModel, ChatRequest, MAX_ITEM_TEXT_BYTES,
    MAX_RPC_PARAMS_BYTES,
};
use crate::errors::CommandError;
use serde_json::{json, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt};

pub(super) fn rpc_request(id: Value, method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

pub(super) fn rpc_notification(method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "method": method, "params": params })
}

pub(super) fn rpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

pub(super) fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Read one newline-delimited JSON-RPC record with a hard byte ceiling.
pub(super) async fn read_protocol_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    limit: usize,
) -> Result<Option<Vec<u8>>, String> {
    let mut line = Vec::with_capacity(4096);
    loop {
        let available = reader.fill_buf().await.map_err(|e| e.to_string())?;
        if available.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Ok(Some(line))
            };
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(available.len(), |position| position + 1);
        if line.len().saturating_add(consumed) > limit {
            reader.consume(consumed);
            return Err("Codex app-server sent an oversized protocol line".to_string());
        }
        line.extend_from_slice(&available[..consumed]);
        reader.consume(consumed);
        if newline.is_some() {
            while matches!(line.last(), Some(b'\n' | b'\r')) {
                line.pop();
            }
            return Ok(Some(line));
        }
    }
}

pub(super) fn protocol_request_id_key(rpc_id: &Value) -> Option<String> {
    (rpc_id.is_string() || rpc_id.is_number()).then(|| rpc_id.to_string())
}

pub(super) fn display_request_id(
    thread_id: &str,
    runtime_generation: &str,
    rpc_id: &Value,
) -> String {
    format!("{thread_id}:{runtime_generation}:{}", rpc_id)
}

pub(super) fn classify_request(method: &str, params: &Value) -> Option<(&'static str, String)> {
    let (kind, fallback) = match method {
        "item/commandExecution/requestApproval" | "execCommandApproval" => {
            ("approval", "Command approval")
        }
        "item/fileChange/requestApproval" | "applyPatchApproval" => {
            ("approval", "File change approval")
        }
        "item/tool/requestUserInput" => ("question", "Codex has a question"),
        "mcpServer/elicitation/request" => ("elicitation", "Additional information requested"),
        _ => return None,
    };
    let title = params
        .get("command")
        .and_then(Value::as_str)
        .map(|command| format!("Approve command: {}", truncate_utf8(command, 120)))
        .or_else(|| {
            params
                .get("serverName")
                .and_then(Value::as_str)
                .map(|server| format!("Information requested by {}", truncate_utf8(server, 100)))
        })
        .unwrap_or_else(|| fallback.to_string());
    Some((kind, title))
}

pub(super) fn visible_request_params(params: &Value) -> Result<Value, String> {
    let encoded =
        serde_json::to_vec(params).map_err(|_| "Request parameters were invalid".to_string())?;
    if encoded.len() > MAX_RPC_PARAMS_BYTES {
        return Err("Interactive request exceeded the supported size and was rejected".to_string());
    }
    Ok(params.clone())
}

pub(super) fn validate_request_response(
    request: &ChatRequest,
    response: &Value,
) -> Result<(), CommandError> {
    match request.method.as_str() {
        "item/commandExecution/requestApproval" => validate_decision(
            request,
            response,
            &["accept", "acceptForSession", "decline", "cancel"],
            true,
        ),
        "item/fileChange/requestApproval" => validate_decision(
            request,
            response,
            &["accept", "acceptForSession", "decline", "cancel"],
            true,
        ),
        "execCommandApproval" | "applyPatchApproval" => validate_decision(
            request,
            response,
            &["approved", "approved_for_session", "abort", "timed_out"],
            false,
        ),
        "item/tool/requestUserInput" => validate_user_answers(request, response),
        "mcpServer/elicitation/request" => validate_elicitation(response),
        _ => Err(CommandError::Validation {
            field: "response".into(),
            reason: "This Codex request type is not supported".into(),
        }),
    }
}

fn validate_decision(
    request: &ChatRequest,
    response: &Value,
    allowed: &[&str],
    check_available: bool,
) -> Result<(), CommandError> {
    let decision = response
        .get("decision")
        .and_then(Value::as_str)
        .ok_or_else(|| CommandError::Validation {
            field: "response.decision".into(),
            reason: "A supported approval decision is required".into(),
        })?;
    if !allowed.contains(&decision) {
        return Err(CommandError::Validation {
            field: "response.decision".into(),
            reason: "That approval decision is not supported".into(),
        });
    }
    if check_available {
        let decisions = request
            .params
            .get("availableDecisions")
            .and_then(Value::as_array)
            .ok_or_else(|| CommandError::Validation {
                field: "response.decision".into(),
                reason: "Codex did not provide its offered approval decisions".into(),
            })?;
        let offered = decisions
            .iter()
            .any(|value| value.as_str() == Some(decision));
        if !offered {
            return Err(CommandError::Validation {
                field: "response.decision".into(),
                reason: "Codex did not offer that approval decision".into(),
            });
        }
    }
    Ok(())
}

fn validate_user_answers(request: &ChatRequest, response: &Value) -> Result<(), CommandError> {
    let answers = response
        .get("answers")
        .and_then(Value::as_object)
        .ok_or_else(|| CommandError::Validation {
            field: "response.answers".into(),
            reason: "Answers must be an object keyed by question ID".into(),
        })?;
    let questions = request
        .params
        .get("questions")
        .and_then(Value::as_array)
        .ok_or_else(|| CommandError::Validation {
            field: "request.questions".into(),
            reason: "Codex provided an invalid question request".into(),
        })?;
    for question in questions {
        let Some(id) = question.get("id").and_then(Value::as_str) else {
            return Err(CommandError::Validation {
                field: "request.questions".into(),
                reason: "Codex provided a question without an ID".into(),
            });
        };
        let answer =
            answers
                .get(id)
                .and_then(Value::as_object)
                .ok_or_else(|| CommandError::Validation {
                    field: format!("response.answers.{id}"),
                    reason: "Every question needs an answer".into(),
                })?;
        let values = answer
            .get("answers")
            .and_then(Value::as_array)
            .ok_or_else(|| CommandError::Validation {
                field: format!("response.answers.{id}.answers"),
                reason: "Answers must be a list of text values".into(),
            })?;
        if values.iter().any(|value| !value.is_string()) {
            return Err(CommandError::Validation {
                field: format!("response.answers.{id}.answers"),
                reason: "Answers must contain only text values".into(),
            });
        }
    }
    if answers.keys().any(|key| {
        !questions
            .iter()
            .any(|question| question.get("id").and_then(Value::as_str) == Some(key))
    }) {
        return Err(CommandError::Validation {
            field: "response.answers".into(),
            reason: "An answer referenced an unknown question".into(),
        });
    }
    Ok(())
}

fn validate_elicitation(response: &Value) -> Result<(), CommandError> {
    let action = response
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| CommandError::Validation {
            field: "response.action".into(),
            reason: "Choose accept, decline, or cancel".into(),
        })?;
    if !["accept", "decline", "cancel"].contains(&action) {
        return Err(CommandError::Validation {
            field: "response.action".into(),
            reason: "Choose accept, decline, or cancel".into(),
        });
    }
    if action == "accept" && !response.get("content").is_some_and(Value::is_object) {
        return Err(CommandError::Validation {
            field: "response.content".into(),
            reason: "Accepted elicitation responses need an object in content".into(),
        });
    }
    Ok(())
}

pub(super) fn normalize_models(value: &Value) -> Vec<ChatModel> {
    value
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|model| model.get("hidden").and_then(Value::as_bool) != Some(true))
        .filter_map(|model| {
            let id = model.get("id")?.as_str()?.to_string();
            let label = model.get("displayName")?.as_str()?.to_string();
            let reasoning_efforts = model
                .get("supportedReasoningEfforts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|effort| effort.get("reasoningEffort").and_then(Value::as_str))
                .map(str::to_string)
                .collect();
            Some(ChatModel {
                id,
                label,
                description: model
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                is_default: model
                    .get("isDefault")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                reasoning_efforts,
                default_reasoning_effort: model
                    .get("defaultReasoningEffort")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                input_modalities: model
                    .get("inputModalities")
                    .and_then(Value::as_array)
                    .and_then(|modalities| {
                        modalities
                            .iter()
                            .map(|modality| modality.as_str().map(str::to_string))
                            .collect()
                    }),
            })
        })
        .collect()
}

pub(super) fn image_input_support(model: &ChatModel) -> Option<bool> {
    model
        .input_modalities
        .as_ref()
        .map(|modalities| modalities.iter().any(|modality| modality == "image"))
}

pub(super) fn build_turn_input(text: &str, attachments: &[ChatAttachment]) -> Vec<Value> {
    let mut input = Vec::new();
    if !text.trim().is_empty() {
        input.push(json!({ "type": "text", "text": text }));
    }
    let mut file_references = Vec::new();
    for attachment in attachments {
        if attachment.kind == "image" {
            input.push(json!({ "type": "localImage", "path": attachment.path }));
        } else {
            file_references.push(format!("\"{}\"", attachment.path.replace('"', "\\\"")));
        }
    }
    if !file_references.is_empty() {
        let refs = file_references.join("\n");
        input.push(json!({
            "type": "text",
            "text": format!("Attached local file references:\n{refs}")
        }));
    }
    input
}

pub(super) fn normalize_item(
    item: &Value,
    turn_id: Option<&str>,
    status: &str,
) -> Option<ChatItem> {
    let provider_id = item.get("id").and_then(Value::as_str)?;
    let item_type = item
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("activity");
    let kind = match item_type {
        "userMessage" => return None,
        "agentMessage" => "assistant",
        "reasoning" => "reasoning",
        "commandExecution" | "mcpToolCall" | "webSearch" | "imageView" | "dynamicToolCall"
        | "functionCallOutput" => "tool",
        "fileChange" => "fileChange",
        "plan" => "plan",
        _ => "activity",
    };
    let text = item_text(item, item_type);
    let status = item
        .get("status")
        .and_then(Value::as_str)
        .map(provider_item_status)
        .unwrap_or(status);
    Some(ChatItem {
        id: provider_id.to_string(),
        turn_id: turn_id.map(str::to_string),
        kind: kind.to_string(),
        text,
        status: Some(status.to_string()),
        attachments: Vec::new(),
    })
}

/// Convert a persisted provider-history item to the compact Ship Studio shape.
/// Live `item/completed` events deliberately continue to use `normalize_item`
/// so a user echo cannot duplicate the locally accepted prompt.
pub(super) fn normalize_history_item(item: &Value, turn_id: &str) -> Option<ChatItem> {
    if item.get("type").and_then(Value::as_str) == Some("userMessage") {
        let id = item
            .get("clientId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .or_else(|| item.get("id").and_then(Value::as_str))?;
        return Some(ChatItem {
            id: id.to_string(),
            turn_id: Some(turn_id.to_string()),
            kind: "user".into(),
            text: user_message_text(item),
            status: Some("completed".into()),
            attachments: Vec::new(),
        });
    }
    normalize_item(item, Some(turn_id), "completed")
}

fn user_message_text(item: &Value) -> String {
    let text = item
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|content| content.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|content| content.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    if let Some((prompt, references)) = text.rsplit_once("\nAttached local file references:\n") {
        let references_are_paths = references
            .lines()
            .all(|line| line.starts_with('"') && line.ends_with('"') && line.len() > 2);
        if !references.is_empty() && references_are_paths {
            return prompt.to_string();
        }
    }
    text
}

pub(super) fn item_text(item: &Value, item_type: &str) -> String {
    match item_type {
        "agentMessage" => item
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        "reasoning" => item
            .get("summary")
            .and_then(Value::as_array)
            .map(|parts| flatten_text(Some(&Value::Array(parts.clone()))))
            .or_else(|| {
                item.get("summaryText")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_default(),
        "commandExecution" => {
            let command = item
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or("Command");
            let output = item
                .get("aggregatedOutput")
                .and_then(Value::as_str)
                .filter(|output| !output.is_empty());
            match output {
                Some(output) => format!("{command}\n{output}"),
                None => command.to_string(),
            }
        }
        "mcpToolCall" => {
            let server = item.get("server").and_then(Value::as_str).unwrap_or("MCP");
            let name = item.get("tool").and_then(Value::as_str).unwrap_or("tool");
            let content = item
                .get("result")
                .and_then(|result| result.get("content"))
                .and_then(|content| text_content(content, &["text", "input_text"]));
            format_tool_output(&format!("{server}: {name}"), content)
        }
        "dynamicToolCall" => {
            let namespace = item
                .get("namespace")
                .and_then(Value::as_str)
                .unwrap_or("Tool");
            let name = item.get("tool").and_then(Value::as_str).unwrap_or("tool");
            let content = item
                .get("contentItems")
                .and_then(|content| text_content(content, &["inputText"]));
            format_tool_output(&format!("{namespace}: {name}"), content)
        }
        "functionCallOutput" => {
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Function tool");
            let output = item.get("output").and_then(|output| match output {
                Value::String(text) => Some(text.clone()),
                other => text_content(other, &["input_text"]),
            });
            format_tool_output(name, output)
        }
        "fileChange" => describe_file_changes(item),
        "plan" => flatten_text(item.get("plan").or_else(|| item.get("text"))),
        _ => item
            .get("message")
            .or_else(|| item.get("query"))
            .and_then(Value::as_str)
            .unwrap_or(item_type)
            .to_string(),
    }
}

fn text_content(value: &Value, accepted_types: &[&str]) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    let values = value.as_array()?;
    let text = values
        .iter()
        .filter(|item| {
            item.get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| accepted_types.contains(&kind))
        })
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>();
    if text.is_empty() {
        None
    } else {
        Some(text.join("\n"))
    }
}

fn format_tool_output(label: &str, output: Option<String>) -> String {
    match output.filter(|output| !output.trim().is_empty()) {
        Some(output) => format!("{label}\n{output}"),
        None => format!("{label}\nNon-text tool output omitted"),
    }
}

fn flatten_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| {
                part.as_str()
                    .map(str::to_string)
                    .or_else(|| part.get("text").and_then(Value::as_str).map(str::to_string))
            })
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

fn describe_file_changes(item: &Value) -> String {
    let changes = item.get("changes").and_then(Value::as_array);
    let paths = changes
        .into_iter()
        .flatten()
        .filter_map(|change| change.get("path").and_then(Value::as_str))
        .take(40)
        .collect::<Vec<_>>();
    if paths.is_empty() {
        return "File changes".to_string();
    }
    format!("Changed files:\n{}", paths.join("\n"))
}

fn provider_item_status(status: &str) -> &str {
    match status {
        "inProgress" => "running",
        "completed" | "failed" | "declined" => status,
        _ => "unknown",
    }
}

pub(super) fn attachment_user_item(
    id: String,
    text: String,
    attachments: Vec<ChatAttachment>,
) -> ChatItem {
    ChatItem {
        id,
        turn_id: None,
        kind: "user".to_string(),
        text: truncate_utf8(&text, MAX_ITEM_TEXT_BYTES),
        status: Some("submitted".to_string()),
        attachments,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_provider_items_by_stable_id_and_replaces_user_echoes() {
        let assistant = normalize_item(
            &json!({"id":"item-1","type":"agentMessage","text":"hello"}),
            Some("turn-1"),
            "completed",
        )
        .unwrap();
        assert_eq!(assistant.id, "item-1");
        assert_eq!(assistant.kind, "assistant");
        assert_eq!(assistant.turn_id.as_deref(), Some("turn-1"));
        assert_eq!(assistant.text, "hello");
        assert!(
            normalize_item(&json!({"id":"u-1","type":"userMessage"}), None, "completed").is_none()
        );
    }

    #[test]
    fn reconciles_provider_user_history_without_echoing_local_file_references() {
        let item = normalize_history_item(
            &json!({
                "id":"user-1",
                "clientId":"attempt-1",
                "type":"userMessage",
                "content":[
                    {"type":"text","text":"Please review this"},
                    {"type":"localImage","path":"/app/photo.png"},
                    {"type":"text","text":"Attached local file references:\n\"/app/notes.txt\""}
                ]
            }),
            "turn-1",
        )
        .unwrap();
        assert_eq!(item.id, "attempt-1");
        assert_eq!(item.kind, "user");
        assert_eq!(item.text, "Please review this");
        assert_eq!(item.turn_id.as_deref(), Some("turn-1"));
    }

    #[test]
    fn normalizes_only_provider_exposed_reasoning_summary() {
        let item = normalize_item(
            &json!({"id":"reason-1","type":"reasoning","summary":[{"type":"summary_text","text":"Brief summary"}],"text":"private reasoning"}),
            None,
            "running",
        )
        .unwrap();
        assert_eq!(item.kind, "reasoning");
        assert_eq!(item.text, "Brief summary");
    }

    #[test]
    fn maps_only_provider_models_and_reasoning_efforts() {
        let models = normalize_models(&json!({"data":[
            {"id":"m1","displayName":"Model One","description":"desc","isDefault":true,"hidden":false,"supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"high"}],"defaultReasoningEffort":"low","inputModalities":["text","image","future-modality"]},
            {"id":"m2","displayName":"Unknown capabilities","hidden":false},
            {"id":"hidden","displayName":"Hidden","hidden":true}
        ]}));
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "m1");
        assert_eq!(models[0].reasoning_efforts, ["low", "high"]);
        assert_eq!(
            models[0].input_modalities.as_deref(),
            Some(
                [
                    "text".to_string(),
                    "image".to_string(),
                    "future-modality".to_string()
                ]
                .as_slice()
            )
        );
        assert_eq!(models[1].input_modalities, None);
        assert_eq!(image_input_support(&models[0]), Some(true));
        assert_eq!(image_input_support(&models[1]), None);
    }

    #[test]
    fn keeps_numeric_and_string_request_ids_distinct_and_runtime_scoped() {
        let number = json!(7);
        let string = json!("7");
        assert_ne!(
            protocol_request_id_key(&number),
            protocol_request_id_key(&string)
        );
        assert_eq!(
            display_request_id("thread-a", "runtime-1", &number),
            "thread-a:runtime-1:7"
        );
        assert_eq!(
            display_request_id("thread-a", "runtime-1", &string),
            "thread-a:runtime-1:\"7\""
        );
        assert_ne!(
            display_request_id("thread-a", "runtime-1", &number),
            display_request_id("thread-a", "runtime-2", &number)
        );
        assert!(protocol_request_id_key(&Value::Null).is_none());
    }

    #[test]
    fn distinguishes_explicitly_unsupported_images_from_unknown_capabilities() {
        let models = normalize_models(&json!({"data":[
            {"id":"text-only","displayName":"Text only","inputModalities":["text"]},
            {"id":"unknown","displayName":"Unknown"}
        ]}));
        assert_eq!(image_input_support(&models[0]), Some(false));
        assert_eq!(image_input_support(&models[1]), None);
    }

    #[test]
    fn rejects_stale_question_ids_and_malformed_elicitation() {
        let question = ChatRequest {
            id: "r1".into(),
            method: "item/tool/requestUserInput".into(),
            kind: "question".into(),
            title: "Question".into(),
            params: json!({"questions":[{"id":"q1"}]}),
        };
        assert!(validate_request_response(
            &question,
            &json!({"answers":{"old":{"answers":["x"]}}})
        )
        .is_err());
        let elicitation = ChatRequest {
            id: "r2".into(),
            method: "mcpServer/elicitation/request".into(),
            kind: "elicitation".into(),
            title: "Elicitation".into(),
            params: json!({}),
        };
        assert!(validate_request_response(&elicitation, &json!({"action":"accept"})).is_err());
        assert!(validate_request_response(&elicitation, &json!({"action":"decline"})).is_ok());
    }

    #[test]
    fn approval_responses_require_an_exact_offered_base_decision() {
        let request = ChatRequest {
            id: "approval-1".into(),
            method: "item/commandExecution/requestApproval".into(),
            kind: "approval".into(),
            title: "Approval".into(),
            params: json!({
                "availableDecisions": [
                    {"acceptWithExecpolicyAmendment": {"execpolicyAmendment": []}},
                    "decline",
                    "cancel"
                ]
            }),
        };
        assert!(validate_request_response(&request, &json!({"decision":"decline"})).is_ok());
        assert!(validate_request_response(&request, &json!({"decision":"cancel"})).is_ok());
        assert!(validate_request_response(&request, &json!({"decision":"accept"})).is_err());
        assert!(validate_request_response(
            &request,
            &json!({"decision":"acceptWithExecpolicyAmendment"})
        )
        .is_err());

        let mut missing_offers = request.clone();
        missing_offers.params = json!({});
        assert!(
            validate_request_response(&missing_offers, &json!({"decision":"decline"})).is_err()
        );

        let file_change = ChatRequest {
            method: "item/fileChange/requestApproval".into(),
            params: json!({"availableDecisions":["cancel"]}),
            ..request
        };
        assert!(validate_request_response(&file_change, &json!({"decision":"cancel"})).is_ok());
        assert!(validate_request_response(&file_change, &json!({"decision":"decline"})).is_err());
    }

    #[test]
    fn builds_image_inputs_and_explicit_quoted_file_references() {
        let attachments = vec![
            ChatAttachment {
                id: "i".into(),
                name: "photo.png".into(),
                path: "/app/photo.png".into(),
                mime_type: "image/png".into(),
                size: 12,
                kind: "image".into(),
                available: true,
            },
            ChatAttachment {
                id: "f".into(),
                name: "notes.txt".into(),
                path: "/app/notes.txt".into(),
                mime_type: "text/plain".into(),
                size: 20,
                kind: "file".into(),
                available: true,
            },
        ];
        let input = build_turn_input("look", &attachments);
        assert_eq!(input[0]["type"], "text");
        assert_eq!(
            input[1],
            json!({"type":"localImage","path":"/app/photo.png"})
        );
        assert!(input[2]["text"]
            .as_str()
            .unwrap()
            .contains("\"/app/notes.txt\""));
    }

    #[test]
    fn completed_items_keep_provider_text_output_and_file_paths() {
        let message = normalize_item(
            &json!({"id":"msg-1","type":"agentMessage","text":"Final answer"}),
            Some("turn-1"),
            "completed",
        )
        .unwrap();
        assert_eq!(message.text, "Final answer");

        let command = normalize_item(
            &json!({"id":"cmd-1","type":"commandExecution","command":"cargo check","aggregatedOutput":"Finished successfully","status":"completed"}),
            Some("turn-1"),
            "completed",
        )
        .unwrap();
        assert!(command.text.contains("Finished successfully"));
        assert_eq!(command.status.as_deref(), Some("completed"));

        let file_change = normalize_item(
            &json!({"id":"file-1","type":"fileChange","changes":[{"path":"src/main.rs","kind":{"type":"update"},"diff":"@@"}],"status":"declined"}),
            Some("turn-1"),
            "completed",
        )
        .unwrap();
        assert!(file_change.text.contains("src/main.rs"));
        assert_eq!(file_change.status.as_deref(), Some("declined"));

        let mcp_result = normalize_item(
            &json!({"id":"mcp-1","type":"mcpToolCall","server":"preview","tool":"inspect","result":{"content":[{"type":"text","text":"Rendered page title"},{"type":"image","data":"sensitive-base64-payload"}]},"status":"completed"}),
            Some("turn-1"),
            "completed",
        )
        .unwrap();
        assert!(mcp_result.text.contains("Rendered page title"));
        assert!(!mcp_result.text.contains("sensitive-base64-payload"));
    }
}
