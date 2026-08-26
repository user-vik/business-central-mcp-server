# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `set_item_attribute` write-tier tool — sets an item attribute (e.g. "Group
  Name" → "Roll") without the caller needing to know the underlying data model.
  Resolves the attribute name and target value against the live definitions
  (exact match first, then case-insensitive; ambiguity and unknown values are
  errors — the tool never creates new dropdown options), verifies the item
  exists where the route allows it, then updates or creates the Item Attribute
  Value Mapping row through a two-step `dry_run` → `confirm_token` → apply flow
  with `If-Match` concurrency, re-reading the row afterwards to verify.
  Requires a custom AL API route that publishes `itemAttributes`,
  `itemAttributeValues`, and `itemAttributeValueMappings` (the standard v2.0
  API exposes none of them) via `api_route` or the new `BC_ITEM_ATTR_API_ROUTE`
  environment variable. Option-type attributes only.
- Claude Desktop bundle (`.mcpb`). `npm run build:mcpb` produces a single-file,
  cross-platform installer that carries the server and its production
  dependencies; Desktop supplies the Node runtime, so installing needs no
  clone, no npm, and no Node. Configuration is collected through the install
  dialog rather than an `env` block.
- `npm run verify:mcpb` — unpacks the packed bundle and boots the server out of
  the archive using the MCPB toolkit's own config substitution, the same one
  Desktop performs. Covers interactive sign-in with every optional field left
  blank, write mode with deletion, service-principal sign-in, and the refusal
  to launch with no tenant.
- Interactive sign-in now names the client id it will use on stderr, and says
  when it is the public Azure CLI client. The tool surface alone could not
  distinguish the fallback from a literal placeholder, because `tools/list`
  never requests a token.
- Release workflow: a `v*` tag builds, verifies, and attaches the `.mcpb` to a
  GitHub release, after checking the tag agrees with `package.json`.
- `npm test` — a stdio smoke test that spawns the real entry point, completes
  the MCP handshake, and asserts the exact tool surface for read mode, write
  mode, delete opt-in, delete opt-in without write mode, and a run where every
  optional value arrives as an unsubstituted placeholder.
- `npm run check` — parses `index.js` as ESM. A bare `node --check` on a copy
  of the file outside this package parses it as CommonJS, where a top-level
  `return` is legal, and reports nothing.
- CI running the parse check, lint, format check, smoke tests, and a full
  bundle build and verify on Node 20 and 22 across Linux and Windows, on every
  pull request.

### Fixed

- Restored the `encodeNavPath` function declaration. An automated comment
  rewrite in a43759b replaced the two lines above the function body and took
  the `function encodeNavPath(navPath) {` line with them, leaving a top-level
  `return`. `index.js` then failed to parse as ESM, so the server could not
  start at all. Present on `main` from 83cbc0e onward; no tagged release is
  affected.
- Blank and unsubstituted `${user_config.<key>}` entries are now deleted from
  `process.env` at startup rather than filtered at each read site. Guarding
  this module's reads was not enough: `@azure/identity` reads
  `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_CLIENT_SECRET` directly from
  the environment in `EnvironmentCredential`, which `DefaultAzureCredential`
  (`BC_AUTH_MODE=default`) chains into, so three surviving placeholders looked
  like a complete service principal and it would attempt a client-secret flow
  with literal `${...}` strings. Discarded names are reported on stderr.
- `BC_MCP_MODE` now refuses to start on an unrecognised value instead of
  quietly falling back to read mode, matching how `BC_AUTH_MODE` already
  behaved. The value arrives as free text from the install dialog, since the
  manifest schema has no enum for string fields, and a typo previously left the
  user hunting for tools that were never registered.
- `export_dir` no longer declares a `${DOCUMENTS}` default. System directories
  are not expanded inside a `user_config` value, and `required` is validated
  against the raw user config rather than merged defaults, so accepting a
  prefilled literal would have satisfied the check and sent `${DOCUMENTS}` to
  the server, which then fell back to the client's working directory.
- Unset environment variables that arrive as an unsubstituted
  `${user_config.<key>}` are now treated as unset rather than as a literal
  value. MCPB clients pass the placeholder through verbatim when an optional
  field is blank and the manifest declares no default for it. The literal is
  truthy, so `AZURE_CLIENT_ID` in particular would defeat the Azure CLI
  client-id fallback and interactive sign-in would fail against Entra with an
  error that named nothing useful. All environment reads now go through one
  guard that rejects blank and placeholder values.

### Changed

- `package-lock.json` version synced to 1.1.0; it was still at 1.0.0.

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
