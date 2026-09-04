//! Conservative source-graph validation for native component mutations.
//!
//! This is deliberately not a JavaScript/TypeScript parser.  The worker owns
//! the complete AST-backed plan; this module is a small last-mile check that
//! confirms the plan's dialect token and that simple, statically imported
//! React/JSX or Astro usages change by the promised amount before any file is
//! staged.  Unknown or ambiguous source shapes are rejected rather than
//! guessed.

use super::inventory::validate_relative_source_path;
use super::types::{
    ComponentFileOperation, ComponentGraphDelta, ComponentMutationPlan, SourceFileSnapshot,
};
use crate::errors::CommandError;
use std::collections::HashSet;

pub(crate) const REACT_COMPONENT_PLAN_PARSER_TOKEN: &str = "react-component-plan-v1";
pub(crate) const REACT_NATIVE_COMPONENT_PLAN_PARSER_TOKEN: &str = "react-native-component-plan-v1";
pub(crate) const ASTRO_COMPONENT_PLAN_PARSER_TOKEN: &str = "astro-component-plan-v1";

const MAX_COMPONENT_USAGE_COUNT: usize = 100_000;
const REACT_SOURCE_EXTENSIONS: &[&str] =
    &[".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
const ASTRO_SOURCE_EXTENSIONS: &[&str] = &[".astro"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ComponentGraphDialect {
    React,
    ReactNative,
    Astro,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TokenKind {
    Identifier,
    String,
    Number,
    Punctuation,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Token {
    kind: TokenKind,
    text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ImportBinding {
    source: String,
    imported: String,
    local: String,
    namespace: bool,
}

/// Validate protocol metadata before any source read or write happens.
///
/// Legacy edit-only callers may omit all metadata.  A partially populated
/// protocol is rejected so a caller cannot silently opt out of one guard while
/// still claiming to be a parser-backed component plan.
pub(crate) fn validate_plan_protocol(
    plan: &ComponentMutationPlan,
) -> Result<Option<&ComponentGraphDelta>, CommandError> {
    let has_lifecycle_operations = plan
        .operations
        .as_ref()
        .is_some_and(|operations| !operations.is_empty());
    if has_lifecycle_operations
        && plan
            .operations
            .as_ref()
            .is_some_and(|operations| !operations.iter().all(is_supported_lifecycle_operation))
    {
        return Err(validation(
            "operations",
            "the lifecycle transaction contains an unsupported operation",
        ));
    }

    let has_protocol_metadata = plan.dialect.is_some()
        || plan.parser_token.is_some()
        || plan.expected_graph_delta.is_some();
    if !has_protocol_metadata {
        return Ok(None);
    }

    let dialect = match plan.dialect.as_deref() {
        Some("react") => ComponentGraphDialect::React,
        Some("react-native") => ComponentGraphDialect::ReactNative,
        Some("astro") => ComponentGraphDialect::Astro,
        _ => {
            return Err(validation(
                "dialect",
                "the mutation boundary only accepts React, React Native, or Astro plans",
            ))
        }
    };
    let expected_token = match dialect {
        ComponentGraphDialect::React => REACT_COMPONENT_PLAN_PARSER_TOKEN,
        ComponentGraphDialect::ReactNative => REACT_NATIVE_COMPONENT_PLAN_PARSER_TOKEN,
        ComponentGraphDialect::Astro => ASTRO_COMPONENT_PLAN_PARSER_TOKEN,
    };
    if plan.parser_token.as_deref() != Some(expected_token) {
        return Err(validation(
            "parserToken",
            format!("the {dialect:?} mutation parser token is missing or unsupported"),
        ));
    }
    let delta = plan.expected_graph_delta.as_ref().ok_or_else(|| {
        validation(
            "expectedGraphDelta",
            "parser-backed component plans must include an expected graph delta",
        )
    })?;
    validate_graph_delta_shape(delta)?;
    if parse_component_id(&delta.component_id)
        .is_none_or(|(graph_dialect, _, _)| graph_dialect != dialect)
    {
        return Err(validation(
            "expectedGraphDelta",
            "component identity dialect does not match the mutation plan dialect",
        ));
    }
    Ok(Some(delta))
}

/// Re-count the affected component's statically resolvable invocation sites in
/// the complete before/after source snapshots.  The component id selects the
/// dialect-specific guard after the protocol has already validated the token.
pub(crate) fn validate_expected_graph_delta(
    before: &[SourceFileSnapshot],
    after: &[SourceFileSnapshot],
    delta: &ComponentGraphDelta,
) -> Result<(), CommandError> {
    let before_count = count_component_usages(before, &delta.component_id).map_err(|reason| {
        validation(
            "expectedGraphDelta",
            format!("could not verify the component graph before the edit: {reason}"),
        )
    })?;
    let after_count = if delta.removed_component_id.as_deref() == Some(delta.component_id.as_str())
    {
        count_component_usages_allow_missing(after, &delta.component_id)
    } else {
        count_component_usages(after, &delta.component_id)
    }
    .map_err(|reason| {
        validation(
            "expectedGraphDelta",
            format!("could not verify the component graph after the edit: {reason}"),
        )
    })?;

    if before_count != delta.usages_before {
        return Err(validation(
            "expectedGraphDelta",
            format!(
                "expected {} usages before the edit, but the source graph contains {before_count}",
                delta.usages_before
            ),
        ));
    }
    if after_count != delta.usages_after {
        return Err(validation(
            "expectedGraphDelta",
            format!(
                "expected {} usages after the edit, but the proposed source graph contains {after_count}",
                delta.usages_after
            ),
        ));
    }
    if let Some(created_component_id) = &delta.created_component_id {
        let expected_created_count = delta.created_usages.ok_or_else(|| {
            validation(
                "expectedGraphDelta",
                "createdUsages is required when createdComponentId is present",
            )
        })?;
        let actual_created_count =
            count_component_usages(after, created_component_id).map_err(|reason| {
                validation(
                    "expectedGraphDelta",
                    format!("could not verify the created component graph: {reason}"),
                )
            })?;
        if actual_created_count != expected_created_count {
            return Err(validation(
                "expectedGraphDelta",
                format!(
                    "expected {expected_created_count} usages for the created component, but the proposed source graph contains {actual_created_count}"
                ),
            ));
        }
    }
    Ok(())
}

fn validate_graph_delta_shape(delta: &ComponentGraphDelta) -> Result<(), CommandError> {
    validate_component_id(&delta.component_id)?;
    let component_dialect = parse_component_id(&delta.component_id)
        .map(|(dialect, _, _)| dialect)
        .ok_or_else(|| {
            validation(
                "expectedGraphDelta",
                "component identity must use a supported dialect prefix",
            )
        })?;
    if delta.usages_before > MAX_COMPONENT_USAGE_COUNT
        || delta.usages_after > MAX_COMPONENT_USAGE_COUNT
    {
        return Err(validation(
            "expectedGraphDelta",
            format!("component usage counts may not exceed {MAX_COMPONENT_USAGE_COUNT}"),
        ));
    }
    let calculated = delta.usages_after as i64 - delta.usages_before as i64;
    if delta.delta != calculated {
        return Err(validation(
            "expectedGraphDelta",
            format!(
                "delta {} does not equal usagesAfter - usagesBefore ({calculated})",
                delta.delta
            ),
        ));
    }
    if delta.created_component_id.is_some() != delta.created_usages.is_some() {
        return Err(validation(
            "expectedGraphDelta",
            "createdComponentId and createdUsages must be supplied together",
        ));
    }
    if let Some(created_component_id) = &delta.created_component_id {
        validate_component_id(created_component_id)?;
        if parse_component_id(created_component_id)
            .is_none_or(|(dialect, _, _)| dialect != component_dialect)
        {
            return Err(validation(
                "expectedGraphDelta",
                "createdComponentId must use the same dialect as componentId",
            ));
        }
        if created_component_id == &delta.component_id {
            return Err(validation(
                "expectedGraphDelta",
                "createdComponentId must identify a different component",
            ));
        }
    }
    if let Some(removed_component_id) = &delta.removed_component_id {
        validate_component_id(removed_component_id)?;
        if parse_component_id(removed_component_id)
            .is_none_or(|(dialect, _, _)| dialect != component_dialect)
        {
            return Err(validation(
                "expectedGraphDelta",
                "removedComponentId must use the same dialect as componentId",
            ));
        }
        if removed_component_id != &delta.component_id {
            return Err(validation(
                "expectedGraphDelta",
                "removedComponentId must identify the component being changed",
            ));
        }
    }
    if delta
        .created_usages
        .is_some_and(|count| count > MAX_COMPONENT_USAGE_COUNT)
    {
        return Err(validation(
            "expectedGraphDelta",
            format!("component usage counts may not exceed {MAX_COMPONENT_USAGE_COUNT}"),
        ));
    }
    Ok(())
}

fn validate_component_id(component_id: &str) -> Result<(String, String), CommandError> {
    let (dialect, file, export) = parse_component_id(component_id).ok_or_else(|| {
        validation(
            "expectedGraphDelta",
            "component identity must be in the form react:path#export, react-native:path#export, or astro:path#default",
        )
    })?;
    validate_relative_source_path(&file).map_err(|_| {
        validation(
            "expectedGraphDelta",
            "component identity must reference a normalized project-relative source file",
        )
    })?;
    if export.is_empty()
        || (!is_identifier(&export) && export != "default")
        || (dialect == ComponentGraphDialect::Astro
            && (!file.ends_with(".astro") || export != "default"))
        || (dialect == ComponentGraphDialect::ReactNative
            && !REACT_SOURCE_EXTENSIONS
                .iter()
                .any(|extension| file.to_ascii_lowercase().ends_with(extension)))
    {
        return Err(validation(
            "expectedGraphDelta",
            "component identity must reference a valid export for its dialect",
        ));
    }
    Ok((file, export))
}

fn is_supported_lifecycle_operation(operation: &ComponentFileOperation) -> bool {
    matches!(
        operation,
        ComponentFileOperation::Edit { .. }
            | ComponentFileOperation::Create { .. }
            | ComponentFileOperation::Move { .. }
            | ComponentFileOperation::Delete { .. }
    )
}

fn count_component_usages(
    files: &[SourceFileSnapshot],
    component_id: &str,
) -> Result<usize, String> {
    let (dialect, _, _) = parse_component_id(component_id)
        .ok_or_else(|| "the component identity is not a supported source identity".to_string())?;
    match dialect {
        ComponentGraphDialect::React | ComponentGraphDialect::ReactNative => {
            count_react_component_usages(files, component_id)
        }
        ComponentGraphDialect::Astro => count_astro_component_usages(files, component_id),
    }
}

fn count_react_component_usages(
    files: &[SourceFileSnapshot],
    component_id: &str,
) -> Result<usize, String> {
    let (_, target_file, export_name) = parse_component_id(component_id)
        .ok_or_else(|| "the component identity is not a React source identity".to_string())?;
    let definition = files
        .iter()
        .find(|file| normalize_path(&file.file) == target_file)
        .ok_or_else(|| format!("definition file '{target_file}' is not in the source snapshot"))?;
    let local_name = exported_local_name(&definition.content, &export_name)
        .ok_or_else(|| "the component export could not be resolved conservatively".to_string())?;
    let file_paths: HashSet<String> = files
        .iter()
        .map(|file| normalize_path(&file.file))
        .collect();
    let mut count = 0_usize;

    for file in files {
        let normalized_file = normalize_path(&file.file);
        let mut aliases = Vec::new();
        if normalized_file == target_file {
            if let Some(local_name) = local_name.as_deref() {
                aliases.push(local_name.to_string());
            }
        }
        for binding in collect_import_bindings(&file.content) {
            let Some(imported_file) = resolve_import_path(&file.file, &binding.source, &file_paths)
            else {
                continue;
            };
            if imported_file != target_file {
                continue;
            }
            if binding.namespace {
                aliases.push(format!("{}.{}", binding.local, export_name));
            } else if binding.imported == export_name {
                aliases.push(binding.local);
            }
        }
        if aliases.is_empty() {
            continue;
        }
        count = count
            .checked_add(count_jsx_openings(&file.content, &aliases))
            .ok_or_else(|| "component usage count overflowed".to_string())?;
        if count > MAX_COMPONENT_USAGE_COUNT {
            return Err(format!(
                "component usage count exceeds {MAX_COMPONENT_USAGE_COUNT}"
            ));
        }
    }
    Ok(count)
}

fn count_component_usages_allow_missing(
    files: &[SourceFileSnapshot],
    component_id: &str,
) -> Result<usize, String> {
    let (dialect, target_file, export_name) = parse_component_id(component_id)
        .ok_or_else(|| "the component identity is not a supported source identity".to_string())?;
    if dialect == ComponentGraphDialect::Astro {
        if !files
            .iter()
            .any(|file| normalize_path(&file.file) == target_file)
        {
            return Ok(0);
        }
        return count_astro_component_usages(files, component_id);
    }
    let Some(definition) = files
        .iter()
        .find(|file| normalize_path(&file.file) == target_file)
    else {
        return Ok(0);
    };
    if exported_local_name(&definition.content, &export_name).is_none() {
        return Ok(0);
    }
    count_component_usages(files, component_id)
}

fn parse_component_id(component_id: &str) -> Option<(ComponentGraphDialect, String, String)> {
    let (dialect, rest) = if let Some(rest) = component_id.strip_prefix("react:") {
        (ComponentGraphDialect::React, rest)
    } else if let Some(rest) = component_id.strip_prefix("react-native:") {
        (ComponentGraphDialect::ReactNative, rest)
    } else if let Some(rest) = component_id.strip_prefix("astro:") {
        (ComponentGraphDialect::Astro, rest)
    } else {
        return None;
    };
    let (file, export) = rest.rsplit_once('#')?;
    if file.is_empty() || export.is_empty() {
        return None;
    }
    Some((dialect, normalize_path(file), export.to_string()))
}

fn count_astro_component_usages(
    files: &[SourceFileSnapshot],
    component_id: &str,
) -> Result<usize, String> {
    let (_, target_file, export_name) = parse_component_id(component_id)
        .ok_or_else(|| "the component identity is not an Astro source identity".to_string())?;
    if export_name != "default" {
        return Err("Astro component identities must use the default export".to_string());
    }
    if !files
        .iter()
        .any(|file| normalize_path(&file.file) == target_file)
    {
        return Err(format!(
            "definition file '{target_file}' is not in the source snapshot"
        ));
    }

    let file_paths: HashSet<String> = files
        .iter()
        .map(|file| normalize_path(&file.file))
        .collect();
    let mut count = 0_usize;

    for file in files {
        let normalized_file = normalize_path(&file.file);
        if !normalized_file.ends_with(".astro") || normalized_file == target_file {
            continue;
        }
        let frontmatter = astro_frontmatter(&file.content).unwrap_or("");
        let aliases: Vec<String> = collect_import_bindings(frontmatter)
            .into_iter()
            .filter_map(|binding| {
                let imported_file =
                    resolve_astro_import_path(&file.file, &binding.source, &file_paths)?;
                (imported_file == target_file
                    && !binding.namespace
                    && binding.imported == "default")
                    .then_some(binding.local)
            })
            .collect();
        if aliases.is_empty() {
            continue;
        }
        count = count
            .checked_add(count_astro_openings(&file.content, &aliases))
            .ok_or_else(|| "component usage count overflowed".to_string())?;
        if count > MAX_COMPONENT_USAGE_COUNT {
            return Err(format!(
                "component usage count exceeds {MAX_COMPONENT_USAGE_COUNT}"
            ));
        }
    }
    Ok(count)
}

fn resolve_astro_import_path(
    from_file: &str,
    source: &str,
    files: &HashSet<String>,
) -> Option<String> {
    if !source.starts_with('.') {
        return None;
    }
    let mut parts: Vec<&str> = from_file.split('/').collect();
    parts.pop();
    let base = normalize_path(&format!("{}/{}", parts.join("/"), source));
    let mut candidates = vec![base.clone()];
    for extension in ASTRO_SOURCE_EXTENSIONS {
        candidates.push(format!("{base}{extension}"));
    }
    for extension in ASTRO_SOURCE_EXTENSIONS {
        candidates.push(format!("{base}/index{extension}"));
    }
    candidates
        .into_iter()
        .find(|candidate| files.contains(candidate))
}

fn astro_frontmatter(source: &str) -> Option<&str> {
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    if !source.starts_with("---") {
        return None;
    }
    let closing = source[3..].find("\n---")? + 3;
    Some(&source[3..closing])
}

fn astro_template(source: &str) -> &str {
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    let Some(closing) = source[3..].find("\n---").map(|offset| offset + 3) else {
        return source;
    };
    &source[(closing + 4).min(source.len())..]
}

fn count_astro_openings(source: &str, aliases: &[String]) -> usize {
    let aliases: HashSet<&str> = aliases.iter().map(String::as_str).collect();
    let template = astro_template(source).as_bytes();
    let mut index = 0;
    let mut count = 0;
    while index < template.len() {
        if let Some(end) = skip_astro_ignored_block(template, index) {
            index = end;
            continue;
        }
        if template[index] != b'<' {
            index += 1;
            continue;
        }
        if template
            .get(index + 1)
            .is_some_and(|byte| matches!(byte, b'/' | b'!' | b'?'))
        {
            index += 1;
            continue;
        }
        let mut cursor = index + 1;
        let name_start = cursor;
        while cursor < template.len()
            && (is_identifier_continue(template[cursor]) || template[cursor] == b'.')
        {
            cursor += 1;
        }
        if cursor == name_start {
            index += 1;
            continue;
        }
        let name = String::from_utf8_lossy(&template[name_start..cursor]);
        if aliases.contains(name.as_ref()) {
            count += 1;
        }
        index = cursor;
    }
    count
}

fn skip_astro_ignored_block(source: &[u8], index: usize) -> Option<usize> {
    if source.get(index..index + 4) == Some(b"<!--") {
        let end = source[index + 4..]
            .windows(3)
            .position(|window| window == b"-->")?;
        return Some(index + 4 + end + 3);
    }
    for tag in [b"<script".as_slice(), b"<style".as_slice()] {
        if !source[index..].starts_with(tag) {
            continue;
        }
        let name_end = index + tag.len();
        if source
            .get(name_end)
            .is_some_and(|byte| is_identifier_continue(*byte))
        {
            continue;
        }
        let closing = if tag == b"<script".as_slice() {
            b"</script>".as_slice()
        } else {
            b"</style>".as_slice()
        };
        let end = source[name_end..]
            .windows(closing.len())
            .position(|window| window.eq_ignore_ascii_case(closing))?;
        return Some(name_end + end + closing.len());
    }
    None
}

fn exported_local_name(source: &str, export_name: &str) -> Option<Option<String>> {
    let tokens = lex(source);
    let mut index = 0;
    while index < tokens.len() {
        if tokens[index].text != "export" {
            index += 1;
            continue;
        }
        let next = tokens.get(index + 1)?.text.as_str();
        if export_name == "default" && next == "default" {
            match tokens.get(index + 2).map(|token| token.text.as_str()) {
                Some("function") | Some("class") => {
                    return Some(
                        tokens
                            .get(index + 3)
                            .and_then(identifier_text)
                            .map(str::to_string),
                    );
                }
                Some(name) if is_identifier(name) => return Some(Some(name.to_string())),
                _ => {}
            }
        } else if export_name != "default"
            && matches!(next, "function" | "class" | "const" | "let" | "var")
        {
            if let Some(name) = tokens.get(index + 2).and_then(identifier_text) {
                if name == export_name {
                    return Some(Some(name.to_string()));
                }
            }
        } else if next == "{" {
            if let Some(local) = exported_from_braces(&tokens, index + 2, export_name) {
                return Some(Some(local));
            }
        }
        index += 1;
    }
    None
}

fn exported_from_braces(tokens: &[Token], mut index: usize, export_name: &str) -> Option<String> {
    while index < tokens.len() && tokens[index].text != "}" {
        if tokens[index].kind != TokenKind::Identifier || tokens[index].text == "type" {
            index += 1;
            continue;
        }
        let local = tokens[index].text.clone();
        let mut exported = local.clone();
        if tokens.get(index + 1).map(|token| token.text.as_str()) == Some("as") {
            exported = tokens.get(index + 2)?.text.clone();
        }
        if exported == export_name {
            return Some(local);
        }
        while index < tokens.len() && tokens[index].text != "," && tokens[index].text != "}" {
            index += 1;
        }
        if tokens.get(index).map(|token| token.text.as_str()) == Some(",") {
            index += 1;
        }
    }
    None
}

fn collect_import_bindings(source: &str) -> Vec<ImportBinding> {
    let tokens = lex(source);
    let mut bindings = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        if tokens[index].text != "import"
            || matches!(
                tokens.get(index + 1).map(|token| token.text.as_str()),
                Some("(") | Some(".")
            )
        {
            index += 1;
            continue;
        }
        let start = index + 1;
        let mut from_index = None;
        let mut cursor = start;
        while cursor < tokens.len() {
            if tokens[cursor].text == ";" {
                break;
            }
            if tokens[cursor].text == "from" {
                from_index = Some(cursor);
                break;
            }
            cursor += 1;
        }
        let Some(from_index) = from_index else {
            index = cursor.saturating_add(1);
            continue;
        };
        let Some(source_token) = tokens.get(from_index + 1) else {
            index = from_index + 1;
            continue;
        };
        if source_token.kind != TokenKind::String {
            index = from_index + 1;
            continue;
        }
        if tokens.get(start).map(|token| token.text.as_str()) == Some("type") {
            index = from_index + 2;
            continue;
        }
        parse_import_specifiers(
            &tokens[start..from_index],
            &source_token.text,
            &mut bindings,
        );
        index = from_index + 2;
    }
    bindings
}

fn parse_import_specifiers(tokens: &[Token], source: &str, bindings: &mut Vec<ImportBinding>) {
    let mut index = 0;
    if let Some(token) = tokens.get(index).and_then(identifier_text) {
        if token != "type" {
            bindings.push(ImportBinding {
                source: source.to_string(),
                imported: "default".to_string(),
                local: token.to_string(),
                namespace: false,
            });
        }
        index += 1;
        if tokens.get(index).map(|token| token.text.as_str()) == Some(",") {
            index += 1;
        }
    }
    while index < tokens.len() {
        match tokens[index].text.as_str() {
            "{" => {
                index += 1;
                while index < tokens.len() && tokens[index].text != "}" {
                    if tokens[index].text == "," || tokens[index].text == "type" {
                        index += 1;
                        continue;
                    }
                    let imported = tokens[index].text.clone();
                    if !is_identifier(&imported) {
                        index += 1;
                        continue;
                    }
                    let mut local = imported.clone();
                    if tokens.get(index + 1).map(|token| token.text.as_str()) == Some("as") {
                        if let Some(name) = tokens.get(index + 2).and_then(identifier_text) {
                            local = name.to_string();
                            index += 2;
                        }
                    }
                    bindings.push(ImportBinding {
                        source: source.to_string(),
                        imported,
                        local,
                        namespace: false,
                    });
                    index += 1;
                }
            }
            "*" if tokens.get(index + 1).map(|token| token.text.as_str()) == Some("as") => {
                if let Some(local) = tokens.get(index + 2).and_then(identifier_text) {
                    bindings.push(ImportBinding {
                        source: source.to_string(),
                        imported: "*".to_string(),
                        local: local.to_string(),
                        namespace: true,
                    });
                    index += 2;
                }
            }
            _ => {}
        }
        index += 1;
    }
}

fn resolve_import_path(from_file: &str, source: &str, files: &HashSet<String>) -> Option<String> {
    if !source.starts_with('.') {
        return None;
    }
    let mut parts: Vec<&str> = from_file.split('/').collect();
    parts.pop();
    let base = normalize_path(&format!("{}/{}", parts.join("/"), source));
    let mut candidates = vec![base.clone()];
    for extension in REACT_SOURCE_EXTENSIONS {
        candidates.push(format!("{base}{extension}"));
    }
    for extension in REACT_SOURCE_EXTENSIONS {
        candidates.push(format!("{base}/index{extension}"));
    }
    candidates
        .into_iter()
        .find(|candidate| files.contains(candidate))
}

fn count_jsx_openings(source: &str, aliases: &[String]) -> usize {
    let aliases: HashSet<&str> = aliases.iter().map(String::as_str).collect();
    let tokens = lex(source);
    let mut count = 0;
    for index in 0..tokens.len().saturating_sub(1) {
        if tokens[index].text != "<" || tokens[index + 1].kind != TokenKind::Identifier {
            continue;
        }
        let mut name = tokens[index + 1].text.clone();
        let mut cursor = index + 2;
        while tokens.get(cursor).map(|token| token.text.as_str()) == Some(".") {
            let Some(part) = tokens.get(cursor + 1).and_then(identifier_text) else {
                break;
            };
            name.push('.');
            name.push_str(part);
            cursor += 2;
        }
        if !aliases.contains(name.as_str())
            || !looks_like_jsx_context(tokens.get(index.wrapping_sub(1)))
        {
            continue;
        }
        count += 1;
    }
    count
}

fn looks_like_jsx_context(previous: Option<&Token>) -> bool {
    let Some(previous) = previous else {
        return true;
    };
    if previous.kind == TokenKind::Identifier {
        return matches!(previous.text.as_str(), "return" | "yield");
    }
    !matches!(previous.text.as_str(), ")" | "]" | "}" | ".")
}

fn lex(source: &str) -> Vec<Token> {
    let bytes = source.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte.is_ascii_whitespace() {
            index += 1;
            continue;
        }
        if byte == b'/' && bytes.get(index + 1) == Some(&b'/') {
            index += 2;
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
            continue;
        }
        if byte == b'/' && bytes.get(index + 1) == Some(&b'*') {
            index += 2;
            while index + 1 < bytes.len() && !(bytes[index] == b'*' && bytes[index + 1] == b'/') {
                index += 1;
            }
            index = (index + 2).min(bytes.len());
            continue;
        }
        if matches!(byte, b'\'' | b'"' | b'`') {
            let quote = byte;
            index += 1;
            let start = index;
            while index < bytes.len() {
                if bytes[index] == b'\\' {
                    index = (index + 2).min(bytes.len());
                    continue;
                }
                if bytes[index] == quote {
                    break;
                }
                index += 1;
            }
            let text = String::from_utf8_lossy(&bytes[start..index]).into_owned();
            tokens.push(Token {
                kind: TokenKind::String,
                text,
            });
            index = (index + 1).min(bytes.len());
            continue;
        }
        if is_identifier_start(byte) {
            let start = index;
            index += 1;
            while index < bytes.len() && is_identifier_continue(bytes[index]) {
                index += 1;
            }
            tokens.push(Token {
                kind: TokenKind::Identifier,
                text: String::from_utf8_lossy(&bytes[start..index]).into_owned(),
            });
            continue;
        }
        if byte.is_ascii_digit() {
            let start = index;
            index += 1;
            while index < bytes.len() && bytes[index].is_ascii_digit() {
                index += 1;
            }
            tokens.push(Token {
                kind: TokenKind::Number,
                text: String::from_utf8_lossy(&bytes[start..index]).into_owned(),
            });
            continue;
        }
        let text = (byte as char).to_string();
        tokens.push(Token {
            kind: TokenKind::Punctuation,
            text,
        });
        index += 1;
    }
    tokens
}

fn identifier_text(token: &Token) -> Option<&str> {
    (token.kind == TokenKind::Identifier).then_some(token.text.as_str())
}

fn is_identifier_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || byte == b'_' || byte == b'$'
}

fn is_identifier_continue(byte: u8) -> bool {
    is_identifier_start(byte) || byte.is_ascii_digit()
}

fn is_identifier(value: &str) -> bool {
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    is_identifier_start(first) && bytes.all(is_identifier_continue)
}

fn normalize_path(path: &str) -> String {
    let mut parts = Vec::new();
    let normalized = path.replace('\\', "/");
    for part in normalized.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            value => parts.push(value),
        }
    }
    if parts.is_empty() {
        ".".to_string()
    } else {
        parts.join("/")
    }
}

fn validation(field: impl Into<String>, reason: impl Into<String>) -> CommandError {
    CommandError::Validation {
        field: field.into(),
        reason: reason.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::components::types::content_hash;

    fn file(file: &str, content: &str) -> SourceFileSnapshot {
        SourceFileSnapshot {
            file: file.to_string(),
            content: content.to_string(),
            content_hash: content_hash(content.as_bytes()),
        }
    }

    fn delta(component_id: &str, before: usize, after: usize) -> ComponentGraphDelta {
        ComponentGraphDelta {
            component_id: component_id.to_string(),
            usages_before: before,
            usages_after: after,
            delta: after as i64 - before as i64,
            created_component_id: None,
            removed_component_id: None,
            created_usages: None,
        }
    }

    #[test]
    fn counts_direct_and_aliased_imports() {
        let before = vec![
            file(
                "src/Button.tsx",
                "export function Button() { return <button />; }",
            ),
            file(
                "src/Page.tsx",
                "import { Button as Primary } from './Button'; export function Page() { return <Primary />; }",
            ),
        ];
        let after = vec![
            before[0].clone(),
            file(
                "src/Page.tsx",
                "import { Button as Primary } from './Button'; export function Page() { return <><Primary /><Primary /></>; }",
            ),
        ];
        validate_expected_graph_delta(&before, &after, &delta("react:src/Button.tsx#Button", 1, 2))
            .unwrap();
    }

    #[test]
    fn rejects_a_graph_delta_that_does_not_match_source() {
        let files = vec![
            file(
                "src/Card.tsx",
                "export default function Card() { return <article />; }",
            ),
            file(
                "src/Page.tsx",
                "import Card from './Card'; export function Page() { return <Card />; }",
            ),
        ];
        let error = validate_expected_graph_delta(
            &files,
            &files,
            &delta("react:src/Card.tsx#default", 0, 0),
        )
        .unwrap_err();
        assert!(error.to_string().contains("expected 0 usages before"));
    }

    #[test]
    fn counts_native_astro_component_tags_from_frontmatter_imports() {
        let before = vec![
            file(
                "src/components/Hero.astro",
                "---\ninterface Props { title: string }\n---\n<section>{title}</section>",
            ),
            file(
                "src/pages/index.astro",
                "---\nimport Hero from '../components/Hero.astro';\n---\n<main><Hero title=\"One\" /></main>",
            ),
        ];
        let after = vec![
            before[0].clone(),
            file(
                "src/pages/index.astro",
                "---\nimport Hero from '../components/Hero.astro';\n---\n<main><Hero title=\"One\" /><Hero title=\"Two\" /></main>",
            ),
        ];

        validate_expected_graph_delta(
            &before,
            &after,
            &delta("astro:src/components/Hero.astro#default", 1, 2),
        )
        .unwrap();
    }

    #[test]
    fn astro_graph_guard_ignores_frontmatter_and_non_component_markup() {
        let files = vec![
            file("src/components/Card.astro", "---\n---\n<article />"),
            file(
                "src/pages/index.astro",
                "---\nimport Card from '../components/Card.astro';\nconst markup = '<Card />';\n---\n<Card /><div><card /></div><Card />",
            ),
        ];
        validate_expected_graph_delta(
            &files,
            &files,
            &delta("astro:src/components/Card.astro#default", 2, 2),
        )
        .unwrap();
    }

    #[test]
    fn accepts_the_astro_protocol_and_rejects_mixed_identity_dialects() {
        let astro_plan = ComponentMutationPlan {
            files: Vec::new(),
            expected_revision: "revision".to_string(),
            dialect: Some("astro".to_string()),
            parser_token: Some(ASTRO_COMPONENT_PLAN_PARSER_TOKEN.to_string()),
            expected_graph_delta: Some(delta("astro:src/Card.astro#default", 0, 0)),
            operations: None,
        };
        assert!(validate_plan_protocol(&astro_plan).is_ok());

        let mixed_plan = ComponentMutationPlan {
            expected_graph_delta: Some(delta("react:src/Card.tsx#default", 0, 0)),
            ..astro_plan
        };
        let error = validate_plan_protocol(&mixed_plan).unwrap_err();
        assert!(error.to_string().contains("dialect"));
    }

    #[test]
    fn accepts_the_react_native_source_only_protocol_and_counts_jsx_usages() {
        let files = vec![
            file(
                "src/Button.tsx",
                "export function Button() { return <View />; }",
            ),
            file(
                "src/App.tsx",
                "import { Button } from './Button'; export function App() { return <Button />; }",
            ),
        ];
        let plan = ComponentMutationPlan {
            files: Vec::new(),
            expected_revision: "revision".to_string(),
            dialect: Some("react-native".to_string()),
            parser_token: Some(REACT_NATIVE_COMPONENT_PLAN_PARSER_TOKEN.to_string()),
            expected_graph_delta: Some(delta("react-native:src/Button.tsx#Button", 1, 1)),
            operations: None,
        };
        assert!(validate_plan_protocol(&plan).is_ok());
        validate_expected_graph_delta(
            &files,
            &files,
            &delta("react-native:src/Button.tsx#Button", 1, 1),
        )
        .unwrap();
    }

    #[test]
    fn refuses_partial_protocol_metadata() {
        let plan = ComponentMutationPlan {
            files: Vec::new(),
            expected_revision: "revision".to_string(),
            dialect: Some("react".to_string()),
            parser_token: None,
            expected_graph_delta: None,
            operations: None,
        };
        let error = validate_plan_protocol(&plan).unwrap_err();
        assert!(error.to_string().contains("parserToken"));
    }
}
