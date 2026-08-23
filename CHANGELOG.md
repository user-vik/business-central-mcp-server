# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-08-18

### Added

- `export_file` write-tier tool — downloads Business Central media streams (posted
  invoice PDFs, attachment content, item pictures) to a local file. Returns the
  path, byte count, content type, and SHA-256 instead of the bytes, keeping
  large documents out of the model's context. Guards: `max_bytes` ceiling
  (64 MiB default, checked against Content-Length and again after transfer),
  refusal to overwrite an existing file unless `overwrite: true`, and filename
  sanitisation so a server-supplied name cannot escape the target directory.
  BC itself is only read, but the tool writes to the local filesystem, so it
  registers under `BC_MCP_MODE=write` and is audit-logged like the other
  write tools.
- `sub_path` on `get_entity` — reads nested navigation properties such as
  `pdfDocument`. Previously any path containing `/` was percent-encoded into a
  single segment and returned 404.
- `BC_EXPORT_DIR` environment variable — default destination for `export_file`.
- Filename resolution for exports: the record's own `fileName` (attachments and
  document attachments carry it) is preferred over a derived name, and OOXML
  zip containers are inspected so a spreadsheet saves as `.xlsx` rather than
  `.zip`. Format-agnostic — PDFs, Office files, and images all round-trip.

### Changed

- The HTTP layer is split into `bcFetch` (retry/auth) plus `bcApi` (JSON) and
  `bcApiBinary` (buffered bytes). Previously every response was forced through
  `JSON.parse` with `Accept: application/json`, which made binary retrieval
  impossible.

## [1.0.0] - 2026-07-21

### Added

- Initial release.
- Read tools: `list_environments`, `list_companies`, `list_entity_sets`,
  `query_entities` (OData $filter/$select/$orderby/$expand + nextLink paging),
  `get_entity`.
- Write tools (`BC_MCP_MODE=write`): `create_entity`, `update_entity` (with
  automatic If-Match etag handling), `invoke_bound_action` (Microsoft.NAV.*
  bound actions like post/ship/cancel), each audit-logged to stderr.
- Destructive tool (`BC_MCP_MODE=write` + `BC_MCP_ALLOW_DELETE=true`):
  `delete_entity`, with a two-step dry_run/confirm_token plan-apply flow and
  If-Match optimistic concurrency.
- Custom AL API support on every entity tool via
  `api_route: "{publisher}/{group}/{version}"`.
- Seven `@azure/identity` auth modes (interactive, device-code, cli,
  azure-powershell, service-principal, managed-identity, default) against the
  `api.businesscentral.dynamics.com` scope.
- HTTP 429/503 retry with Retry-After backoff; large query results truncated
  to protect the model's context window.
