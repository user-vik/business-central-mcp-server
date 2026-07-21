# business-central-mcp-server

An [MCP](https://modelcontextprotocol.io) server that exposes Dynamics 365
Business Central (online) data to an MCP client (Claude Code, Claude Desktop,
etc.) — environments, companies, and any entity reachable through the standard
v2.0 API or a custom AL API.

It talks to `api.businesscentral.dynamics.com` using an Entra token for that
same audience. With **delegated** auth (interactive / cli / azure-powershell)
it needs **no app registration and no admin consent** — it operates as the
signed-in user, constrained by that user's Business Central permission sets.

## Tools

### Read (always on)

| Tool                | Purpose                                                                           |
| ------------------- | --------------------------------------------------------------------------------- |
| `list_environments` | List BC environments (production + sandboxes) in the tenant.                      |
| `list_companies`    | List companies (legal entities) in an environment; ids feed the entity tools.     |
| `list_entity_sets`  | List the entity sets on an API route (customers, items, salesInvoices, ...).      |
| `query_entities`    | OData query over an entity set — `$filter`/`$select`/`$orderby`/`$expand`, paged. |
| `get_entity`        | Single record by id (GUID), including its `@odata.etag`.                          |

Custom APIs published from AL extensions are reachable everywhere via
`api_route: "{publisher}/{group}/{version}"`.

### Write (`BC_MCP_MODE=write`)

| Tool                  | Purpose                                                                  |
| --------------------- | ------------------------------------------------------------------------ |
| `create_entity`       | Insert a record (customer, item, sales order, ...).                      |
| `update_entity`       | PATCH fields on a record, `If-Match` etag concurrency handled for you.   |
| `invoke_bound_action` | Call a bound action — `post`, `ship`, `cancel`, ... (`Microsoft.NAV.*`). |

Every write call is audit-logged to stderr with timestamp, tool, target, and
caller identity. **These mutate real ERP data** — posting a document creates
ledger entries that cannot simply be deleted. Point `BC_DEFAULT_ENVIRONMENT`
at a sandbox while experimenting.

### Destructive (`BC_MCP_MODE=write` **and** `BC_MCP_ALLOW_DELETE=true`)

| Tool            | Purpose                                                                |
| --------------- | ---------------------------------------------------------------------- |
| `delete_entity` | Permanently delete a record. Two-step dry_run → confirm_token → apply. |

The destructive tier is off by default. When enabled, each call is a plan
first: `dry_run=true` (the default) returns the record that would be removed
plus a single-use `confirm_token`; only a second call with `dry_run=false` and
that token performs the delete, guarded by an `If-Match` etag.

## Setup

```bash
cd business-central-mcp-server
npm install
```

Register it with your MCP client. Example `.claude.json` entry (delegated auth,
read-only):

```json
{
  "mcpServers": {
    "business-central": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/business-central-mcp-server/index.js"],
      "env": {
        "AZURE_TENANT_ID": "<your-entra-tenant-id>",
        "BC_AUTH_MODE": "interactive",
        "BC_MCP_MODE": "read",
        "BC_DEFAULT_ENVIRONMENT": "Production"
      }
    }
  }
}
```

To allow creating/updating records and invoking bound actions, set
`"BC_MCP_MODE": "write"`. To also allow deletion, add
`"BC_MCP_ALLOW_DELETE": "true"`.

Set `BC_DEFAULT_COMPANY_ID` to a value from `list_companies` if you work in a
single company and want to omit `company_id` on every call.

See [`.env.example`](.env.example) for the full list of environment variables,
including all supported auth modes.

## Auth notes

- **Delegated (recommended):** `interactive`, `device-code`, `cli`, or
  `azure-powershell`. No app registration needed; the caller acts as the
  signed-in user, limited by that user's BC permission sets and company access.
- **Service principal:** non-interactive, but the SP must be registered as an
  Entra application **inside Business Central** (Entra Applications page, with
  permission sets assigned) before the data plane will accept it.
- `list_environments` uses the admin-center discovery API, which additionally
  requires BC admin-center access. The other tools work without it if you pass
  environment names directly.

## Requirements

- Node.js >= 20
- An Entra identity licensed for Business Central in the target tenant.

## License

MIT — see [LICENSE](LICENSE).
