//! Renderer-session lifecycle and cleanup primitives.
//!
//! This module deliberately does not execute project code or accept module
//! paths. A future framework adapter must first install a reviewed registry,
//! then use these primitives to constrain its ephemeral host session.

use crate::commands::components::content_hash;
use crate::errors::CommandError;
use crate::utils::resolve_workspace_path;
use bytes::Bytes;
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use uuid::Uuid;

/// Bump when the generated host contract or the code-execution boundary
/// changes. Persisted approvals are only valid for this exact contract.
pub const RENDERER_INTEGRATION_VERSION: &str = "next-host-v2";

pub const RENDERER_MAX_SESSIONS_PER_PROJECT: usize = 2;
pub const RENDERER_MAX_COMPONENTS: usize = 200;
pub const RENDERER_MAX_BODY_BYTES: usize = 128 * 1024;
pub const RENDERER_MAX_MESSAGE_RATE: usize = 30;
/// Initial renderer scheduling/concurrency target. The session store may keep
/// one payload for each mounted logical component so switching selection does
/// not evict already-live frames.
pub const RENDERER_MAX_LIVE_FRAMES: usize = 6;
pub const RENDERER_MAX_STORED_FRAMES: usize = RENDERER_MAX_COMPONENTS;
/// A stage is fetched as one authenticated JSON document. Keep this larger
/// than the per-frame envelope while still making aggregate response growth
/// explicit and bounded (200 frames cannot become an unbounded response).
pub const RENDERER_MAX_STAGE_BODY_BYTES: usize = RENDERER_MAX_BODY_BYTES * 8;
pub const RENDERER_MAX_JSON_DEPTH: usize = 8;
pub const RENDERER_MAX_JSON_ITEMS: usize = 128;
pub const RENDERER_MAX_STRING_LENGTH: usize = 4096;
const MANIFEST_RELATIVE_PATH: &str = ".shipstudio/component-renderer/session.json";
const REGISTRY_RELATIVE_PATH: &str = ".shipstudio/component-renderer/registry.json";

static RENDERER_SESSIONS: LazyLock<Mutex<RendererSessionStore>> =
    LazyLock::new(|| Mutex::new(RendererSessionStore::default()));

type RendererBody = Full<Bytes>;

struct RendererHttpServer {
    base_url: String,
    shutdown_tx: Option<oneshot::Sender<()>>,
    _task: JoinHandle<()>,
}

static RENDERER_HTTP_SERVER: LazyLock<Mutex<Option<RendererHttpServer>>> =
    LazyLock::new(|| Mutex::new(None));

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RendererCapabilities {
    pub live_frame: bool,
    pub snapshots: bool,
    pub accessibility: bool,
    pub editing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RendererSession {
    pub protocol_version: u8,
    pub session_id: String,
    pub capability_token: String,
    pub project_identity: String,
    pub allowed_origin: String,
    pub base_url: String,
    pub data_endpoint: String,
    pub generation: u64,
    pub supported_component_ids: Vec<String>,
    pub source_revisions: BTreeMap<String, String>,
    pub capabilities: RendererCapabilities,
}

#[derive(Debug, Clone)]
pub struct PrepareSessionInput {
    pub project_identity: String,
    pub allowed_origin: String,
    pub base_url: String,
    pub data_endpoint: String,
    pub supported_component_ids: Vec<String>,
    pub source_revisions: BTreeMap<String, String>,
    pub capabilities: RendererCapabilities,
}

#[derive(Debug, Default)]
pub struct RendererSessionStore {
    sessions: HashMap<String, RendererSession>,
    seen_events: HashMap<String, HashSet<String>>,
    event_times: HashMap<String, Vec<u64>>,
    frames: HashMap<String, RendererFramePayload>,
}

impl RendererSessionStore {
    pub fn prepare(&mut self, input: PrepareSessionInput) -> Result<RendererSession, CommandError> {
        if self
            .sessions
            .values()
            .filter(|session| session.project_identity == input.project_identity)
            .count()
            >= RENDERER_MAX_SESSIONS_PER_PROJECT
        {
            return Err(CommandError::expected(
                "The renderer session limit for this project has been reached.",
            ));
        }
        validate_session_input(&input)?;
        let session = RendererSession {
            protocol_version: 2,
            session_id: format!("renderer-{}", Uuid::new_v4()),
            capability_token: format!("cap-{}", Uuid::new_v4()),
            project_identity: input.project_identity,
            allowed_origin: input.allowed_origin,
            base_url: input.base_url,
            data_endpoint: input.data_endpoint,
            generation: 1,
            supported_component_ids: input.supported_component_ids,
            source_revisions: input.source_revisions,
            capabilities: input.capabilities,
        };
        self.seen_events
            .insert(session.session_id.clone(), HashSet::new());
        self.event_times
            .insert(session.session_id.clone(), Vec::new());
        self.sessions
            .insert(session.session_id.clone(), session.clone());
        Ok(session)
    }

    pub fn accept_event(
        &mut self,
        session_id: &str,
        capability_token: &str,
        generation: u64,
        component_id: &str,
        revision: &str,
        event_id: &str,
        now_ms: u64,
    ) -> Result<(), CommandError> {
        let Some(session) = self.sessions.get(session_id) else {
            return Err(CommandError::expected(
                "Renderer session is no longer active.",
            ));
        };
        if session.capability_token != capability_token
            || session.generation != generation
            || !session
                .supported_component_ids
                .iter()
                .any(|id| id == component_id)
            || session
                .source_revisions
                .get(component_id)
                .map(String::as_str)
                != Some(revision)
        {
            return Err(CommandError::expected(
                "Renderer message failed session validation.",
            ));
        }
        if event_id.is_empty() || event_id.len() > 128 {
            return Err(CommandError::expected("Renderer event id is invalid."));
        }
        {
            let seen = self.seen_events.get_mut(session_id).ok_or_else(|| {
                CommandError::expected("Renderer session event state is missing.")
            })?;
            if !seen.insert(event_id.to_string()) {
                return Err(CommandError::expected(
                    "Duplicate renderer event discarded.",
                ));
            }
        }
        let times = self
            .event_times
            .get_mut(session_id)
            .ok_or_else(|| CommandError::expected("Renderer session rate state is missing."))?;
        times.retain(|timestamp| timestamp.saturating_add(1_000) > now_ms);
        if times.len() >= RENDERER_MAX_MESSAGE_RATE {
            if let Some(seen) = self.seen_events.get_mut(session_id) {
                seen.remove(event_id);
            }
            return Err(CommandError::expected(
                "Renderer message rate limit reached.",
            ));
        }
        times.push(now_ms);
        Ok(())
    }

    pub fn cancel(&mut self, session_id: &str) -> bool {
        self.seen_events.remove(session_id);
        self.event_times.remove(session_id);
        self.frames
            .retain(|key, _| !key.starts_with(&format!("{session_id}:")));
        self.sessions.remove(session_id).is_some()
    }

    pub fn invalidate_project(&mut self, project_identity: &str) -> usize {
        let ids: Vec<String> = self
            .sessions
            .values()
            .filter(|session| session.project_identity == project_identity)
            .map(|session| session.session_id.clone())
            .collect();
        let count = ids.len();
        ids.iter().for_each(|id| {
            self.cancel(id);
        });
        count
    }

    pub fn len(&self) -> usize {
        self.sessions.len()
    }

    pub fn get(&self, session_id: &str) -> Option<RendererSession> {
        self.sessions.get(session_id).cloned()
    }

    pub fn publish_frame(
        &mut self,
        session_id: &str,
        capability_token: &str,
        project_identity: &str,
        payload: RendererFramePayload,
    ) -> Result<(), CommandError> {
        self.publish_frame_with_envelope_size(
            session_id,
            capability_token,
            project_identity,
            payload,
            None,
        )
    }

    fn publish_frame_with_envelope_size(
        &mut self,
        session_id: &str,
        capability_token: &str,
        project_identity: &str,
        payload: RendererFramePayload,
        request_size: Option<usize>,
    ) -> Result<(), CommandError> {
        let Some(session) = self.sessions.get(session_id) else {
            return Err(CommandError::expected(
                "Renderer session is no longer active.",
            ));
        };
        if session.capability_token != capability_token
            || session.project_identity != project_identity
            || payload.session_id != session_id
            || payload.project_identity != project_identity
            || payload.generation != session.generation
            || !session
                .supported_component_ids
                .iter()
                .any(|id| id == &payload.component_id)
            || session
                .source_revisions
                .get(&payload.component_id)
                .map(String::as_str)
                != Some(payload.component_revision.as_str())
        {
            return Err(CommandError::expected(
                "Renderer frame failed session validation.",
            ));
        }
        if request_size.is_some_and(|size| size > RENDERER_MAX_BODY_BYTES) {
            return Err(CommandError::Validation {
                field: "renderer_frame_request".to_string(),
                reason: "renderer frame request envelope exceeds the 128 KiB safety limit"
                    .to_string(),
            });
        }
        validate_renderer_frame_payload(&payload)?;
        let key = frame_key(session_id, &payload.frame_id);
        if !self.frames.contains_key(&key)
            && self
                .frames
                .keys()
                .filter(|existing| existing.starts_with(&format!("{session_id}:")))
                .count()
                >= RENDERER_MAX_STORED_FRAMES
        {
            return Err(CommandError::expected(
                "The renderer stored-frame limit has been reached.",
            ));
        }
        self.frames.insert(key, payload);
        Ok(())
    }

    fn frame(
        &mut self,
        session_id: &str,
        capability_token: &str,
        frame_id: &str,
        origin: Option<&str>,
    ) -> Result<RendererFramePayload, RendererHttpError> {
        let Some(session) = self.sessions.get(session_id) else {
            return Err(RendererHttpError::unauthorized());
        };
        if session.capability_token != capability_token
            || origin.is_some_and(|origin| origin != session.allowed_origin)
        {
            return Err(RendererHttpError::unauthorized());
        }
        self.frames
            .get(&frame_key(session_id, frame_id))
            .cloned()
            .ok_or_else(RendererHttpError::not_found)
    }

    /// Return the session's current validated frame set for the shared stage.
    ///
    /// Frames are inserted only after `publish_frame` has checked the session,
    /// component allowlist, source revision, and payload bounds. Recheck those
    /// invariants here as a fail-closed guard before composing the aggregate
    /// response, then order by opaque frame id for deterministic hosts.
    fn stage(
        &self,
        session_id: &str,
        capability_token: &str,
        origin: Option<&str>,
    ) -> Result<RendererStageDescriptor, RendererHttpError> {
        let Some(session) = self.sessions.get(session_id) else {
            return Err(RendererHttpError::unauthorized());
        };
        if session.capability_token != capability_token
            || origin.is_some_and(|origin| origin != session.allowed_origin)
        {
            return Err(RendererHttpError::unauthorized());
        }

        let prefix = format!("{session_id}:");
        let mut frames = Vec::new();
        for (key, payload) in self
            .frames
            .iter()
            .filter(|(key, _)| key.starts_with(&prefix))
        {
            if payload.session_id != session_id
                || payload.project_identity != session.project_identity
                || payload.generation != session.generation
                || !session
                    .supported_component_ids
                    .iter()
                    .any(|id| id == &payload.component_id)
                || session
                    .source_revisions
                    .get(&payload.component_id)
                    .map(String::as_str)
                    != Some(payload.component_revision.as_str())
                || key != &frame_key(session_id, &payload.frame_id)
                || validate_renderer_frame_payload(payload).is_err()
            {
                return Err(RendererHttpError::internal());
            }
            frames.push(payload.clone());
        }
        if frames.len() > RENDERER_MAX_COMPONENTS {
            return Err(RendererHttpError::payload_too_large());
        }
        frames.sort_by(|left, right| left.frame_id.cmp(&right.frame_id));
        Ok(RendererStageDescriptor {
            protocol_version: session.protocol_version,
            session_id: session.session_id.clone(),
            generation: session.generation,
            frames,
        })
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareRendererSessionRequest {
    pub allowed_origin: String,
    pub base_url: String,
    pub requested_component_ids: Vec<String>,
    pub capabilities: RendererCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishRendererFrameRequest {
    pub session_id: String,
    pub capability_token: String,
    pub payload: RendererFramePayload,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRendererHostRequest {
    pub session_id: String,
    pub capability_token: String,
    pub consent_version: String,
    pub files: Vec<RendererHostFile>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRendererRegistryRequest {
    pub consent_version: String,
    pub source_revision: String,
    pub component_revisions: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererHostFile {
    pub relative_path: String,
    pub contents: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RendererFramePayload {
    pub protocol_version: u8,
    pub project_identity: String,
    pub session_id: String,
    pub frame_id: String,
    pub component_id: String,
    pub component_revision: String,
    pub generation: u64,
    pub props: Value,
    pub slots: BTreeMap<String, String>,
    pub presentation: RendererFramePresentation,
}

/// Authenticated aggregate returned by `GET /renderer/{session}/stage`.
///
/// This is intentionally composed from already-validated individual frame
/// payloads; callers cannot submit a stage descriptor or any module path.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RendererStageDescriptor {
    pub protocol_version: u8,
    pub session_id: String,
    pub generation: u64,
    pub frames: Vec<RendererFramePayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RendererFramePresentation {
    pub width_mode: String,
    pub width: Option<f64>,
    pub height: String,
    pub background: String,
    pub breakpoint: Option<String>,
    pub locale: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RendererRegistryDocument {
    source_revision: String,
    component_revisions: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererCleanupResponse {
    pub removed: Vec<String>,
    pub preserved_modified: Vec<String>,
}

fn renderer_registry_path(project: &Path) -> PathBuf {
    project.join(REGISTRY_RELATIVE_PATH)
}

/// Resolve a generated renderer path without ever following a project-owned
/// symlink. The lexical allowlist is necessary but not sufficient here:
/// `project/app/shipstudio_renderer_.../page.tsx` is still outside the
/// validated project if `app` is a symlink. Walk every existing component,
/// reject symlinks and non-directory parents, then verify the deepest existing
/// parent canonically remains inside the validated project.
///
/// The caller must invoke this immediately before each filesystem mutation as
/// well as during preflight. This closes the practical race window with the
/// existing path-based filesystem API, although a hostile process with write
/// access to the project can still race between that check and the syscall.
fn renderer_workspace_root(project: &Path) -> Result<String, CommandError> {
    let canonical_project = fs::canonicalize(project).map_err(|error| {
        crate::utils::classify_fs_error("validate renderer project directory", project, &error)
    })?;
    let workspace = resolve_workspace_path(&canonical_project);
    let canonical_workspace = fs::canonicalize(&workspace).map_err(|error| {
        crate::utils::classify_fs_error("validate renderer workspace directory", &workspace, &error)
    })?;
    let relative = canonical_workspace
        .strip_prefix(&canonical_project)
        .map_err(|_| {
            CommandError::expected("The active renderer workspace is outside the project.")
        })?;
    let relative = relative.to_string_lossy().replace('\\', "/");
    Ok(if relative.is_empty() {
        ".".to_string()
    } else {
        relative
    })
}

fn validate_renderer_fs_path(project: &Path, relative: &str) -> Result<PathBuf, CommandError> {
    let workspace_root = renderer_workspace_root(project)?;
    let relative = validate_manifest_path_for_workspace(relative, &workspace_root)?;
    let canonical_project = fs::canonicalize(project).map_err(|error| {
        crate::utils::classify_fs_error("validate renderer project directory", project, &error)
    })?;
    let candidate = canonical_project.join(relative);
    let mut current = canonical_project.clone();
    let mut deepest_existing = canonical_project.clone();

    for component in relative.components() {
        let std::path::Component::Normal(name) = component else {
            return Err(CommandError::expected(
                "Renderer generated path contains an invalid component.",
            ));
        };
        current.push(name);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err(CommandError::expected(format!(
                        "Renderer generated path refuses symlink component '{}'.",
                        current.display()
                    )));
                }
                if current != candidate && !metadata.is_dir() {
                    return Err(CommandError::expected(format!(
                        "Renderer generated path has a non-directory parent '{}'.",
                        current.display()
                    )));
                }
                deepest_existing = current.clone();
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => {
                return Err(crate::utils::classify_fs_error(
                    "inspect renderer generated path",
                    &current,
                    &error,
                ));
            }
        }
    }

    let canonical_parent = fs::canonicalize(&deepest_existing).map_err(|error| {
        crate::utils::classify_fs_error(
            "canonicalize renderer generated path parent",
            &deepest_existing,
            &error,
        )
    })?;
    if !canonical_parent.starts_with(&canonical_project) {
        return Err(CommandError::expected(format!(
            "Renderer generated path '{}' resolves outside the validated project.",
            relative.display()
        )));
    }
    Ok(candidate)
}

fn validate_renderer_fs_paths<'a>(
    project: &Path,
    relatives: impl IntoIterator<Item = &'a str>,
) -> Result<(), CommandError> {
    for relative in relatives {
        validate_renderer_fs_path(project, relative)?;
    }
    Ok(())
}

fn renderer_relative_path(project: &Path, path: &Path) -> Result<String, CommandError> {
    let canonical_project = fs::canonicalize(project).map_err(|error| {
        crate::utils::classify_fs_error("validate renderer project directory", project, &error)
    })?;
    path.strip_prefix(canonical_project)
        .map(|relative| relative.to_string_lossy().into_owned())
        .map_err(|_| CommandError::expected("Renderer generated path escaped project."))
}

fn read_renderer_registry(project: &Path) -> Result<RendererRegistryDocument, CommandError> {
    let path = validate_renderer_fs_path(project, REGISTRY_RELATIVE_PATH)?;
    validate_renderer_fs_path(project, REGISTRY_RELATIVE_PATH)?;
    let bytes = fs::read(&path).map_err(|error| {
        crate::utils::classify_fs_error("read reviewed renderer registry", &path, &error)
    })?;
    if bytes.len() > RENDERER_MAX_BODY_BYTES {
        return Err(CommandError::Validation {
            field: "renderer_registry".to_string(),
            reason: "reviewed registry exceeds the bounded payload size".to_string(),
        });
    }
    let registry: RendererRegistryDocument = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Failed to parse reviewed renderer registry: {error}"))?;
    validate_renderer_registry_document(&registry)?;
    Ok(registry)
}

fn validate_renderer_registry_document(
    registry: &RendererRegistryDocument,
) -> Result<(), CommandError> {
    if registry.source_revision.is_empty()
        || registry.source_revision.len() > 256
        || registry.component_revisions.is_empty()
        || registry.component_revisions.len() > RENDERER_MAX_COMPONENTS
        || registry.component_revisions.iter().any(|(id, revision)| {
            id.is_empty() || id.len() > 256 || revision.is_empty() || revision.len() > 256
        })
    {
        return Err(CommandError::Validation {
            field: "renderer_registry".to_string(),
            reason: "reviewed registry is empty, oversized, or malformed".to_string(),
        });
    }
    Ok(())
}

fn read_renderer_consent(
    project: &Path,
) -> Result<Option<crate::types::ComponentRendererConsent>, CommandError> {
    let path = project.join(".shipstudio").join("project.json");
    if !path.exists() {
        return Ok(None);
    }
    let contents = fs::read_to_string(&path)
        .map_err(|error| crate::utils::classify_fs_error("read renderer consent", &path, &error))?;
    let metadata: crate::types::ProjectMetadata =
        serde_json::from_str(&contents).map_err(|error| {
            format!("Failed to parse project metadata for renderer consent: {error}")
        })?;
    Ok(metadata.component_renderer_consent)
}

fn has_current_renderer_consent(
    project: &Path,
    consent_version: &str,
) -> Result<bool, CommandError> {
    Ok(consent_version == RENDERER_INTEGRATION_VERSION
        && read_renderer_consent(project)?
            .is_some_and(|consent| consent.integration_version == RENDERER_INTEGRATION_VERSION))
}

pub async fn get_consent_impl(
    project_path: String,
) -> Result<Option<crate::types::ComponentRendererConsent>, CommandError> {
    let project = crate::utils::validate_project_path(&project_path)?;
    Ok(read_renderer_consent(&project)?
        .filter(|consent| consent.integration_version == RENDERER_INTEGRATION_VERSION))
}

pub async fn grant_consent_impl(
    project_path: String,
) -> Result<crate::types::ComponentRendererConsent, CommandError> {
    let project = crate::utils::validate_project_path(&project_path)?;
    let consent = crate::types::ComponentRendererConsent {
        integration_version: RENDERER_INTEGRATION_VERSION.to_string(),
        approved_at: now_ms(),
    };
    let saved_consent = consent.clone();
    crate::commands::projects::update_project_metadata(&project, |metadata| {
        metadata.component_renderer_consent = Some(saved_consent);
        Ok(())
    })?;
    Ok(consent)
}

pub async fn revoke_consent_impl(project_path: String) -> Result<(), CommandError> {
    let project = crate::utils::validate_project_path(&project_path)?;
    crate::commands::projects::update_project_metadata(&project, |metadata| {
        metadata.component_renderer_consent = None;
        Ok(())
    })
}

/// Prepare a renderer session only from an explicit reviewed registry. This
/// command never accepts a module specifier, source path, or generated route in
/// its request body.
pub async fn prepare_session_impl(
    project_path: String,
    request: PrepareRendererSessionRequest,
) -> Result<RendererSession, CommandError> {
    let project = crate::utils::validate_project_path(&project_path)?;
    recover_stale_manifest(&project)?;
    let registry = read_renderer_registry(&project)?;
    let requested = if request.requested_component_ids.is_empty() {
        registry
            .component_revisions
            .keys()
            .cloned()
            .collect::<Vec<_>>()
    } else {
        request.requested_component_ids
    };
    if requested
        .iter()
        .any(|component_id| !registry.component_revisions.contains_key(component_id))
    {
        return Err(CommandError::Validation {
            field: "requested_component_ids".to_string(),
            reason: "requested component is not present in the reviewed registry".to_string(),
        });
    }
    let source_revisions = requested
        .iter()
        .filter_map(|component_id| {
            registry
                .component_revisions
                .get(component_id)
                .map(|revision| (component_id.clone(), revision.clone()))
        })
        .collect();
    let input = PrepareSessionInput {
        project_identity: project.to_string_lossy().to_string(),
        allowed_origin: request.allowed_origin,
        base_url: request.base_url,
        data_endpoint: ensure_renderer_http_server().await?,
        supported_component_ids: requested,
        source_revisions,
        capabilities: request.capabilities,
    };
    RENDERER_SESSIONS
        .lock()
        .map_err(|_| CommandError::expected("Renderer session store is unavailable."))?
        .prepare(input)
}

/// Install only the parser-reviewed registry after the backend has validated
/// the project-scoped consent record. This is deliberately separate from host
/// source installation because the session manager reads the registry as its
/// allowlist during preparation.
pub async fn install_registry_impl(
    project_path: String,
    request: InstallRendererRegistryRequest,
) -> Result<(), CommandError> {
    let project = crate::utils::validate_project_path(&project_path)?;
    if !has_current_renderer_consent(&project, &request.consent_version)? {
        return Err(CommandError::expected(
            "Renderer setup requires current project consent before writing the registry.",
        ));
    }
    let registry = RendererRegistryDocument {
        source_revision: request.source_revision,
        component_revisions: request.component_revisions,
    };
    validate_renderer_registry_document(&registry)?;
    let path = renderer_registry_path(&project);
    validate_renderer_fs_path(&project, REGISTRY_RELATIVE_PATH)?;
    let contents = serde_json::to_vec_pretty(&registry)
        .map_err(|error| format!("Failed to serialize renderer registry: {error}"))?;
    if contents.len() > RENDERER_MAX_BODY_BYTES {
        return Err(CommandError::Validation {
            field: "renderer_registry".to_string(),
            reason: "reviewed registry exceeds the bounded payload size".to_string(),
        });
    }
    // The registry is a Ship Studio-owned allowlist, not a project route. A
    // source revision change must be able to replace a stale registry after
    // the current consent has been validated; route files still refuse every
    // collision in install_host_impl.
    if path.exists() {
        validate_renderer_fs_path(&project, REGISTRY_RELATIVE_PATH)?;
        let current = fs::read(&path).map_err(|error| {
            crate::utils::classify_fs_error("read existing renderer registry", &path, &error)
        })?;
        let existing = serde_json::from_slice::<RendererRegistryDocument>(&current)
            .ok()
            .filter(|existing| validate_renderer_registry_document(existing).is_ok());
        if existing.is_none() {
            return Err(CommandError::expected(
                "Renderer registry setup refused to overwrite an existing non-renderer file.",
            ));
        }
    }
    let parent = path
        .parent()
        .ok_or_else(|| CommandError::expected("Renderer registry has no parent directory."))?;
    validate_renderer_fs_path(&project, REGISTRY_RELATIVE_PATH)?;
    fs::create_dir_all(parent).map_err(|error| {
        crate::utils::classify_fs_error("create renderer registry directory", parent, &error)
    })?;
    let temporary = parent.join(format!("registry.json.{}.tmp", Uuid::new_v4()));
    validate_renderer_fs_path(&project, REGISTRY_RELATIVE_PATH)?;
    let temporary_relative = temporary
        .strip_prefix(&project)
        .map_err(|_| CommandError::expected("Renderer registry staging path escaped project."))?;
    validate_renderer_fs_path(&project, &temporary_relative.to_string_lossy())?;
    fs::write(&temporary, contents).map_err(|error| {
        crate::utils::classify_fs_error("write renderer registry", &temporary, &error)
    })?;
    validate_renderer_fs_path(&project, &temporary_relative.to_string_lossy())?;
    validate_renderer_fs_path(&project, REGISTRY_RELATIVE_PATH)?;
    if path.exists() {
        let current = fs::read(&path).map_err(|error| {
            crate::utils::classify_fs_error("recheck existing renderer registry", &path, &error)
        })?;
        let existing = serde_json::from_slice::<RendererRegistryDocument>(&current)
            .ok()
            .filter(|existing| validate_renderer_registry_document(existing).is_ok());
        if existing.is_none() {
            return Err(CommandError::expected(
                "Renderer registry setup refused to overwrite an existing non-renderer file.",
            ));
        }
    }
    crate::utils::atomic_replace(&temporary, &path)
        .map_err(|error| crate::utils::classify_fs_error("commit renderer registry", &path, &error))
}

pub async fn publish_frame_impl(
    project_path: String,
    request: PublishRendererFrameRequest,
) -> Result<(), CommandError> {
    let project = crate::utils::validate_project_path(&project_path)?;
    let project_identity = project.to_string_lossy().to_string();
    let request_size = serialized_renderer_request_size(&request)?;
    let mut sessions = RENDERER_SESSIONS
        .lock()
        .map_err(|_| CommandError::expected("Renderer session store is unavailable."))?;
    sessions.publish_frame_with_envelope_size(
        &request.session_id,
        &request.capability_token,
        &project_identity,
        request.payload,
        Some(request_size),
    )
}

pub async fn install_host_impl(
    project_path: String,
    request: InstallRendererHostRequest,
) -> Result<RendererCleanupManifest, CommandError> {
    let project = crate::utils::validate_project_path(&project_path)?;
    let workspace_root = renderer_workspace_root(&project)?;
    if !has_current_renderer_consent(&project, &request.consent_version)? {
        return Err(CommandError::expected(
            "Renderer setup requires current project consent before writing project files.",
        ));
    }
    if request.files.is_empty() || request.files.len() > 4 {
        return Err(CommandError::Validation {
            field: "renderer_host.files".to_string(),
            reason: "renderer setup file count is empty or exceeds the bounded limit".to_string(),
        });
    }
    if request
        .files
        .iter()
        .map(|file| file.contents.len())
        .sum::<usize>()
        > RENDERER_MAX_BODY_BYTES
    {
        return Err(CommandError::Validation {
            field: "renderer_host.files".to_string(),
            reason: "renderer setup source exceeds the bounded payload size".to_string(),
        });
    }
    let project_identity = project.to_string_lossy().to_string();
    let session = {
        let sessions = RENDERER_SESSIONS
            .lock()
            .map_err(|_| CommandError::expected("Renderer session store is unavailable."))?;
        sessions
            .get(&request.session_id)
            .filter(|session| {
                session.project_identity == project_identity
                    && session.capability_token == request.capability_token
            })
            .ok_or_else(|| CommandError::expected("Renderer session is no longer active."))?
    };
    let mut targets = HashSet::new();
    let mut files = Vec::with_capacity(request.files.len() * 2);
    let staging_id = format!("stage-{}", Uuid::new_v4());
    for (index, file) in request.files.iter().enumerate() {
        validate_renderer_host_file(file, &workspace_root)?;
        if !targets.insert(file.relative_path.clone()) {
            return Err(CommandError::Validation {
                field: "renderer_host.files".to_string(),
                reason: "renderer setup contains duplicate target paths".to_string(),
            });
        }
        let target = project.join(&file.relative_path);
        validate_renderer_fs_path(&project, &file.relative_path)?;
        if target.exists() {
            return Err(CommandError::expected(format!(
                "Renderer setup refused to overwrite existing file '{}'.",
                file.relative_path
            )));
        }
        let temporary = format!(".shipstudio/component-renderer/staging/{staging_id}/{index}.tmp");
        validate_renderer_fs_path(&project, &temporary)?;
        let generated_hash = content_hash(file.contents.as_bytes());
        files.push(GeneratedRendererFile {
            relative_path: file.relative_path.clone(),
            generated_hash: generated_hash.clone(),
            was_absent: true,
        });
        files.push(GeneratedRendererFile {
            relative_path: temporary.clone(),
            generated_hash,
            was_absent: true,
        });
    }
    let manifest = RendererCleanupManifest {
        schema_version: 1,
        session_id: session.session_id,
        generation: session.generation,
        created_at_ms: now_ms(),
        files,
    };
    // Recheck every generated target and staging path before the manifest is
    // persisted. A project-internal symlink introduced after the request
    // validation must not turn the subsequent writes into an escape.
    validate_renderer_fs_paths(
        &project,
        manifest
            .files
            .iter()
            .map(|file| file.relative_path.as_str()),
    )?;
    write_cleanup_manifest(&project, &manifest)?;

    for (index, file) in request.files.iter().enumerate() {
        let temporary = project.join(format!(
            ".shipstudio/component-renderer/staging/{staging_id}/{index}.tmp"
        ));
        validate_renderer_fs_path(
            &project,
            &temporary
                .strip_prefix(&project)
                .map_err(|_| CommandError::expected("Renderer staging path escaped project."))?
                .to_string_lossy(),
        )?;
        if let Some(parent) = temporary.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                crate::utils::classify_fs_error("create renderer staging directory", parent, &error)
            })?;
        }
        validate_renderer_fs_path(
            &project,
            &temporary
                .strip_prefix(&project)
                .map_err(|_| CommandError::expected("Renderer staging path escaped project."))?
                .to_string_lossy(),
        )?;
        if let Err(error) = fs::write(&temporary, file.contents.as_bytes()) {
            cleanup_manifest(&project, &manifest);
            return Err(crate::utils::classify_fs_error(
                "write renderer staging file",
                &temporary,
                &error,
            ));
        }
    }
    for (index, file) in request.files.iter().enumerate() {
        let temporary = project.join(format!(
            ".shipstudio/component-renderer/staging/{staging_id}/{index}.tmp"
        ));
        let target = project.join(&file.relative_path);
        validate_renderer_fs_path(&project, &file.relative_path)?;
        validate_renderer_fs_path(
            &project,
            &temporary
                .strip_prefix(&project)
                .map_err(|_| CommandError::expected("Renderer staging path escaped project."))?
                .to_string_lossy(),
        )?;
        if let Some(parent) = target.parent() {
            if let Err(error) = fs::create_dir_all(parent) {
                cleanup_manifest(&project, &manifest);
                return Err(crate::utils::classify_fs_error(
                    "create renderer host directory",
                    parent,
                    &error,
                ));
            }
        }
        validate_renderer_fs_path(&project, &file.relative_path)?;
        validate_renderer_fs_path(
            &project,
            &temporary
                .strip_prefix(&project)
                .map_err(|_| CommandError::expected("Renderer staging path escaped project."))?
                .to_string_lossy(),
        )?;
        if target.exists() {
            cleanup_manifest(&project, &manifest);
            return Err(CommandError::expected(format!(
                "Renderer setup refused to overwrite existing file '{}'.",
                file.relative_path
            )));
        }
        if let Err(error) = fs::rename(&temporary, &target) {
            cleanup_manifest(&project, &manifest);
            return Err(crate::utils::classify_fs_error(
                "commit renderer host file",
                &target,
                &error,
            ));
        }
    }
    Ok(manifest)
}

pub async fn stop_session_impl(
    project_path: String,
    session_id: String,
) -> Result<bool, CommandError> {
    let project = crate::utils::validate_project_path(&project_path)?;
    let mut sessions = RENDERER_SESSIONS
        .lock()
        .map_err(|_| CommandError::expected("Renderer session store is unavailable."))?;
    let Some(session) = sessions.get(&session_id) else {
        return Ok(false);
    };
    if session.project_identity != project.to_string_lossy() {
        return Err(CommandError::expected(
            "Renderer session belongs to another project.",
        ));
    }
    let stopped = sessions.cancel(&session_id);
    let idle = sessions.len() == 0;
    drop(sessions);
    if idle {
        shutdown_renderer_http_server();
    }
    Ok(stopped)
}

pub async fn cleanup_session_impl(
    project_path: String,
    session_id: String,
) -> Result<RendererCleanupResponse, CommandError> {
    let project = crate::utils::validate_project_path(&project_path)?;
    recover_manifest_for_project(&project, Some(&session_id))
}

pub async fn recover_session_impl(
    project_path: String,
) -> Result<RendererCleanupResponse, CommandError> {
    let project = crate::utils::validate_project_path(&project_path)?;
    recover_manifest_for_project(&project, None)
}

fn recover_manifest_for_project(
    project: &Path,
    expected_session_id: Option<&str>,
) -> Result<RendererCleanupResponse, CommandError> {
    let manifest_file = validate_renderer_fs_path(&project, MANIFEST_RELATIVE_PATH)?;
    if !manifest_file.exists() {
        return Ok(RendererCleanupResponse {
            removed: Vec::new(),
            preserved_modified: Vec::new(),
        });
    }
    validate_renderer_fs_path(&project, MANIFEST_RELATIVE_PATH)?;
    let bytes = fs::read(&manifest_file).map_err(|error| {
        crate::utils::classify_fs_error("read renderer cleanup manifest", &manifest_file, &error)
    })?;
    if bytes.len() > RENDERER_MAX_BODY_BYTES {
        return Err(CommandError::Validation {
            field: "renderer_manifest".to_string(),
            reason: "cleanup manifest exceeds the bounded payload size".to_string(),
        });
    }
    let manifest: RendererCleanupManifest = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Failed to parse renderer cleanup manifest: {error}"))?;
    let workspace_root = renderer_workspace_root(project)?;
    validate_cleanup_manifest(&manifest, &workspace_root)?;
    if expected_session_id.is_some_and(|session_id| manifest.session_id != session_id) {
        return Err(CommandError::expected(
            "Renderer cleanup manifest belongs to another session.",
        ));
    }
    let result = cleanup_manifest(&project, &manifest);
    if result.preserved_modified.is_empty() {
        validate_renderer_fs_path(&project, MANIFEST_RELATIVE_PATH)?;
        let _ = fs::remove_file(&manifest_file);
    }
    Ok(RendererCleanupResponse {
        removed: result.removed,
        preserved_modified: result.preserved_modified,
    })
}

fn recover_stale_manifest(project: &Path) -> Result<(), CommandError> {
    let manifest_file = validate_renderer_fs_path(project, MANIFEST_RELATIVE_PATH)?;
    if !manifest_file.exists() {
        return Ok(());
    }
    validate_renderer_fs_path(project, MANIFEST_RELATIVE_PATH)?;
    let bytes = fs::read(&manifest_file).map_err(|error| {
        crate::utils::classify_fs_error("read stale renderer manifest", &manifest_file, &error)
    })?;
    if bytes.len() > RENDERER_MAX_BODY_BYTES {
        return Err(CommandError::Validation {
            field: "renderer_manifest".to_string(),
            reason: "stale renderer manifest exceeds the bounded payload size".to_string(),
        });
    }
    let manifest: RendererCleanupManifest = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Failed to parse stale renderer manifest: {error}"))?;
    let workspace_root = renderer_workspace_root(project)?;
    validate_cleanup_manifest(&manifest, &workspace_root)?;
    let active = RENDERER_SESSIONS
        .lock()
        .map_err(|_| CommandError::expected("Renderer session store is unavailable."))?
        .get(&manifest.session_id)
        .is_some();
    if active {
        return Ok(());
    }
    let result = cleanup_manifest(project, &manifest);
    if result.preserved_modified.is_empty() {
        validate_renderer_fs_path(project, MANIFEST_RELATIVE_PATH)?;
        let _ = fs::remove_file(&manifest_file);
        return Ok(());
    }
    Err(CommandError::expected(
        "Renderer recovery preserved modified generated files. Review the renderer manifest before starting another session.",
    ))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GeneratedRendererFile {
    pub relative_path: String,
    pub generated_hash: String,
    pub was_absent: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RendererCleanupManifest {
    pub schema_version: u8,
    pub session_id: String,
    pub generation: u64,
    pub created_at_ms: u64,
    pub files: Vec<GeneratedRendererFile>,
}

pub fn manifest_path(project: &Path) -> PathBuf {
    project.join(MANIFEST_RELATIVE_PATH)
}

pub fn write_cleanup_manifest(
    project: &Path,
    manifest: &RendererCleanupManifest,
) -> Result<(), CommandError> {
    let workspace_root = renderer_workspace_root(project)?;
    validate_cleanup_manifest(manifest, &workspace_root)?;
    let path = validate_renderer_fs_path(project, MANIFEST_RELATIVE_PATH)?;
    let parent = path
        .parent()
        .ok_or_else(|| CommandError::expected("Renderer manifest has no parent directory."))?;
    fs::create_dir_all(parent).map_err(|error| {
        crate::utils::classify_fs_error("create renderer manifest directory", parent, &error)
    })?;
    let temporary = parent.join(format!("session.json.{}.tmp", Uuid::new_v4()));
    validate_renderer_fs_path(project, MANIFEST_RELATIVE_PATH)?;
    let temporary_relative = renderer_relative_path(project, &temporary)?;
    validate_renderer_fs_path(project, &temporary_relative)?;
    let contents = serde_json::to_vec_pretty(manifest)
        .map_err(|error| format!("Failed to serialize renderer manifest: {error}"))?;
    validate_renderer_fs_path(project, &temporary_relative)?;
    fs::write(&temporary, contents).map_err(|error| {
        crate::utils::classify_fs_error("write renderer manifest", &temporary, &error)
    })?;
    validate_renderer_fs_path(project, &temporary_relative)?;
    validate_renderer_fs_path(project, MANIFEST_RELATIVE_PATH)?;
    crate::utils::atomic_replace(&temporary, &path)
        .map_err(|error| crate::utils::classify_fs_error("commit renderer manifest", &path, &error))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CleanupResult {
    pub removed: Vec<String>,
    pub preserved_modified: Vec<String>,
}

pub fn cleanup_manifest(project: &Path, manifest: &RendererCleanupManifest) -> CleanupResult {
    let mut result = CleanupResult {
        removed: Vec::new(),
        preserved_modified: Vec::new(),
    };
    for file in &manifest.files {
        let Ok(path) = validate_renderer_fs_path(project, &file.relative_path) else {
            continue;
        };
        let Ok(bytes) = fs::read(&path) else {
            continue;
        };
        // Setup refuses collisions. Keep this guard here too so a hand-edited
        // manifest can never delete a pre-existing project file that the
        // renderer did not create.
        if !file.was_absent {
            result.preserved_modified.push(file.relative_path.clone());
            continue;
        }
        if content_hash(&bytes) != file.generated_hash {
            result.preserved_modified.push(file.relative_path.clone());
            continue;
        }
        if validate_renderer_fs_path(project, &file.relative_path).is_ok()
            && fs::remove_file(&path).is_ok()
        {
            result.removed.push(file.relative_path.clone());
        }
    }
    result
}

fn validate_session_input(input: &PrepareSessionInput) -> Result<(), CommandError> {
    if input.project_identity.is_empty() || input.project_identity.len() > 512 {
        return Err(CommandError::Validation {
            field: "project_identity".to_string(),
            reason: "must be a bounded non-empty identity".to_string(),
        });
    }
    let allowed_origin = url::Url::parse(&input.allowed_origin).ok();
    let base_url = url::Url::parse(&input.base_url).ok();
    let data_endpoint = url::Url::parse(&input.data_endpoint).ok();
    let exact_origin =
        allowed_origin
            .as_ref()
            .zip(base_url.as_ref())
            .is_some_and(|(allowed, base)| {
                allowed.origin() == base.origin()
                    && allowed.path() == "/"
                    && allowed.query().is_none()
                    && allowed.fragment().is_none()
                    && base.query().is_none()
                    && base.fragment().is_none()
            });
    let valid_data_endpoint = data_endpoint.as_ref().is_some_and(is_loopback_origin_url)
        && data_endpoint
            .as_ref()
            .is_some_and(|url| url.query().is_none() && url.fragment().is_none());
    if !exact_origin
        || !allowed_origin.as_ref().is_some_and(is_loopback_origin_url)
        || !valid_data_endpoint
    {
        return Err(CommandError::Validation {
            field: "allowed_origin".to_string(),
            reason: "renderer sessions must use an exact loopback origin".to_string(),
        });
    }
    if input.supported_component_ids.is_empty()
        || input.supported_component_ids.len() > RENDERER_MAX_COMPONENTS
        || input
            .supported_component_ids
            .iter()
            .collect::<HashSet<_>>()
            .len()
            != input.supported_component_ids.len()
        || input
            .supported_component_ids
            .iter()
            .any(|id| id.is_empty() || id.len() > 256)
    {
        return Err(CommandError::Validation {
            field: "supported_component_ids".to_string(),
            reason: "component allowlist is empty, oversized, or malformed".to_string(),
        });
    }
    if input.source_revisions.len() != input.supported_component_ids.len()
        || input.source_revisions.keys().any(|id| {
            !input
                .supported_component_ids
                .iter()
                .any(|allowed| allowed == id)
        })
        || input
            .source_revisions
            .values()
            .any(|revision| revision.is_empty() || revision.len() > 256)
    {
        return Err(CommandError::Validation {
            field: "source_revisions".to_string(),
            reason: "revision map contains a component outside the allowlist".to_string(),
        });
    }
    Ok(())
}

fn is_loopback_origin_url(url: &url::Url) -> bool {
    url.scheme() == "http"
        && url.port().is_some()
        && matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
        && url.username().is_empty()
        && url.password().is_none()
}

fn validate_cleanup_manifest(
    manifest: &RendererCleanupManifest,
    workspace_root: &str,
) -> Result<(), CommandError> {
    if manifest.schema_version != 1
        || manifest.session_id.is_empty()
        || manifest.session_id.len() > 128
        || manifest.generation == 0
        || manifest.files.len() > 64
    {
        return Err(CommandError::Validation {
            field: "renderer_manifest".to_string(),
            reason: "invalid or unsupported session manifest".to_string(),
        });
    }
    for file in &manifest.files {
        validate_manifest_path_for_workspace(&file.relative_path, workspace_root)?;
        if file.generated_hash.len() != 64 || hex::decode(&file.generated_hash).is_err() {
            return Err(CommandError::Validation {
                field: "renderer_manifest.generated_hash".to_string(),
                reason: "generated file hash must be a SHA-256 hex digest".to_string(),
            });
        }
    }
    Ok(())
}

fn validate_renderer_host_file(
    file: &RendererHostFile,
    workspace_root: &str,
) -> Result<(), CommandError> {
    validate_manifest_path_for_workspace(&file.relative_path, workspace_root)?;
    if file.contents.is_empty() || file.contents.len() > RENDERER_MAX_BODY_BYTES {
        return Err(CommandError::Validation {
            field: "renderer_host.files".to_string(),
            reason: "renderer host source is empty or oversized".to_string(),
        });
    }
    if file.kind == "registry" {
        if file.relative_path != REGISTRY_RELATIVE_PATH {
            return Err(CommandError::Validation {
                field: "renderer_host.files".to_string(),
                reason: "the reviewed registry must use its fixed project path".to_string(),
            });
        }
        let registry: RendererRegistryDocument = serde_json::from_str(&file.contents)
            .map_err(|error| format!("Failed to parse reviewed renderer registry: {error}"))?;
        return validate_renderer_registry_document(&registry);
    }
    if !matches!(file.kind.as_str(), "route" | "client-shell" | "loading")
        || !file
            .contents
            .starts_with("/* Ship Studio component renderer host")
        || file.contents.contains("dangerouslySetInnerHTML")
        || file.contents.contains("new Function")
        || file.contents.contains("eval(")
        || file.contents.contains("<script")
    {
        return Err(CommandError::Validation {
            field: "renderer_host.files".to_string(),
            reason: "renderer host source is unreviewed, unsafe, or malformed".to_string(),
        });
    }
    Ok(())
}

fn validate_manifest_path_for_workspace<'a>(
    relative: &'a str,
    workspace_root: &str,
) -> Result<&'a Path, CommandError> {
    let path = Path::new(relative);
    if relative.is_empty()
        || relative.contains('\\')
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir | std::path::Component::RootDir
            )
        })
        || (!relative.starts_with(".shipstudio/component-renderer/")
            && !workspace_renderer_dir(relative, workspace_root)
            && !is_renderer_route_path_for_workspace(relative, workspace_root))
    {
        return Err(CommandError::Validation {
            field: "renderer_manifest.path".to_string(),
            reason: "generated file must stay inside a renderer-owned directory or reviewed Next renderer route".to_string(),
        });
    }
    Ok(path)
}

fn workspace_renderer_dir(relative: &str, workspace_root: &str) -> bool {
    let workspace_root = workspace_root.trim_matches('/');
    !workspace_root.is_empty()
        && workspace_root != "."
        && relative.starts_with(&format!("{workspace_root}/.shipstudio/component-renderer/"))
}

fn is_renderer_route_path_for_workspace(relative: &str, workspace_root: &str) -> bool {
    let workspace_root = workspace_root.trim_matches('/');
    if workspace_root.is_empty() || workspace_root == "." {
        return is_renderer_route_path(relative);
    }
    relative
        .strip_prefix(&format!("{workspace_root}/"))
        .is_some_and(is_renderer_route_path)
}

fn is_renderer_route_path(relative: &str) -> bool {
    fn is_renderer_segment(segment: &str) -> bool {
        const PREFIX: &str = "shipstudio_renderer_";
        let Some(suffix) = segment.strip_prefix(PREFIX) else {
            return false;
        };
        !suffix.is_empty()
            && suffix.len() <= 64
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    }

    fn is_pages_route_file(file: &str) -> bool {
        file.strip_suffix(".tsx").is_some_and(is_renderer_segment)
    }

    match relative.split('/').collect::<Vec<_>>().as_slice() {
        ["app", segment, file] | ["src", "app", segment, file] => {
            is_renderer_segment(segment)
                && matches!(
                    *file,
                    "page.tsx" | "loading.tsx" | "__shipstudio_renderer_shell.tsx"
                )
        }
        ["pages", file] | ["src", "pages", file] => is_pages_route_file(file),
        _ => false,
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn frame_key(session_id: &str, frame_id: &str) -> String {
    format!("{session_id}:{frame_id}")
}

fn validate_renderer_frame_payload(payload: &RendererFramePayload) -> Result<(), CommandError> {
    if !serialized_renderer_message_within_bounds(payload) {
        return Err(CommandError::Validation {
            field: "renderer_frame".to_string(),
            reason: "renderer frame serialized payload exceeds the 128 KiB safety limit"
                .to_string(),
        });
    }
    if payload.protocol_version != 2
        || !bounded_renderer_string(&payload.project_identity)
        || !bounded_renderer_string(&payload.session_id)
        || !bounded_renderer_string(&payload.frame_id)
        || !bounded_renderer_string(&payload.component_id)
        || !bounded_renderer_string(&payload.component_revision)
        || !json_within_bounds(&payload.props, 0)
        || payload.slots.len() > RENDERER_MAX_JSON_ITEMS
        || payload
            .slots
            .iter()
            .any(|(key, value)| !bounded_renderer_string(key) || !bounded_renderer_string(value))
        || !bounded_renderer_string(&payload.presentation.width_mode)
        || !bounded_renderer_string(&payload.presentation.height)
        || !bounded_renderer_string(&payload.presentation.background)
        || payload
            .presentation
            .breakpoint
            .as_ref()
            .is_some_and(|value| !bounded_renderer_string(value))
        || payload
            .presentation
            .locale
            .as_ref()
            .is_some_and(|value| !bounded_renderer_string(value))
        || payload
            .presentation
            .width
            .is_some_and(|width| !width.is_finite() || width <= 0.0 || width > 100_000.0)
    {
        return Err(CommandError::Validation {
            field: "renderer_frame".to_string(),
            reason: "renderer frame payload is empty, oversized, or malformed".to_string(),
        });
    }
    Ok(())
}

fn serialized_renderer_message_within_bounds<T: Serialize>(value: &T) -> bool {
    serde_json::to_vec(value)
        .map(|serialized| serialized.len() <= RENDERER_MAX_BODY_BYTES)
        .unwrap_or(false)
}

fn serialized_renderer_request_size(
    request: &PublishRendererFrameRequest,
) -> Result<usize, CommandError> {
    serde_json::to_vec(request)
        .map(|serialized| serialized.len())
        .map_err(|_| CommandError::expected("Renderer frame request could not be serialized."))
}

fn bounded_renderer_string(value: &str) -> bool {
    !value.is_empty() && value.len() <= RENDERER_MAX_STRING_LENGTH
}

fn json_within_bounds(value: &Value, depth: usize) -> bool {
    if depth > RENDERER_MAX_JSON_DEPTH {
        return false;
    }
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => true,
        Value::String(value) => value.len() <= RENDERER_MAX_STRING_LENGTH,
        Value::Array(values) => {
            values.len() <= RENDERER_MAX_JSON_ITEMS
                && values
                    .iter()
                    .all(|value| json_within_bounds(value, depth + 1))
        }
        Value::Object(values) => {
            values.len() <= RENDERER_MAX_JSON_ITEMS
                && values.keys().all(|key| bounded_renderer_string(key))
                && values
                    .values()
                    .all(|value| json_within_bounds(value, depth + 1))
        }
    }
}

async fn ensure_renderer_http_server() -> Result<String, CommandError> {
    if let Ok(guard) = RENDERER_HTTP_SERVER.lock() {
        if let Some(server) = guard.as_ref() {
            return Ok(server.base_url.clone());
        }
    }

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| format!("Failed to bind renderer loopback endpoint: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("Failed to get renderer endpoint port: {error}"))?
        .port();
    let base_url = format!("http://127.0.0.1:{port}/renderer");
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        loop {
            tokio::select! {
                result = listener.accept() => {
                    match result {
                        Ok((stream, _)) => {
                            tokio::spawn(async move {
                                let io = TokioIo::new(stream);
                                let service = service_fn(renderer_http_request);
                                if let Err(error) = http1::Builder::new().serve_connection(io, service).await {
                                    tracing::debug!("[Renderer] loopback connection closed: {}", error);
                                }
                            });
                        }
                        Err(error) => tracing::warn!("[Renderer] loopback accept failed: {}", error),
                    }
                }
                _ = &mut shutdown_rx => break,
            }
        }
    });
    let mut guard = RENDERER_HTTP_SERVER
        .lock()
        .map_err(|_| CommandError::expected("Renderer HTTP server state is unavailable."))?;
    if let Some(server) = guard.as_ref() {
        let existing = server.base_url.clone();
        let _ = shutdown_tx.send(());
        task.abort();
        return Ok(existing);
    }
    *guard = Some(RendererHttpServer {
        base_url: base_url.clone(),
        shutdown_tx: Some(shutdown_tx),
        _task: task,
    });
    Ok(base_url)
}

fn shutdown_renderer_http_server() {
    let Ok(mut guard) = RENDERER_HTTP_SERVER.lock() else {
        return;
    };
    if let Some(mut server) = guard.take() {
        if let Some(shutdown) = server.shutdown_tx.take() {
            let _ = shutdown.send(());
        }
    }
}

async fn renderer_http_request(
    request: Request<Incoming>,
) -> Result<Response<RendererBody>, hyper::Error> {
    if request.method() != Method::GET {
        return Ok(renderer_response(
            StatusCode::METHOD_NOT_ALLOWED,
            "method-not-allowed",
        ));
    }
    if request
        .headers()
        .get("content-length")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > 0)
    {
        return Ok(renderer_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            "body-not-allowed",
        ));
    }
    let parts: Vec<&str> = request
        .uri()
        .path()
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    let is_frame_route = parts.len() == 4 && parts[0] == "renderer" && parts[2] == "frame";
    let is_stage_route = parts.len() == 3 && parts[0] == "renderer" && parts[2] == "stage";
    if !is_frame_route && !is_stage_route {
        return Ok(renderer_response(StatusCode::NOT_FOUND, "not-found"));
    }
    let Some(header) = request.headers().get("authorization") else {
        return Ok(renderer_response(StatusCode::UNAUTHORIZED, "unauthorized"));
    };
    let Ok(header) = header.to_str() else {
        return Ok(renderer_response(StatusCode::UNAUTHORIZED, "unauthorized"));
    };
    let Some(token) = header.strip_prefix("Bearer ") else {
        return Ok(renderer_response(StatusCode::UNAUTHORIZED, "unauthorized"));
    };
    let origin = request
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok());
    if !safe_renderer_id(parts[1])
        || (is_frame_route && !safe_renderer_id(parts[3]))
        || token.len() > 256
    {
        return Ok(renderer_response(StatusCode::UNAUTHORIZED, "unauthorized"));
    }
    let result = match RENDERER_SESSIONS.lock() {
        Ok(mut sessions) => {
            if is_stage_route {
                sessions
                    .stage(parts[1], token, origin)
                    .map_err(|error| error.status)
                    .and_then(|stage| {
                        serialize_renderer_http_body(&stage, RENDERER_MAX_STAGE_BODY_BYTES)
                    })
            } else {
                sessions
                    .frame(parts[1], token, parts[3], origin)
                    .map_err(|error| error.status)
                    .and_then(|payload| {
                        serialize_renderer_http_body(&payload, RENDERER_MAX_BODY_BYTES)
                    })
            }
        }
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    };
    match result {
        Ok(body) => Ok(Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/json")
            .body(Full::new(Bytes::from(body)))
            .unwrap_or_else(|_| {
                renderer_response(StatusCode::INTERNAL_SERVER_ERROR, "response-error")
            })),
        Err(status) => Ok(renderer_response(
            status,
            if status == StatusCode::NOT_FOUND {
                "not-found"
            } else if status == StatusCode::INTERNAL_SERVER_ERROR {
                "server-error"
            } else if status == StatusCode::PAYLOAD_TOO_LARGE {
                "response-too-large"
            } else {
                "unauthorized"
            },
        )),
    }
}

fn renderer_response(status: StatusCode, code: &str) -> Response<RendererBody> {
    Response::builder()
        .status(status)
        .header("content-type", "text/plain; charset=utf-8")
        .body(Full::new(Bytes::from(code.to_string())))
        .unwrap_or_else(|_| Response::new(Full::new(Bytes::from_static(b"renderer-error"))))
}

fn serialize_renderer_http_body<T: Serialize>(
    value: &T,
    max_bytes: usize,
) -> Result<Vec<u8>, StatusCode> {
    let body = serde_json::to_vec(value).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if body.len() > max_bytes {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    Ok(body)
}

fn safe_renderer_id(value: &str) -> bool {
    bounded_renderer_string(value)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

#[derive(Debug, Clone, Copy)]
struct RendererHttpError {
    status: StatusCode,
}

impl RendererHttpError {
    fn unauthorized() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
        }
    }

    fn not_found() -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
        }
    }

    fn internal() -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    fn payload_too_large() -> Self {
        Self {
            status: StatusCode::PAYLOAD_TOO_LARGE,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> PrepareSessionInput {
        PrepareSessionInput {
            project_identity: "project-1".to_string(),
            allowed_origin: "http://127.0.0.1:4312".to_string(),
            base_url: "http://127.0.0.1:4312/component-renderer".to_string(),
            data_endpoint: "http://127.0.0.1:4313/renderer".to_string(),
            supported_component_ids: vec!["react:Card".to_string()],
            source_revisions: BTreeMap::from([("react:Card".to_string(), "rev-1".to_string())]),
            capabilities: RendererCapabilities {
                live_frame: true,
                snapshots: true,
                accessibility: true,
                editing: false,
            },
        }
    }

    fn frame_for(session: &RendererSession, frame_id: &str) -> RendererFramePayload {
        RendererFramePayload {
            protocol_version: 2,
            project_identity: session.project_identity.clone(),
            session_id: session.session_id.clone(),
            frame_id: frame_id.to_string(),
            component_id: "react:Card".to_string(),
            component_revision: "rev-1".to_string(),
            generation: session.generation,
            props: serde_json::json!({"label": frame_id}),
            slots: BTreeMap::new(),
            presentation: RendererFramePresentation {
                width_mode: "fixed".to_string(),
                width: Some(320.0),
                height: "auto".to_string(),
                background: "surface".to_string(),
                breakpoint: None,
                locale: None,
            },
        }
    }

    #[test]
    fn stage_descriptor_is_authenticated_sorted_and_bounded() {
        let mut store = RendererSessionStore::default();
        let session = store.prepare(input()).unwrap();
        for frame_id in ["z-frame", "a-frame"] {
            store
                .publish_frame(
                    &session.session_id,
                    &session.capability_token,
                    &session.project_identity,
                    frame_for(&session, frame_id),
                )
                .unwrap();
        }

        let stage = store
            .stage(
                &session.session_id,
                &session.capability_token,
                Some(session.allowed_origin.as_str()),
            )
            .unwrap();
        assert_eq!(stage.protocol_version, 2);
        assert_eq!(stage.session_id, session.session_id);
        assert_eq!(
            stage
                .frames
                .iter()
                .map(|frame| frame.frame_id.as_str())
                .collect::<Vec<_>>(),
            vec!["a-frame", "z-frame"]
        );
        assert!(serde_json::to_vec(&stage).unwrap().len() <= RENDERER_MAX_STAGE_BODY_BYTES);
        assert_eq!(stage.frames.len(), 2);

        assert_eq!(
            store
                .stage(
                    &session.session_id,
                    "wrong-token",
                    Some(session.allowed_origin.as_str()),
                )
                .unwrap_err()
                .status,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            store
                .stage(
                    &session.session_id,
                    &session.capability_token,
                    Some("http://127.0.0.1:4313"),
                )
                .unwrap_err()
                .status,
            StatusCode::UNAUTHORIZED
        );
    }

    #[test]
    fn stage_http_serialization_rejects_oversized_aggregate() {
        let mut store = RendererSessionStore::default();
        let session = store.prepare(input()).unwrap();
        let large = "x".repeat(RENDERER_MAX_BODY_BYTES / 2);
        let mut frames = Vec::new();
        for index in 0..RENDERER_MAX_COMPONENTS {
            let mut frame = frame_for(&session, &format!("frame-{index:03}"));
            frame.props = Value::String(large.clone());
            // The stage endpoint composes only publish-validated frames, so
            // use enough valid-size frames to exercise the aggregate bound.
            if validate_renderer_frame_payload(&frame).is_err() {
                break;
            }
            let mut candidate = frames.clone();
            candidate.push(frame);
            if serde_json::to_vec(&RendererStageDescriptor {
                protocol_version: session.protocol_version,
                session_id: session.session_id.clone(),
                generation: session.generation,
                frames: candidate.clone(),
            })
            .unwrap()
            .len()
                > RENDERER_MAX_STAGE_BODY_BYTES
            {
                break;
            }
            frames = candidate;
        }
        let descriptor = RendererStageDescriptor {
            protocol_version: session.protocol_version,
            session_id: session.session_id,
            generation: session.generation,
            frames,
        };
        assert!(serialize_renderer_http_body(&descriptor, RENDERER_MAX_STAGE_BODY_BYTES).is_ok());
        let oversized = RendererStageDescriptor {
            frames: (0..RENDERER_MAX_COMPONENTS)
                .map(|index| {
                    let mut frame = frame_for(
                        &RendererSession {
                            protocol_version: 2,
                            session_id: "renderer-test".to_string(),
                            capability_token: "cap-test".to_string(),
                            project_identity: "project-1".to_string(),
                            allowed_origin: "http://127.0.0.1:4312".to_string(),
                            base_url: "http://127.0.0.1:4312/component-renderer".to_string(),
                            data_endpoint: "http://127.0.0.1:4313/renderer".to_string(),
                            generation: 1,
                            supported_component_ids: vec!["react:Card".to_string()],
                            source_revisions: BTreeMap::from([(
                                "react:Card".to_string(),
                                "rev-1".to_string(),
                            )]),
                            capabilities: RendererCapabilities {
                                live_frame: true,
                                snapshots: true,
                                accessibility: true,
                                editing: false,
                            },
                        },
                        &format!("oversized-{index:03}"),
                    );
                    frame.props = Value::String("x".repeat(RENDERER_MAX_BODY_BYTES / 2));
                    frame
                })
                .collect(),
            protocol_version: 2,
            session_id: "renderer-test".to_string(),
            generation: 1,
        };
        assert_eq!(
            serialize_renderer_http_body(&oversized, RENDERER_MAX_STAGE_BODY_BYTES),
            Err(StatusCode::PAYLOAD_TOO_LARGE)
        );
    }

    #[test]
    fn sessions_are_allowlisted_and_replay_safe() {
        let mut store = RendererSessionStore::default();
        let session = store.prepare(input()).unwrap();
        assert_eq!(store.len(), 1);
        assert!(store
            .accept_event(
                &session.session_id,
                &session.capability_token,
                session.generation,
                "react:Card",
                "rev-1",
                "event-1",
                200,
            )
            .is_ok());
        assert!(store
            .accept_event(
                &session.session_id,
                &session.capability_token,
                session.generation,
                "react:Card",
                "rev-1",
                "event-1",
                200,
            )
            .is_err());
        assert!(store
            .accept_event(
                &session.session_id,
                &session.capability_token,
                session.generation,
                "react:Other",
                "rev-1",
                "event-2",
                200,
            )
            .is_err());
    }

    #[test]
    fn sessions_enforce_loopback_and_project_caps() {
        let mut store = RendererSessionStore::default();
        let _first = store.prepare(input()).unwrap();
        let _second = store.prepare(input()).unwrap();
        let _third = store.prepare(input()).unwrap_err();
        assert_eq!(store.invalidate_project("project-1"), 2);
        assert_eq!(store.len(), 0);
        let mut invalid = input();
        invalid.allowed_origin = "https://example.test".to_string();
        assert!(store.prepare(invalid).is_err());
    }

    #[test]
    fn cleanup_preserves_files_that_changed_after_generation() {
        let temp = tempfile::tempdir().unwrap();
        let relative = ".shipstudio/component-renderer/entry.js";
        let path = temp.path().join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"generated").unwrap();
        let manifest = RendererCleanupManifest {
            schema_version: 1,
            session_id: "session-1".to_string(),
            generation: 1,
            created_at_ms: 1,
            files: vec![GeneratedRendererFile {
                relative_path: relative.to_string(),
                generated_hash: content_hash(b"generated"),
                was_absent: true,
            }],
        };
        write_cleanup_manifest(temp.path(), &manifest).unwrap();
        assert!(manifest_path(temp.path()).exists());
        fs::write(&path, b"user changed").unwrap();
        let result = cleanup_manifest(temp.path(), &manifest);
        assert_eq!(result.removed, Vec::<String>::new());
        assert_eq!(result.preserved_modified, vec![relative.to_string()]);
        assert_eq!(fs::read(&path).unwrap(), b"user changed");
    }

    #[test]
    fn cleanup_manifest_rejects_unsupported_schema_and_invalid_hashes() {
        let temp = tempfile::tempdir().unwrap();
        let base = RendererCleanupManifest {
            schema_version: 1,
            session_id: "session-1".to_string(),
            generation: 1,
            created_at_ms: 1,
            files: vec![GeneratedRendererFile {
                relative_path: ".shipstudio/component-renderer/entry.js".to_string(),
                generated_hash: content_hash(b"generated"),
                was_absent: true,
            }],
        };
        write_cleanup_manifest(temp.path(), &base).unwrap();

        let mut unsupported = base.clone();
        unsupported.schema_version = 2;
        assert!(write_cleanup_manifest(temp.path(), &unsupported).is_err());

        let mut invalid_hash = base;
        invalid_hash.files[0].generated_hash = "not-a-hash".to_string();
        assert!(write_cleanup_manifest(temp.path(), &invalid_hash).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn renderer_rejects_component_renderer_symlink_escape() {
        use std::os::unix::fs::symlink;

        let project = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir_all(project.path().join(".shipstudio")).unwrap();
        symlink(
            outside.path(),
            project.path().join(".shipstudio/component-renderer"),
        )
        .unwrap();

        let manifest = RendererCleanupManifest {
            schema_version: 1,
            session_id: "session-symlink".to_string(),
            generation: 1,
            created_at_ms: 1,
            files: vec![GeneratedRendererFile {
                relative_path: ".shipstudio/component-renderer/entry.js".to_string(),
                generated_hash: content_hash(b"generated"),
                was_absent: true,
            }],
        };

        assert!(write_cleanup_manifest(project.path(), &manifest).is_err());
        assert!(!outside.path().join("session.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn renderer_rejects_allowed_route_parent_symlink_escape() {
        use std::os::unix::fs::symlink;

        let project = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), project.path().join("app")).unwrap();

        let route = "app/shipstudio_renderer_next-host-v1/page.tsx";
        assert!(validate_renderer_fs_path(project.path(), route).is_err());
        assert!(!outside
            .path()
            .join("shipstudio_renderer_next-host-v1")
            .exists());
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_refuses_symlink_target_escape() {
        use std::os::unix::fs::symlink;

        let project = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let renderer_dir = project.path().join(".shipstudio/component-renderer");
        fs::create_dir_all(&renderer_dir).unwrap();
        let outside_file = outside.path().join("user-file.js");
        fs::write(&outside_file, b"generated").unwrap();
        symlink(&outside_file, renderer_dir.join("entry.js")).unwrap();

        let relative = ".shipstudio/component-renderer/entry.js";
        let manifest = RendererCleanupManifest {
            schema_version: 1,
            session_id: "session-cleanup-symlink".to_string(),
            generation: 1,
            created_at_ms: 1,
            files: vec![GeneratedRendererFile {
                relative_path: relative.to_string(),
                generated_hash: content_hash(b"generated"),
                was_absent: true,
            }],
        };

        let result = cleanup_manifest(project.path(), &manifest);
        assert!(result.removed.is_empty());
        assert!(outside_file.exists());
    }

    #[test]
    fn renderer_allows_normal_generated_paths() {
        let project = tempfile::tempdir().unwrap();
        fs::create_dir_all(project.path().join(".shipstudio/component-renderer")).unwrap();
        let relative = ".shipstudio/component-renderer/entry.js";
        let path = validate_renderer_fs_path(project.path(), relative).unwrap();
        assert_eq!(path, project.path().canonicalize().unwrap().join(relative));

        let manifest = RendererCleanupManifest {
            schema_version: 1,
            session_id: "session-normal".to_string(),
            generation: 1,
            created_at_ms: 1,
            files: vec![GeneratedRendererFile {
                relative_path: relative.to_string(),
                generated_hash: content_hash(b"generated"),
                was_absent: true,
            }],
        };
        fs::write(&path, b"generated").unwrap();
        write_cleanup_manifest(project.path(), &manifest).unwrap();
        let result = cleanup_manifest(project.path(), &manifest);
        assert_eq!(result.removed, vec![relative.to_string()]);
    }

    #[test]
    fn renderer_events_are_rate_limited_without_poisoning_replay_state() {
        let mut store = RendererSessionStore::default();
        let session = store.prepare(input()).unwrap();
        for index in 0..RENDERER_MAX_MESSAGE_RATE {
            assert!(store
                .accept_event(
                    &session.session_id,
                    &session.capability_token,
                    session.generation,
                    "react:Card",
                    "rev-1",
                    &format!("event-{index}"),
                    200,
                )
                .is_ok());
        }
        assert!(store
            .accept_event(
                &session.session_id,
                &session.capability_token,
                session.generation,
                "react:Card",
                "rev-1",
                "event-too-many",
                200,
            )
            .is_err());
        assert!(store
            .accept_event(
                &session.session_id,
                &session.capability_token,
                session.generation,
                "react:Card",
                "rev-1",
                "event-too-many",
                1_201,
            )
            .is_ok());
    }

    #[test]
    fn frame_payloads_are_allowlisted_and_bounded() {
        let mut store = RendererSessionStore::default();
        let session = store.prepare(input()).unwrap();
        let payload = RendererFramePayload {
            protocol_version: 2,
            project_identity: "project-1".to_string(),
            session_id: session.session_id.clone(),
            frame_id: "frame-1".to_string(),
            component_id: "react:Card".to_string(),
            component_revision: "rev-1".to_string(),
            generation: session.generation,
            props: serde_json::json!({"label": "Card"}),
            slots: BTreeMap::from([("children".to_string(), "Hello".to_string())]),
            presentation: RendererFramePresentation {
                width_mode: "fixed".to_string(),
                width: Some(320.0),
                height: "auto".to_string(),
                background: "surface".to_string(),
                breakpoint: None,
                locale: None,
            },
        };
        assert!(store
            .publish_frame(
                &session.session_id,
                &session.capability_token,
                "project-1",
                payload.clone(),
            )
            .is_ok());
        // Six is the initial scheduling target, not the number of payloads a
        // retained canvas session may store. Visiting another mounted card
        // must be able to promote it without evicting a live frame.
        for index in 2..=RENDERER_MAX_LIVE_FRAMES + 1 {
            assert!(store
                .publish_frame(
                    &session.session_id,
                    &session.capability_token,
                    "project-1",
                    RendererFramePayload {
                        frame_id: format!("frame-{index}"),
                        ..payload.clone()
                    },
                )
                .is_ok());
        }
        let aggregate_props = (0..RENDERER_MAX_JSON_ITEMS)
            .map(|index| {
                (
                    format!("prop-{index}"),
                    Value::String("x".repeat(RENDERER_MAX_STRING_LENGTH)),
                )
            })
            .collect();
        assert!(store
            .publish_frame(
                &session.session_id,
                &session.capability_token,
                "project-1",
                RendererFramePayload {
                    props: Value::Object(aggregate_props),
                    ..payload.clone()
                },
            )
            .is_err());
        assert!(store
            .publish_frame(
                &session.session_id,
                &session.capability_token,
                "project-1",
                RendererFramePayload {
                    props: serde_json::Value::String("x".repeat(RENDERER_MAX_STRING_LENGTH + 1)),
                    ..payload
                },
            )
            .is_err());
    }

    #[test]
    fn publish_request_size_includes_outer_auth_metadata() {
        let mut store = RendererSessionStore::default();
        let session = store.prepare(input()).unwrap();
        let payload = RendererFramePayload {
            protocol_version: 2,
            project_identity: "project-1".to_string(),
            session_id: session.session_id.clone(),
            frame_id: "frame-1".to_string(),
            component_id: "react:Card".to_string(),
            component_revision: "rev-1".to_string(),
            generation: session.generation,
            props: serde_json::json!({"label": "Card"}),
            slots: BTreeMap::new(),
            presentation: RendererFramePresentation {
                width_mode: "fixed".to_string(),
                width: Some(320.0),
                height: "auto".to_string(),
                background: "surface".to_string(),
                breakpoint: None,
                locale: None,
            },
        };
        let request = PublishRendererFrameRequest {
            session_id: session.session_id.clone(),
            capability_token: session.capability_token.clone(),
            payload,
        };
        let valid_size = serialized_renderer_request_size(&request).unwrap();
        assert!(valid_size <= RENDERER_MAX_BODY_BYTES);
        assert!(store
            .publish_frame_with_envelope_size(
                &request.session_id,
                &request.capability_token,
                "project-1",
                request.payload.clone(),
                Some(valid_size),
            )
            .is_ok());

        let oversized = PublishRendererFrameRequest {
            capability_token: "x".repeat(RENDERER_MAX_BODY_BYTES),
            ..request
        };
        let oversized_size = serialized_renderer_request_size(&oversized).unwrap();
        assert!(oversized_size > RENDERER_MAX_BODY_BYTES);
        assert!(store
            .publish_frame_with_envelope_size(
                &session.session_id,
                &session.capability_token,
                "project-1",
                oversized.payload,
                Some(oversized_size),
            )
            .is_err());
    }

    #[test]
    fn stale_manifest_recovery_removes_only_unchanged_generated_files() {
        let temp = tempfile::tempdir().unwrap();
        let relative = ".shipstudio/component-renderer/crash-entry.tsx";
        let path = temp.path().join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"generated").unwrap();
        let manifest = RendererCleanupManifest {
            schema_version: 1,
            session_id: "crashed-session".to_string(),
            generation: 1,
            created_at_ms: 1,
            files: vec![GeneratedRendererFile {
                relative_path: relative.to_string(),
                generated_hash: content_hash(b"generated"),
                was_absent: true,
            }],
        };
        write_cleanup_manifest(temp.path(), &manifest).unwrap();
        let result = recover_manifest_for_project(temp.path(), None).unwrap();
        assert_eq!(result.removed, vec![relative.to_string()]);
        assert!(!path.exists());
        assert!(!manifest_path(temp.path()).exists());

        fs::write(&path, b"user changed").unwrap();
        write_cleanup_manifest(temp.path(), &manifest).unwrap();
        assert!(recover_stale_manifest(temp.path()).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"user changed");
    }

    #[test]
    fn renderer_consent_is_project_and_integration_version_scoped() {
        let temp = tempfile::tempdir().unwrap();
        let metadata_path = temp.path().join(".shipstudio/project.json");
        fs::create_dir_all(metadata_path.parent().unwrap()).unwrap();
        let metadata = crate::types::ProjectMetadata {
            component_renderer_consent: Some(crate::types::ComponentRendererConsent {
                integration_version: RENDERER_INTEGRATION_VERSION.to_string(),
                approved_at: 123,
            }),
            ..Default::default()
        };
        fs::write(&metadata_path, serde_json::to_vec(&metadata).unwrap()).unwrap();

        assert!(has_current_renderer_consent(temp.path(), RENDERER_INTEGRATION_VERSION).unwrap());
        assert!(!has_current_renderer_consent(temp.path(), "next-host-v1").unwrap());

        let other = tempfile::tempdir().unwrap();
        assert!(!has_current_renderer_consent(other.path(), RENDERER_INTEGRATION_VERSION).unwrap());
    }

    #[test]
    fn renderer_route_paths_match_generated_next_host_files() {
        assert!(is_renderer_route_path(
            "app/shipstudio_renderer_next-host-v1/page.tsx"
        ));
        assert!(is_renderer_route_path(
            "app/shipstudio_renderer_next-host-v1/__shipstudio_renderer_shell.tsx"
        ));
        assert!(is_renderer_route_path(
            "src/app/shipstudio_renderer_next-host-v1-2/loading.tsx"
        ));
        assert!(is_renderer_route_path(
            "pages/shipstudio_renderer_next-host-v1.tsx"
        ));
        assert!(is_renderer_route_path(
            "src/pages/shipstudio_renderer_next-host-v1-2.tsx"
        ));
        assert!(is_renderer_route_path(
            "app/shipstudio_renderer_next-host-v2/page.tsx"
        ));

        assert!(!is_renderer_route_path(
            "app/shipstudio_renderer_next-host-v1/other.tsx"
        ));
        assert!(!is_renderer_route_path("app/not-a-renderer/page.tsx"));
        assert!(!is_renderer_route_path(
            "app/__shipstudio_renderer_next-host-v1/page.tsx"
        ));
        assert!(!is_renderer_route_path(
            "pages/shipstudio_renderer_next-host-v1.js"
        ));
    }

    #[test]
    fn renderer_allows_generated_paths_inside_active_workspace() {
        let project = tempfile::tempdir().unwrap();
        let workspace = project.path().join("apps/admin");
        let route = "apps/admin/src/app/shipstudio_renderer_next-host-v1/page.tsx";
        fs::create_dir_all(workspace.join("src/app/shipstudio_renderer_next-host-v1")).unwrap();
        fs::create_dir_all(project.path().join(".shipstudio")).unwrap();
        let mut metadata = crate::types::ProjectMetadata::default();
        metadata.workspace_subpath = Some("apps/admin".to_string());
        fs::write(
            project.path().join(".shipstudio/project.json"),
            serde_json::to_vec(&metadata).unwrap(),
        )
        .unwrap();

        assert_eq!(
            renderer_workspace_root(project.path()).unwrap(),
            "apps/admin"
        );
        assert!(is_renderer_route_path_for_workspace(route, "apps/admin"));
        assert_eq!(
            validate_renderer_fs_path(project.path(), route).unwrap(),
            fs::canonicalize(project.path()).unwrap().join(route)
        );

        let contents = b"generated";
        fs::write(project.path().join(route), contents).unwrap();
        let manifest = RendererCleanupManifest {
            schema_version: 1,
            session_id: "workspace-session".to_string(),
            generation: 1,
            created_at_ms: 1,
            files: vec![GeneratedRendererFile {
                relative_path: route.to_string(),
                generated_hash: content_hash(contents),
                was_absent: true,
            }],
        };

        write_cleanup_manifest(project.path(), &manifest).unwrap();
        assert_eq!(
            cleanup_manifest(project.path(), &manifest).removed,
            vec![route]
        );
    }
}
