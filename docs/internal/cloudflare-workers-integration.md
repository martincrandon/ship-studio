# Cloudflare Workers hosting integration

Ship Studio connects a repository to an existing Cloudflare project and observes
what happened after a push. It does not create Workers, change build commands,
or migrate a Pages application's code.

## Product and identity

Cloudflare recommends Workers for new applications, including static sites and
full-stack applications. Pages remains supported. They share a dashboard but
retain separate APIs. The picker therefore offers both products explicitly.

The saved `hosting.links` entry keeps `provider: "cloudflare"`, `scope_id` (the
account), and `project_id` (the Pages project or Worker script name). It also
stores `cloudflare_target`:

```json
{"kind":"pages"}
```

```json
{"kind":"workers","script_tag":"immutable-worker-tag-returned-by-cloudflare"}
```

An absent target is Pages, preserving old metadata without guessing from a
project name or Wrangler file. Workers script names identify the Scripts API;
the immutable script tag identifies the Builds API. Same-named projects on the
two products remain distinct. Only one Cloudflare link is saved per repository,
as with the existing provider model.

## Authentication

The same workspace keychain credential is used for both products. Selecting a
product requests only that product's project list, so a Pages token does not
need Workers access and a Workers token does not need Pages access.

- Account enumeration: Account Settings Read.
- Pages projects and deployments: Cloudflare Pages Read.
- Worker enumeration and active deployments: Workers Scripts Read.
- Workers build history and logs: Workers CI Read, the permission accepted by
  the read endpoint documentation (Workers CI Write is also accepted).

Workers Builds requires a **user-scoped** API token. Cloudflare's general Builds
guide lists Workers Builds Configuration Edit for managing triggers; Ship
Studio only reads history and does not request that mutation permission.

## Deployment truth

Worker build history carries a full SHA and branch in
`build_trigger_metadata`. Both must match the pushed commit. A build's outcome
(`success`, `fail`, `skipped`, `cancelled`, `terminated`) is separate from its
running status (`queued`, `initializing`, `running`, `stopped`). Unknown or
missing values must not become success.

A successful build alone does not prove production traffic reached the commit:
custom deploy commands and version uploads can finish without promotion. To
establish production, the adapter reads the current script deployment, takes
its versions receiving traffic, and uses Builds' `version_ids` lookup to prove
which build produced them. Gradual deployments can have multiple active
versions. An API-returned build preview URL can establish a preview artifact.
Without either proof, a successful build has an unknown deployment phase and
environment rather than a claim that it went live.

Only returned preview URLs and custom domain hostnames become addresses. A
`workers.dev` address is never assembled from the script name and account
subdomain, and a trigger name or a branch named `main` never decides environment.

Workers deployed only through external CI or Wrangler may have no Workers
Builds record. Those projects are selectable, but a push without a matching
record remains “not found”, never a failure or the status of another commit.

## Bounded requests

Commit lookup scans the newest two pages of 100 Worker builds (200 total). An
older commit can therefore be absent from this window and remains “not found”.
Recent history is capped to the same window. Account discovery is bounded to
100 pages of 50 accounts; the Scripts API has no documented pagination. These
bounds prevent one status request from consuming unlimited API calls.

Build logs fetch one page and report `truncated` when Cloudflare supplies a
continuation cursor or truncation flag. They never claim to be a complete log
when another page is available. Active-version evidence and custom domains are
shared across a recent-history request, rather than fetched again for each row.
Workers status caching stays short even after success so a later promotion or
rollback can update the serving claim.

## Verification provenance

The Workers adapter is based on the official API schemas, with fixtures covering
identity, commit matching, lifecycle, promotion evidence, URLs, and logs. These
fixtures are not a live-account observation. Pages' existing live verification
is recorded in [hosting-provider-matrix.md](hosting-provider-matrix.md).

Before upstream acceptance, a maintainer can verify with a user-scoped token:
select a Worker using Git-connected Builds, push to its production branch and a
preview branch, deliberately fail a build, and check that the matching SHA,
status, log, and returned address agree with Cloudflare's dashboard. A Pages
link saved before this change should continue to work unchanged.

## Primary sources

- [Cloudflare's product direction](https://blog.cloudflare.com/full-stack-development-on-cloudflare-workers/)
- [Pages to Workers migration](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/)
- [Workers Builds API guide](https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/)
- [Worker script list](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/list/)
- [Build history](https://developers.cloudflare.com/api/resources/workers_builds/subresources/builds/methods/list/)
- [Build logs](https://developers.cloudflare.com/api/resources/workers_builds/subresources/builds/subresources/logs/methods/get/)
- [Builds by version](https://developers.cloudflare.com/api/resources/workers_builds/methods/get_builds_by_version/)
- [Worker deployments](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/)
- [Worker domains](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/list/)
