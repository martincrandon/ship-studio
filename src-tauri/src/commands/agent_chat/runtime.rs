use super::protocol::{read_protocol_line, rpc_request};
use super::AgentChatService;
use crate::errors::CommandError;
use serde_json::Value;
use std::path::Path;
use std::process::Stdio;
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};
use tokio::time::{timeout, Duration};

const PROTOCOL_LINE_LIMIT: usize = 2 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MINIMUM_CODEX_VERSION: (u64, u64, u64) = (0, 162, 1);

#[derive(Clone)]
pub(super) struct RuntimeControl {
    pub(super) outbound: mpsc::Sender<Value>,
    stop: mpsc::Sender<StopCommand>,
    pid: Option<u32>,
}

struct StopCommand {
    reason: String,
    acknowledgement: Option<oneshot::Sender<()>>,
}

enum ServerEvent {
    Message(Value),
    Failure(String),
    Closed,
}

impl RuntimeControl {
    pub(super) async fn stop(&self, reason: String) {
        let (tx, rx) = oneshot::channel();
        if self
            .stop
            .send(StopCommand {
                reason,
                acknowledgement: Some(tx),
            })
            .await
            .is_ok()
        {
            if timeout(Duration::from_secs(5), rx).await.is_err() {
                if let Some(pid) = self.pid {
                    terminate_process_tree(pid);
                }
            }
        } else if let Some(pid) = self.pid {
            terminate_process_tree(pid);
        }
    }

    pub(super) fn stop_now(&self, reason: String) {
        let _ = self.stop.try_send(StopCommand {
            reason,
            acknowledgement: None,
        });
        if let Some(pid) = self.pid {
            terminate_process_tree(pid);
        }
    }
}

pub(super) async fn spawn_process(
    service: AgentChatService,
    thread_id: String,
    project_path: &Path,
    checkout_path: &Path,
    preview_url: &str,
) -> Result<RuntimeControl, CommandError> {
    let binary = crate::commands::claude::find_validated_binary("codex", "--version")
        .ok_or_else(|| CommandError::expected("Codex app-server is unavailable"))?;
    let mut version_command = crate::utils::create_command(&binary);
    version_command
        .arg("--version")
        .env("PATH", crate::utils::get_extended_path());
    let version_output = crate::external_command::run_with_timeout(
        tokio::process::Command::from(version_command),
        "Codex version check",
        8,
    )
    .await?;
    let version = String::from_utf8_lossy(&version_output.stdout);
    if !version_output.status.success() || !supports_minimum_version(&version) {
        return Err(CommandError::expected(format!(
            "Agent Chat requires Codex CLI {minimum} or newer for supported app-server history reconciliation; found {found}",
            minimum = format_version(MINIMUM_CODEX_VERSION),
            found = version.trim().chars().take(100).collect::<String>(),
        )));
    }
    let config_value = serde_json::to_string(preview_url).map_err(|error| CommandError::Other {
        message: format!("Could not prepare the project preview connection: {error}"),
    })?;
    let mcp_override = format!("mcp_servers.shipstudio-preview.url={config_value}");

    let mut command = crate::utils::create_command(binary);
    command
        .args(["app-server", "--listen", "stdio://", "-c", &mcp_override])
        .current_dir(checkout_path)
        .env("PATH", crate::utils::get_extended_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (name, value) in crate::commands::accounts::get_env_vars_for_project(project_path) {
        command.env(name, value);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let mut child = tokio::process::Command::from(command)
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            CommandError::expected(format!("Could not start Codex app-server: {error}"))
        })?;
    let pid = child.id();
    let stdin = child.stdin.take().ok_or_else(|| CommandError::Other {
        message: "Codex app-server did not provide an input stream".into(),
    })?;
    let stdout = child.stdout.take().ok_or_else(|| CommandError::Other {
        message: "Codex app-server did not provide an output stream".into(),
    })?;
    let stderr = child.stderr.take().ok_or_else(|| CommandError::Other {
        message: "Codex app-server did not provide an error stream".into(),
    })?;

    let (outbound, mut outbound_rx) = mpsc::channel::<Value>(128);
    let event_outbound = outbound.clone();
    let (stop, mut stop_rx) = mpsc::channel::<StopCommand>(1);
    let (events_tx, mut events_rx) = mpsc::channel::<ServerEvent>(64);

    let mut stdin = stdin;
    let writer_events = events_tx.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(message) = outbound_rx.recv().await {
            let mut encoded = match serde_json::to_vec(&message) {
                Ok(encoded) => encoded,
                Err(error) => {
                    let _ = writer_events
                        .send(ServerEvent::Failure(format!(
                            "Could not encode a Codex request: {error}"
                        )))
                        .await;
                    return;
                }
            };
            encoded.push(b'\n');
            if let Err(error) = stdin.write_all(&encoded).await {
                let _ = writer_events
                    .send(ServerEvent::Failure(format!(
                        "Could not send a Codex request: {error}"
                    )))
                    .await;
                return;
            }
            if let Err(error) = stdin.flush().await {
                let _ = writer_events
                    .send(ServerEvent::Failure(format!(
                        "Could not flush a Codex request: {error}"
                    )))
                    .await;
                return;
            }
        }
    });

    let stdout_events = events_tx.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_protocol_line(&mut reader, PROTOCOL_LINE_LIMIT).await {
                Ok(Some(line)) if line.is_empty() => continue,
                Ok(Some(line)) => match serde_json::from_slice::<Value>(&line) {
                    Ok(message) => {
                        if stdout_events
                            .send(ServerEvent::Message(message))
                            .await
                            .is_err()
                        {
                            return;
                        }
                    }
                    Err(error) => {
                        let _ = stdout_events
                            .send(ServerEvent::Failure(format!(
                                "Codex app-server returned invalid protocol data: {error}"
                            )))
                            .await;
                        return;
                    }
                },
                Ok(None) => {
                    let _ = stdout_events.send(ServerEvent::Closed).await;
                    return;
                }
                Err(error) => {
                    let _ = stdout_events.send(ServerEvent::Failure(error)).await;
                    return;
                }
            }
        }
    });

    // Drain stderr so a noisy child cannot block on a full pipe. Never expose
    // raw stderr: CLI diagnostics can include local paths or account details.
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stderr);
        loop {
            match read_protocol_line(&mut reader, 16 * 1024).await {
                Ok(Some(_)) => {}
                Ok(None) => return,
                Err(_) => continue,
            }
        }
    });

    let runtime = RuntimeControl {
        outbound,
        stop,
        pid,
    };
    tauri::async_runtime::spawn(async move {
        let mut planned_stop = false;
        let mut exit_message = "Codex app-server exited unexpectedly".to_string();
        loop {
            tokio::select! {
                status = child.wait() => {
                    match status {
                        Ok(status) => exit_message = format!("Codex app-server exited with status {}", status.code().unwrap_or(-1)),
                        Err(_) => exit_message = "Codex app-server stopped unexpectedly".to_string(),
                    }
                    break;
                }
                command = stop_rx.recv() => {
                    if let Some(command) = command {
                        planned_stop = true;
                        exit_message = command.reason;
                        if let Some(pid) = child.id() {
                            terminate_process_tree(pid);
                        }
                        let _ = child.kill().await;
                        let _ = child.wait().await;
                        if let Some(acknowledgement) = command.acknowledgement {
                            let _ = acknowledgement.send(());
                        }
                    } else {
                        planned_stop = true;
                        if let Some(pid) = child.id() {
                            terminate_process_tree(pid);
                        }
                        let _ = child.kill().await;
                        let _ = child.wait().await;
                    }
                    break;
                }
                event = events_rx.recv() => {
                    match event {
                        Some(ServerEvent::Message(message)) => {
                            service.route_protocol_message(&thread_id, message, event_outbound.clone()).await;
                        }
                        Some(ServerEvent::Failure(message)) => {
                            exit_message = message;
                            let _ = child.kill().await;
                            let _ = child.wait().await;
                            break;
                        }
                        Some(ServerEvent::Closed) | None => {
                            exit_message = "Codex app-server closed its protocol stream".to_string();
                            let _ = child.kill().await;
                            let _ = child.wait().await;
                            break;
                        }
                    }
                }
            }
        }
        service
            .process_exited(&thread_id, planned_stop, &exit_message)
            .await;
    });

    Ok(runtime)
}

fn supports_minimum_version(output: &str) -> bool {
    let Some(token) = output.split_whitespace().find(|part| {
        part.trim_start_matches('v')
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_digit())
    }) else {
        return false;
    };
    let token = token.trim_start_matches('v');
    let (core, prerelease) = token.split_once('-').unwrap_or((token, ""));
    let core = core.split('+').next().unwrap_or(core);
    let mut parts = core.split('.').filter_map(|part| part.parse::<u64>().ok());
    let Some(major) = parts.next() else {
        return false;
    };
    let Some(minor) = parts.next() else {
        return false;
    };
    let Some(patch) = parts.next() else {
        return false;
    };
    let found = (major, minor, patch);
    found > MINIMUM_CODEX_VERSION || (found == MINIMUM_CODEX_VERSION && prerelease.is_empty())
}

fn format_version(version: (u64, u64, u64)) -> String {
    format!("{}.{}.{}", version.0, version.1, version.2)
}

#[cfg(unix)]
fn terminate_process_tree(pid: u32) {
    let mut command = crate::utils::create_command("pkill");
    command
        .args(["-TERM", "-g", &pid.to_string()])
        .env("PATH", crate::utils::get_extended_path());
    let _ = command.status();
}

#[cfg(windows)]
fn terminate_process_tree(pid: u32) {
    let mut command = crate::utils::create_command("taskkill");
    command
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .env("PATH", crate::utils::get_extended_path());
    let _ = command.status();
}

pub(super) async fn request(
    service: &AgentChatService,
    thread_id: &str,
    outbound: &mpsc::Sender<Value>,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let id = Value::String(uuid::Uuid::new_v4().to_string());
    let (tx, rx) = oneshot::channel();
    let key = id.as_str().unwrap_or_default().to_string();
    service
        .register_pending_rpc(thread_id, key.clone(), tx)
        .await?;
    if outbound
        .send(rpc_request(id, method, params))
        .await
        .is_err()
    {
        service.remove_pending_rpc(&key).await;
        return Err("Codex app-server is no longer available".to_string());
    }
    match timeout(REQUEST_TIMEOUT, rx).await {
        Ok(Ok(Ok(result))) => Ok(result),
        Ok(Ok(Err(error))) => Err(error),
        Ok(Err(_)) => {
            Err("Codex app-server disconnected before acknowledging the request".to_string())
        }
        Err(_) => {
            service.remove_pending_rpc(&key).await;
            Err("Codex app-server did not acknowledge the request in time".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::supports_minimum_version;

    #[test]
    fn requires_the_codex_app_server_history_baseline() {
        assert!(!supports_minimum_version("codex-cli 0.162.0"));
        assert!(!supports_minimum_version("codex-cli 0.162.1-alpha.1"));
        assert!(supports_minimum_version("codex-cli 0.162.1"));
        assert!(supports_minimum_version("codex-cli 0.163.0 (build 42)"));
        assert!(!supports_minimum_version("codex-cli unknown"));
    }
}
