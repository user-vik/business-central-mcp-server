# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
