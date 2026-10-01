//! Cloudflare Workers Builds adapter.
//!
//! The Workers Builds API is separate from Pages. The link stores both the
//! script name and Cloudflare's immutable script tag because the builds list
//! endpoint addresses the tag, while deployment and domain endpoints use the
//! script name. A successful build alone does not prove the Worker is serving
//! it: production is reported only when that build is tied to a version in the
//! latest active deployment.
//!
//! API shapes and status values follow Cloudflare's official references:
//! <https://developers.cloudflare.com/api/resources/workers_builds/>,
//! <https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/>,
//! and <https://developers.cloudflare.com/api/resources/workers_builds/subresources/builds/subresources/logs/>.

use super::http::{get_json, HostingHttpError};
use super::model::{
    iso_to_ms, BuildLog, CloudflareTarget, Deployment, DeploymentDetail, DeploymentPhase,
    DeploymentUrls, Environment, HostingLink, HostingProjectChoice, LogLine, LogStream, Lookup,
};
use serde::Deserialize;
use std::collections::{BTreeMap, HashSet};

const API: &str = "https://api.cloudflare.com/client/v4";
const BUILDS_PER_PAGE: u32 = 100;
const MAX_BUILD_PAGES: u32 = 2;
const MAX_BUILDS: usize = BUILDS_PER_PAGE as usize * MAX_BUILD_PAGES as usize;

#[derive(Debug, Deserialize)]
struct Envelope<T> {
    success: bool,
    result: Option<T>,
}

impl<T> Envelope<T> {
    fn into_result(self) -> Result<T, HostingHttpError> {
        if self.success {
            self.result
                .ok_or_else(|| malformed("Cloudflare omitted the result"))
        } else {
            Err(malformed("Cloudflare reported the request did not succeed"))
        }
    }
}

fn malformed(message: &str) -> HostingHttpError {
    HostingHttpError::Malformed {
        message: message.to_string(),
    }
}

fn url(segments: &[&str], query: &[(&str, &str)]) -> Result<String, HostingHttpError> {
    let mut parsed =
        reqwest::Url::parse(API).map_err(|_| malformed("Invalid Cloudflare API URL"))?;
    {
        let mut path = parsed
            .path_segments_mut()
            .map_err(|_| malformed("Invalid Cloudflare API path"))?;
        path.pop_if_empty();
        path.extend(segments.iter().copied());
    }
    if !query.is_empty() {
        parsed.query_pairs_mut().extend_pairs(query.iter().copied());
    }
    Ok(parsed.to_string())
}

fn account_id(link: &HostingLink) -> Result<&str, HostingHttpError> {
    link.scope_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            malformed("This Cloudflare link is missing its account id — relink the project.")
        })
}

fn script_tag(link: &HostingLink) -> Result<&str, HostingHttpError> {
    match link.cloudflare_target.as_ref() {
        Some(CloudflareTarget::Workers { script_tag }) if !script_tag.trim().is_empty() => {
            Ok(script_tag)
        }
        _ => Err(malformed(
            "This Cloudflare Workers link is missing its script tag — relink the project.",
        )),
    }
}

#[derive(Debug, Deserialize)]
struct PageInfo {
    #[serde(default)]
    total_pages: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct BuildEnvelope {
    success: bool,
    result: Option<Vec<RawBuild>>,
    #[serde(default)]
    result_info: Option<PageInfo>,
}

impl BuildEnvelope {
    fn into_result(self) -> Result<(Vec<RawBuild>, Option<u32>), HostingHttpError> {
        if !self.success {
            return Err(malformed("Cloudflare reported the request did not succeed"));
        }
        Ok((
            self.result
                .ok_or_else(|| malformed("Cloudflare omitted the build list"))?,
            self.result_info.and_then(|info| info.total_pages),
        ))
    }
}

#[derive(Debug, Clone, Deserialize)]
struct RawBuild {
    build_uuid: String,
    #[serde(default)]
    build_outcome: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    build_trigger_metadata: Option<RawBuildMetadata>,
    #[serde(default)]
    created_on: Option<String>,
    #[serde(default)]
    stopped_on: Option<String>,
    /// Officially only included by the build detail endpoint.
    #[serde(default)]
    preview_url: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct RawBuildMetadata {
    #[serde(default)]
    branch: Option<String>,
    #[serde(default)]
    commit_hash: Option<String>,
    #[serde(default)]
    commit_message: Option<String>,
}

fn build_phase(raw: &RawBuild) -> DeploymentPhase {
    match raw
        .build_outcome
        .as_deref()
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("success") => {
            return DeploymentPhase::Unknown {
                raw: "build succeeded; deployment unconfirmed".into(),
            }
        }
        Some("fail") => return DeploymentPhase::Failed,
        Some("skipped") => return DeploymentPhase::Skipped,
        Some("cancelled" | "terminated") => return DeploymentPhase::Canceled,
        Some(other) => return DeploymentPhase::Unknown { raw: other.into() },
        _ => {}
    }

    match raw
        .status
        .as_deref()
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("queued") => DeploymentPhase::Queued,
        Some("initializing" | "running") => DeploymentPhase::Building,
        Some("stopped") => DeploymentPhase::Unknown {
            raw: "stopped; outcome unavailable".into(),
        },
        Some(other) => DeploymentPhase::Unknown { raw: other.into() },
        None => DeploymentPhase::Unknown {
            raw: "build status unavailable".into(),
        },
    }
}

fn status_label(raw: &RawBuild) -> String {
    let value = raw
        .build_outcome
        .as_deref()
        .or(raw.status.as_deref())
        .unwrap_or("unknown");
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => "Unknown".into(),
    }
}

fn timestamp(raw: &RawBuild) -> u64 {
    iso_to_ms(raw.created_on.as_deref()).unwrap_or(0)
}

fn matches_commit(raw: &RawBuild, sha: &str, branch: &str) -> bool {
    let metadata = raw.build_trigger_metadata.as_ref();
    metadata.and_then(|m| m.commit_hash.as_deref()) == Some(sha)
        && metadata.and_then(|m| m.branch.as_deref()) == Some(branch)
}

fn base_deployment(raw: &RawBuild) -> Deployment {
    let meta = raw.build_trigger_metadata.as_ref();
    let phase = build_phase(raw);
    let preview = raw
        .preview_url
        .clone()
        .filter(|value| !value.trim().is_empty());
    let preview_ready = raw.build_outcome.as_deref() == Some("success") && preview.is_some();
    Deployment {
        id: raw.build_uuid.clone(),
        status_label: status_label(raw),
        phase: if preview_ready {
            DeploymentPhase::Ready
        } else {
            phase
        },
        detail: if raw.build_outcome.as_deref() == Some("success") && !preview_ready {
            Some(DeploymentDetail::DeploymentUnconfirmed)
        } else {
            None
        },
        environment: if preview_ready {
            Environment::Preview
        } else {
            Environment::Unknown
        },
        branch: meta.and_then(|m| m.branch.clone()),
        commit_sha: meta.and_then(|m| m.commit_hash.clone()).unwrap_or_default(),
        commit_message: meta
            .and_then(|m| m.commit_message.clone())
            .map(|message| message.trim().to_string())
            .filter(|message| !message.is_empty()),
        urls: DeploymentUrls {
            site: None,
            deployment: preview.clone(),
            aliases: Vec::new(),
            primary: preview,
        },
        dashboard_url: None,
        error_message: None,
        created_at: timestamp(raw),
        ready_at: if preview_ready {
            raw.stopped_on
                .as_deref()
                .and_then(|value| iso_to_ms(Some(value)))
        } else {
            None
        },
    }
}

async fn list_builds(link: &HostingLink, token: &str) -> Result<Vec<RawBuild>, HostingHttpError> {
    let account = account_id(link)?;
    let tag = script_tag(link)?;
    let mut all = Vec::new();
    for page in 1..=MAX_BUILD_PAGES {
        let page_text = page.to_string();
        let per_page = BUILDS_PER_PAGE.to_string();
        let endpoint = url(
            &["accounts", account, "builds", "workers", tag, "builds"],
            &[("page", &page_text), ("per_page", &per_page)],
        )?;
        let (mut builds, total_pages) = get_json::<BuildEnvelope>(&endpoint, token)
            .await?
            .into_result()?;
        let page_empty = builds.is_empty();
        all.append(&mut builds);
        if page_empty || total_pages.is_some_and(|total| page >= total) || all.len() >= MAX_BUILDS {
            break;
        }
    }
    all.sort_by(|a, b| {
        timestamp(b)
            .cmp(&timestamp(a))
            .then_with(|| a.build_uuid.cmp(&b.build_uuid))
    });
    all.truncate(MAX_BUILDS);
    Ok(all)
}

#[derive(Debug, Deserialize)]
struct DeploymentEnvelope {
    #[serde(default)]
    deployments: Vec<RawWorkerDeployment>,
}

#[derive(Debug, Deserialize)]
struct RawWorkerDeployment {
    id: String,
    created_on: String,
    #[serde(default)]
    versions: Vec<RawVersion>,
}

#[derive(Debug, Deserialize)]
struct RawVersion {
    version_id: String,
    percentage: f64,
}

#[derive(Debug, Deserialize)]
struct VersionBuilds {
    #[serde(default)]
    builds: BTreeMap<String, RawBuild>,
}

async fn serving_version_ids(
    link: &HostingLink,
    token: &str,
) -> Result<HashSet<String>, HostingHttpError> {
    let account = account_id(link)?;
    let endpoint = url(
        &[
            "accounts",
            account,
            "workers",
            "scripts",
            &link.project_id,
            "deployments",
        ],
        &[],
    )?;
    let deployments = get_json::<Envelope<DeploymentEnvelope>>(&endpoint, token)
        .await?
        .into_result()?
        .deployments;
    Ok(active_version_ids(deployments))
}

fn active_version_ids(mut deployments: Vec<RawWorkerDeployment>) -> HashSet<String> {
    deployments.sort_by(|a, b| {
        iso_to_ms(Some(&b.created_on))
            .unwrap_or(0)
            .cmp(&iso_to_ms(Some(&a.created_on)).unwrap_or(0))
            .then_with(|| b.id.cmp(&a.id))
    });
    let Some(latest) = deployments.first() else {
        return HashSet::new();
    };
    latest
        .versions
        .iter()
        .filter(|version| version.percentage > 0.0)
        .map(|version| version.version_id.clone())
        .collect()
}

fn build_ids_for_versions(
    builds: BTreeMap<String, RawBuild>,
    active_versions: &HashSet<String>,
) -> HashSet<String> {
    builds
        .into_iter()
        .filter(|(version_id, _)| active_versions.contains(version_id))
        .map(|(_, build)| build.build_uuid)
        .collect()
}

async fn active_build_ids(
    link: &HostingLink,
    token: &str,
) -> Result<HashSet<String>, HostingHttpError> {
    let active_versions = serving_version_ids(link, token).await?;
    if active_versions.is_empty() {
        return Ok(HashSet::new());
    }
    let account = account_id(link)?;
    let versions: Vec<String> = active_versions.iter().cloned().collect();
    let mut build_ids = HashSet::new();
    for chunk in versions.chunks(20) {
        let ids = chunk.join(",");
        let endpoint = url(
            &["accounts", account, "builds", "builds"],
            &[("version_ids", &ids)],
        )?;
        let response: Envelope<VersionBuilds> = get_json(&endpoint, token).await?;
        let version_builds = response.into_result()?;
        build_ids.extend(build_ids_for_versions(
            version_builds.builds,
            &active_versions,
        ));
    }
    Ok(build_ids)
}

async fn enrich_success(
    link: &HostingLink,
    token: &str,
    raw: &RawBuild,
    mut deployment: Deployment,
    active_builds: &HashSet<String>,
    production_site: Option<&str>,
) -> Result<Deployment, HostingHttpError> {
    let preview_url = match fetch_build(link, token, &raw.build_uuid).await {
        Ok(detail) => detail.preview_url.filter(|url| !url.trim().is_empty()),
        Err(HostingHttpError::Rejected) => return Err(HostingHttpError::Rejected),
        Err(_) => None,
    };

    if active_builds.contains(&raw.build_uuid) {
        deployment.phase = DeploymentPhase::Ready;
        deployment.detail = None;
        deployment.environment = Environment::Production;
        deployment.urls.deployment = preview_url.clone();
        deployment.ready_at = raw
            .stopped_on
            .as_deref()
            .and_then(|value| iso_to_ms(Some(value)));
        if let Some(site) = production_site {
            deployment.urls.site = Some(site.to_string());
            deployment.urls.primary = Some(site.to_string());
        } else {
            deployment.urls.primary = preview_url;
        }
        return Ok(deployment);
    }

    if let Some(preview) = preview_url {
        deployment.phase = DeploymentPhase::Ready;
        deployment.detail = None;
        deployment.environment = Environment::Preview;
        deployment.ready_at = raw
            .stopped_on
            .as_deref()
            .and_then(|value| iso_to_ms(Some(value)));
        deployment.urls.deployment = Some(preview.clone());
        deployment.urls.primary = Some(preview);
        return Ok(deployment);
    }

    deployment.phase = DeploymentPhase::Unknown {
        raw: "build succeeded; deployment unconfirmed".into(),
    };
    deployment.environment = Environment::Unknown;
    Ok(deployment)
}

async fn success_context(
    link: &HostingLink,
    token: &str,
) -> Result<(HashSet<String>, Option<String>), HostingHttpError> {
    // These API calls enrich a successful build. Non-auth failures degrade to
    // an unknown environment; credential rejection still reaches the reducer.
    let active_builds = match active_build_ids(link, token).await {
        Ok(builds) => builds,
        Err(HostingHttpError::Rejected) => return Err(HostingHttpError::Rejected),
        Err(_) => HashSet::new(),
    };
    let site = if active_builds.is_empty() {
        None
    } else {
        match fetch_domain(link, token).await {
            Ok(site) => site,
            Err(HostingHttpError::Rejected) => return Err(HostingHttpError::Rejected),
            Err(_) => None,
        }
    };
    Ok((active_builds, site))
}

#[derive(Debug, Deserialize)]
struct BuildDetail {
    #[serde(flatten)]
    build: RawBuild,
}

async fn fetch_build(
    link: &HostingLink,
    token: &str,
    build_uuid: &str,
) -> Result<RawBuild, HostingHttpError> {
    let account = account_id(link)?;
    let endpoint = url(&["accounts", account, "builds", "builds", build_uuid], &[])?;
    let detail: Envelope<BuildDetail> = get_json(&endpoint, token).await?;
    Ok(detail.into_result()?.build)
}

#[derive(Debug, Deserialize)]
struct RawDomain {
    hostname: String,
    service: String,
    #[serde(default)]
    environment: Option<String>,
}

async fn fetch_domain(link: &HostingLink, token: &str) -> Result<Option<String>, HostingHttpError> {
    let account = account_id(link)?;
    let endpoint = url(
        &["accounts", account, "workers", "domains"],
        &[("service", &link.project_id)],
    )?;
    let domains: Vec<RawDomain> = get_json::<Envelope<Vec<RawDomain>>>(&endpoint, token)
        .await?
        .into_result()?;
    Ok(domains
        .into_iter()
        .find(|domain| {
            domain.service == link.project_id && domain.environment.as_deref() == Some("production")
        })
        .map(|domain| with_https(&domain.hostname)))
}

fn with_https(value: &str) -> String {
    if value.starts_with("https://") || value.starts_with("http://") {
        value.to_string()
    } else {
        format!("https://{value}")
    }
}

pub async fn find_for_commit(
    link: &HostingLink,
    token: &str,
    sha: &str,
    branch: &str,
) -> Result<Lookup, HostingHttpError> {
    let builds = list_builds(link, token).await?;
    let mut matches: Vec<RawBuild> = builds
        .into_iter()
        .filter(|build| matches_commit(build, sha, branch))
        .collect();
    matches.sort_by(|a, b| {
        timestamp(b)
            .cmp(&timestamp(a))
            .then_with(|| a.build_uuid.cmp(&b.build_uuid))
    });
    let Some(raw) = matches.into_iter().next() else {
        return Ok(Lookup::NotFound {
            latest_on_branch: None,
        });
    };
    let mut deployment = base_deployment(&raw);
    if raw.build_outcome.as_deref() == Some("success") {
        let (active_builds, site) = success_context(link, token).await?;
        deployment = enrich_success(
            link,
            token,
            &raw,
            deployment,
            &active_builds,
            site.as_deref(),
        )
        .await?;
    }
    Ok(Lookup::Found { deployment })
}

pub async fn list_recent(
    link: &HostingLink,
    token: &str,
    limit: u32,
) -> Result<Vec<Deployment>, HostingHttpError> {
    let builds = list_builds(link, token).await?;
    let builds: Vec<RawBuild> = builds
        .into_iter()
        .take(limit.min(MAX_BUILDS as u32) as usize)
        .collect();
    let has_success = builds
        .iter()
        .any(|raw| raw.build_outcome.as_deref() == Some("success"));
    let (active_builds, site) = if has_success {
        success_context(link, token).await?
    } else {
        (HashSet::new(), None)
    };
    let mut deployments = Vec::with_capacity(builds.len());
    for raw in builds {
        let mut deployment = base_deployment(&raw);
        if raw.build_outcome.as_deref() == Some("success") {
            deployment = enrich_success(
                link,
                token,
                &raw,
                deployment,
                &active_builds,
                site.as_deref(),
            )
            .await?;
        }
        deployments.push(deployment);
    }
    Ok(deployments)
}

#[derive(Debug, Deserialize)]
struct RawLogLine(Vec<serde_json::Value>);

#[derive(Debug, Deserialize)]
struct RawLogs {
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    lines: Vec<RawLogLine>,
    #[serde(default)]
    truncated: bool,
}

fn to_build_log(deployment_id: &str, logs: RawLogs) -> BuildLog {
    let lines = logs
        .lines
        .into_iter()
        .filter_map(|line| {
            let timestamp = line.0.first()?.as_f64()?;
            let text = line.0.get(1)?.as_str()?.trim_end();
            if text.is_empty() {
                return None;
            }
            Some(LogLine {
                at: (timestamp * 1_000.0).max(0.0) as u64,
                stream: LogStream::Stdout,
                text: text.to_string(),
            })
        })
        .collect();
    // We deliberately fetch only the first bounded page. A returned cursor is
    // evidence that more log data exists; stream origin is not represented by
    // this API, so all lines use stdout without claiming stderr.
    let truncated = logs.truncated || logs.cursor.is_some();
    BuildLog {
        deployment_id: deployment_id.to_string(),
        lines,
        truncated,
    }
}

pub async fn fetch_logs(
    link: &HostingLink,
    token: &str,
    deployment_id: &str,
) -> Result<BuildLog, HostingHttpError> {
    let account = account_id(link)?;
    let endpoint = url(
        &[
            "accounts",
            account,
            "builds",
            "builds",
            deployment_id,
            "logs",
        ],
        &[],
    )?;
    let logs: RawLogs = get_json::<Envelope<RawLogs>>(&endpoint, token)
        .await?
        .into_result()?;
    Ok(to_build_log(deployment_id, logs))
}

#[derive(Debug, Deserialize)]
struct RawScript {
    id: String,
    tag: String,
}

#[derive(Debug, Deserialize)]
struct RawAccount {
    id: String,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AccountsPage {
    #[serde(default)]
    total_pages: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct AccountEnvelope {
    success: bool,
    result: Option<Vec<RawAccount>>,
    #[serde(default)]
    result_info: Option<AccountsPage>,
}

pub async fn list_projects(
    token: &str,
    scope_id: Option<&str>,
) -> Result<Vec<HostingProjectChoice>, HostingHttpError> {
    let mut accounts = Vec::new();
    if let Some(id) = scope_id.filter(|id| !id.trim().is_empty()) {
        accounts.push(RawAccount {
            id: id.to_string(),
            name: None,
        });
    } else {
        // Account listing is paginated. Bound it to 100 pages to avoid an
        // unbounded credential-picker request if provider metadata is corrupt.
        for page in 1..=100u32 {
            let page_text = page.to_string();
            let per_page = "50";
            let endpoint = url(
                &["accounts"],
                &[("page", &page_text), ("per_page", per_page)],
            )?;
            let response: AccountEnvelope = get_json(&endpoint, token).await?;
            if !response.success {
                return Err(malformed("Cloudflare reported the request did not succeed"));
            }
            let mut result = response
                .result
                .ok_or_else(|| malformed("Cloudflare omitted the account list"))?;
            let total_pages = response.result_info.and_then(|info| info.total_pages);
            let count = result.len();
            accounts.append(&mut result);
            if count < 50 || total_pages.is_some_and(|total| page >= total) {
                break;
            }
        }
    }

    let mut choices = Vec::new();
    for account in accounts {
        let endpoint = url(&["accounts", &account.id, "workers", "scripts"], &[])?;
        let scripts: Vec<RawScript> = get_json::<Envelope<Vec<RawScript>>>(&endpoint, token)
            .await?
            .into_result()?;
        for script in scripts {
            if script.id.trim().is_empty() || script.tag.trim().is_empty() {
                continue;
            }
            choices.push(HostingProjectChoice {
                id: script.id.clone(),
                name: script.id,
                scope_id: Some(account.id.clone()),
                scope_name: account.name.clone(),
                cloudflare_target: Some(CloudflareTarget::Workers {
                    script_tag: script.tag,
                }),
            });
        }
    }
    choices.sort_by(|a, b| {
        a.name
            .cmp(&b.name)
            .then_with(|| a.scope_id.cmp(&b.scope_id))
    });
    Ok(choices)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build(json: &str) -> RawBuild {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn successful_build_alone_is_not_ready_or_production() {
        let deployment = base_deployment(&build(
            r#"{"build_uuid":"b1","build_outcome":"success","status":"stopped","created_on":"2026-09-01T00:00:00Z","build_trigger_metadata":{"branch":"main","commit_hash":"abc"}}"#,
        ));
        assert_eq!(
            deployment.phase,
            DeploymentPhase::Unknown {
                raw: "build succeeded; deployment unconfirmed".into()
            }
        );
        assert_eq!(deployment.environment, Environment::Unknown);
        assert!(deployment.urls.primary.is_none());
        assert_eq!(
            deployment.detail,
            Some(DeploymentDetail::DeploymentUnconfirmed)
        );
    }

    #[test]
    fn preview_readiness_uses_only_the_exact_preview_url() {
        let deployment = base_deployment(&build(
            r#"{"build_uuid":"b1","build_outcome":"success","status":"stopped","preview_url":"https://preview.example.workers.dev"}"#,
        ));
        assert_eq!(deployment.phase, DeploymentPhase::Ready);
        assert_eq!(deployment.environment, Environment::Preview);
        assert_eq!(
            deployment.urls.primary.as_deref(),
            Some("https://preview.example.workers.dev")
        );
    }

    #[test]
    fn branch_and_full_sha_both_have_to_match() {
        let raw = build(
            r#"{"build_uuid":"b1","build_outcome":"fail","build_trigger_metadata":{"branch":"main","commit_hash":"abc123"}}"#,
        );
        assert!(matches_commit(&raw, "abc123", "main"));
        assert!(!matches_commit(&raw, "abc", "main"));
        assert!(!matches_commit(&raw, "abc123", "release"));
    }

    #[test]
    fn lifecycle_outcomes_remain_distinct_and_unknown_statuses_stay_unknown() {
        assert_eq!(
            build_phase(&build(r#"{"build_uuid":"b","build_outcome":"fail"}"#)),
            DeploymentPhase::Failed
        );
        assert_eq!(
            build_phase(&build(r#"{"build_uuid":"b","build_outcome":"skipped"}"#)),
            DeploymentPhase::Skipped
        );
        assert_eq!(
            build_phase(&build(r#"{"build_uuid":"b","build_outcome":"cancelled"}"#)),
            DeploymentPhase::Canceled
        );
        assert_eq!(
            build_phase(&build(r#"{"build_uuid":"b","status":"paused"}"#)),
            DeploymentPhase::Unknown {
                raw: "paused".into()
            }
        );
    }

    #[test]
    fn a_cursor_marks_the_log_page_partial_without_inventing_streams() {
        let logs: RawLogs = serde_json::from_str(
            r#"{"cursor":"next","lines":[[1700000000,"Build failed  "]],"truncated":false}"#,
        )
        .unwrap();
        let output = to_build_log("b1", logs);
        assert!(output.truncated);
        assert_eq!(output.lines[0].at, 1_700_000_000_000);
        assert_eq!(output.lines[0].text, "Build failed");
        assert_eq!(output.lines[0].stream, LogStream::Stdout);
    }

    #[test]
    fn production_proof_uses_positive_versions_from_only_the_latest_deployment() {
        let deployments: Vec<RawWorkerDeployment> = serde_json::from_str(
            r#"[
                {"id":"old","created_on":"2026-01-01T00:00:00Z","versions":[{"version_id":"old-version","percentage":100}]},
                {"id":"new","created_on":"2026-02-01T00:00:00Z","versions":[{"version_id":"zero","percentage":0},{"version_id":"live","percentage":25}]}
            ]"#,
        )
        .unwrap();
        assert_eq!(
            active_version_ids(deployments),
            HashSet::from(["live".into()])
        );
    }

    #[test]
    fn a_build_record_proves_serving_only_under_the_requested_version_key() {
        let active = HashSet::from(["live".to_string()]);
        let wrong_key: BTreeMap<String, RawBuild> =
            serde_json::from_str(r#"{"other":{"build_uuid":"b1"}}"#).unwrap();
        assert!(build_ids_for_versions(wrong_key, &active).is_empty());

        let matching_key: BTreeMap<String, RawBuild> =
            serde_json::from_str(r#"{"live":{"build_uuid":"b1"}}"#).unwrap();
        assert_eq!(
            build_ids_for_versions(matching_key, &active),
            HashSet::from(["b1".into()])
        );
    }

    #[test]
    fn url_segments_and_queries_are_encoded() {
        let endpoint = url(
            &["accounts", "a/b", "workers", "script name"],
            &[("service", "script&name")],
        )
        .unwrap();
        assert!(endpoint.contains("a%2Fb"));
        assert!(endpoint.contains("script%20name"));
        assert!(endpoint.contains("service=script%26name"));
    }
}
