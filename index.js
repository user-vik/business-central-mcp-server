#!/usr/bin/env node
import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  AzureCliCredential,
  AzurePowerShellCredential,
  ClientSecretCredential,
  DefaultAzureCredential,
  DeviceCodeCredential,
  InteractiveBrowserCredential,
  ManagedIdentityCredential,
} from "@azure/identity";
import { z } from "zod";

// Single source of truth for the server's version — keeps `package.json`
// and the MCP server identity in sync without manual edits.
const PACKAGE = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const VERSION = PACKAGE.version;

const AUTH_MODES = [
  "interactive",
  "device-code",
  "cli",
  "azure-powershell",
  "service-principal",
  "managed-identity",
  "default",
];
// Public Azure CLI client ID — safe default for user-flow modes only.
const AZURE_CLI_CLIENT_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46";

// An MCPB client builds the child environment by string-replacing
// `${user_config.<key>}` in the manifest. An optional field the user left
// blank only resolves when the manifest declares a `default` for it, and
// otherwise the literal placeholder is passed through verbatim.
const PLACEHOLDER = /^\$\{[^}]*\}$/;

// Deletes blank and unsubstituted BC_*/AZURE_* entries from the environment
// before anything reads them.
//
// Guarding this module's own reads is not enough: @azure/identity reads
// AZURE_TENANT_ID, AZURE_CLIENT_ID, and AZURE_CLIENT_SECRET straight off
// process.env in EnvironmentCredential, which DefaultAzureCredential
// (BC_AUTH_MODE=default) chains into. Three surviving placeholders look like a
// complete service principal to it, and it would attempt a client-secret flow
// with literal `${...}` strings. Scrubbing the environment once, rather than
// filtering at each read site, closes that for every consumer in the process.
function sanitizeEnvironment() {
  const discarded = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(?:BC_|AZURE_)/.test(key)) continue;
    const trimmed = (value ?? "").trim();
    if (!trimmed) {
      delete process.env[key];
    } else if (PLACEHOLDER.test(trimmed)) {
      delete process.env[key];
      discarded.push(key);
    }
  }
  if (discarded.length > 0) {
    // Worth saying out loud: it means a manifest is missing a default, and the
    // symptom otherwise shows up much later as a confusing auth failure.
    console.error(
      `[bc-mcp] ignoring unsubstituted configuration: ${discarded.join(", ")}. ` +
        "Treating these as unset.",
    );
  }
}

sanitizeEnvironment();

// Reads an environment variable, treating blank as unset. Placeholders are
// already gone by the time anything calls this.
function env(name) {
  const value = process.env[name];
  if (!value) return undefined;
  return value.trim() || undefined;
}

function requireEnv(value, name, mode) {
  if (!value) {
    console.error(`BC_AUTH_MODE=${mode} requires ${name}`);
    process.exit(1);
  }
  return value;
}

function buildCredential() {
  const mode = (env("BC_AUTH_MODE") || "interactive").toLowerCase();
  if (!AUTH_MODES.includes(mode)) {
    console.error(`Invalid BC_AUTH_MODE "${mode}". Valid: ${AUTH_MODES.join(", ")}`);
    process.exit(1);
  }
  const tenantId = env("AZURE_TENANT_ID");
  const clientId = env("AZURE_CLIENT_ID");
  const clientSecret = env("AZURE_CLIENT_SECRET");

  switch (mode) {
    case "interactive": {
      const effectiveClientId = clientId || AZURE_CLI_CLIENT_ID;
      console.error(
        `[bc-mcp] interactive sign-in as client ${effectiveClientId}` +
          (clientId ? "" : " (public Azure CLI client)"),
      );
      return new InteractiveBrowserCredential({
        tenantId: requireEnv(tenantId, "AZURE_TENANT_ID", mode),
        clientId: effectiveClientId,
      });
    }
    case "device-code":
      return new DeviceCodeCredential({
        tenantId: requireEnv(tenantId, "AZURE_TENANT_ID", mode),
        clientId: clientId || AZURE_CLI_CLIENT_ID,
        // Default callback writes to stdout, which would corrupt the MCP
        // protocol stream. Redirect to stderr so the MCP client logs it.
        userPromptCallback: (info) => {
          console.error(`[bc-mcp] ${info.message}`);
        },
      });
    case "cli":
      return new AzureCliCredential(tenantId ? { tenantId } : undefined);
    case "azure-powershell":
      return new AzurePowerShellCredential(tenantId ? { tenantId } : undefined);
    case "service-principal":
      return new ClientSecretCredential(
        requireEnv(tenantId, "AZURE_TENANT_ID", mode),
        requireEnv(clientId, "AZURE_CLIENT_ID", mode),
        requireEnv(clientSecret, "AZURE_CLIENT_SECRET", mode),
      );
    case "managed-identity":
      return new ManagedIdentityCredential(clientId ? { clientId } : undefined);
    case "default":
      return new DefaultAzureCredential(tenantId ? { tenantId } : undefined);
  }
}

const credential = buildCredential();

// Business Central Online. One host serves everything: the environment
// discovery API at /environments/v1.1 and the per-environment data plane at
// /v2.0/{environment}/api/{route}/... . Token audience is the same host.
const SCOPE = env("BC_SCOPE") || "https://api.businesscentral.dynamics.com/.default";
const BC_BASE = env("BC_API_BASE") || "https://api.businesscentral.dynamics.com";
const DEFAULT_ENVIRONMENT = env("BC_DEFAULT_ENVIRONMENT") || null;
const DEFAULT_COMPANY_ID = env("BC_DEFAULT_COMPANY_ID") || null;
const MAX_RETRIES = 3;
const RETRY_MAX_DELAY_MS = 60_000;
// Ceiling for export_file downloads. BC attachments are user-uploaded and
// unbounded; buffering one blindly would sit in memory for the session.
const MAX_EXPORT_BYTES = 64 * 1024 * 1024;

async function getToken() {
  const t = await credential.getToken(SCOPE);
  return t.token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Performs the HTTP call and returns the raw Response, retrying on 429/503 and
// honoring Retry-After. Callers decide how to read the body — bcApi parses
// JSON, bcApiBinary buffers bytes. `accept` is overridable because BC media
// streams will not negotiate application/json.
async function bcFetch(
  method,
  path,
  { body, extraQuery = {}, extraHeaders = {}, accept = "application/json" } = {},
) {
  const token = await getToken();
  const url = new URL(`${BC_BASE}${path}`);
  for (const [k, v] of Object.entries(extraQuery)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: accept,
        ...extraHeaders,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
      const retryAfter = parseInt(res.headers.get("retry-after") ?? "", 10);
      const backoffMs = Number.isFinite(retryAfter)
        ? Math.min(retryAfter * 1000, RETRY_MAX_DELAY_MS)
        : Math.min(2 ** attempt * 500, RETRY_MAX_DELAY_MS);
      console.error(
        `[bc-mcp] ${res.status} throttled on ${method} ${path}; retrying in ${backoffMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
      );
      await sleep(backoffMs);
      continue;
    }
    return res;
  }
}

// Calls a path relative to BC_BASE (e.g. "/v2.0/Production/api/v2.0/companies")
// and parses the JSON body. `extraQuery` adds query parameters ($filter,
// $top, ...). `extraHeaders` adds request headers (If-Match for OData
// optimistic concurrency on PATCH/DELETE).
async function bcApi(method, path, body, extraQuery = {}, extraHeaders = {}) {
  const res = await bcFetch(method, path, { body, extraQuery, extraHeaders });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`BusinessCentral ${method} ${path} -> ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

// GETs a binary media stream (invoice PDFs, attachment content, pictures) and
// buffers it. BC serves these as application/octet-stream, so the body must
// never reach JSON.parse. Enforces `maxBytes` against the declared
// Content-Length first, then against what actually arrived — a chunked
// response has no length to check up front.
async function bcApiBinary(path, extraQuery = {}, maxBytes = MAX_EXPORT_BYTES) {
  const res = await bcFetch("GET", path, { extraQuery, accept: "*/*" });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`BusinessCentral GET ${path} -> ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(
      `Refusing to download ${declared} bytes; exceeds max_bytes=${maxBytes}. Raise max_bytes if this is expected.`,
    );
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > maxBytes) {
    throw new Error(
      `Downloaded ${buffer.length} bytes; exceeds max_bytes=${maxBytes}. Raise max_bytes if this is expected.`,
    );
  }
  return {
    buffer,
    contentType: res.headers.get("content-type") ?? "application/octet-stream",
    contentDisposition: res.headers.get("content-disposition") ?? null,
  };
}

// Resolve the target environment for a call, falling back to the configured
// default. Environment names come from list_environments (e.g. "Production").
function resolveEnv(environment) {
  const env = environment || DEFAULT_ENVIRONMENT;
  if (!env) {
    throw new Error(
      "No environment specified and BC_DEFAULT_ENVIRONMENT is not set. Call list_environments to discover valid names, then pass `environment`.",
    );
  }
  return env;
}

// Resolve the target company, falling back to the configured default.
// Company ids are GUIDs from list_companies.
function resolveCompany(company_id) {
  const id = company_id || DEFAULT_COMPANY_ID;
  if (!id) {
    throw new Error(
      "No company_id specified and BC_DEFAULT_COMPANY_ID is not set. Call list_companies to discover company ids, then pass `company_id`.",
    );
  }
  return id;
}

// The API route under /api/. Default is Microsoft's standard "v2.0"; custom
// APIs published from AL extensions live at "{publisher}/{group}/{version}".
const CUSTOM_ROUTE_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/v[0-9.]+$/;
function resolveRoute(api_route) {
  if (!api_route || api_route === "v2.0") return "v2.0";
  if (!CUSTOM_ROUTE_RE.test(api_route)) {
    throw new Error(
      `Invalid api_route "${api_route}". Expected "v2.0" or "{publisher}/{group}/{version}" (e.g. "contoso/sales/v1.0").`,
    );
  }
  return api_route;
}

// Build the environment-scoped data-plane path prefix.
function dataPath(env, route, suffix = "") {
  return `/v2.0/${encodeURIComponent(env)}/api/${route}${suffix}`;
}

// Build a company-scoped path. Company ids are GUIDs so encodeURIComponent is
// belt-and-suspenders.
function companyPath(env, route, companyId, suffix = "") {
  return dataPath(env, route, `/companies(${encodeURIComponent(companyId)})${suffix}`);
}

// Entity record path. Record ids in the standard v2.0 API are GUIDs; composite
// or string keys should be located via query_entities + $filter instead.
function entityPath(env, route, companyId, entitySet, recordId) {
  return companyPath(
    env,
    route,
    companyId,
    `/${encodeURIComponent(entitySet)}(${encodeURIComponent(recordId)})`,
  );
}

// Encode a navigation path while preserving its separators. Values like
// "pdfDocument/pdfDocumentContent" are multi-segment; running
// encodeURIComponent over the whole string turns "/" into %2F and BC 404s.
// Each segment is encoded independently so BC can decode key predicates (e.g.
// "attachments(<id>)") correctly.
function encodeNavPath(navPath) {
  return String(navPath)
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

// BC labels most media as application/octet-stream regardless of the real
// format, so the extension is sniffed from magic bytes first and only falls
// back to the declared content type.
const MAGIC_EXTENSIONS = [
  { ext: ".pdf", bytes: [0x25, 0x50, 0x44, 0x46] },
  { ext: ".png", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { ext: ".jpg", bytes: [0xff, 0xd8, 0xff] },
  { ext: ".gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  // Also matches .xlsx/.docx — both are zip containers.
  { ext: ".zip", bytes: [0x50, 0x4b, 0x03, 0x04] },
];

const CONTENT_TYPE_EXTENSIONS = {
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "text/csv": ".csv",
  "text/plain": ".txt",
  "application/json": ".json",
  "application/xml": ".xml",
  "text/xml": ".xml",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/vnd.ms-excel": ".xls",
  "application/msword": ".doc",
};

// OOXML files are zip containers, so magic bytes alone report ".zip". The part
// tree is named in the local file headers, and a scan of the first few KiB is
// enough to tell a spreadsheet from a document from an actual archive.
function sniffOoxml(buffer) {
  const head = buffer.subarray(0, 4096).toString("latin1");
  if (head.includes("xl/")) return ".xlsx";
  if (head.includes("word/")) return ".docx";
  if (head.includes("ppt/")) return ".pptx";
  return ".zip";
}

function sniffExtension(buffer, contentType) {
  // A specific declared type beats magic bytes. BC almost always declares
  // application/octet-stream, in which case this falls through to sniffing.
  const base = (contentType || "").split(";")[0].trim().toLowerCase();
  if (CONTENT_TYPE_EXTENSIONS[base]) return CONTENT_TYPE_EXTENSIONS[base];
  for (const { ext, bytes } of MAGIC_EXTENSIONS) {
    if (buffer.length >= bytes.length && bytes.every((b, i) => buffer[i] === b)) {
      return ext === ".zip" ? sniffOoxml(buffer) : ext;
    }
  }
  return ".bin";
}

// Strip path separators and characters Windows rejects. Exports frequently
// land in a OneDrive-synced folder, and a BC-supplied filename is untrusted
// input — it must never escape the destination directory.
function safeFileName(name) {
  const cleaned = String(name)
    // Stripping control characters is the point — they are illegal in filenames.
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  return cleaned || "export";
}

function filenameFromDisposition(disposition) {
  if (!disposition) return null;
  const encoded = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(disposition);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1].trim().replace(/^"|"$/g, ""));
    } catch {
      // Malformed RFC 5987 value — fall through to the plain form.
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  return plain ? plain[1].trim() : null;
}

// Media entities (attachments, documentAttachments) keep the original upload
// name in `fileName`, while the stream itself arrives as octet-stream with no
// Content-Disposition. Without this an .xlsx would be saved as .zip, since a
// spreadsheet is just a zip container. Entities with no such field — the
// pdfDocument case — return null and fall back to a derived name.
async function lookupRecordFileName(env, route, companyId, entitySet, recordId) {
  try {
    const record = await bcApi(
      "GET",
      entityPath(env, route, companyId, entitySet, recordId),
      undefined,
      { $select: "fileName" },
    );
    const name = record?.fileName;
    return typeof name === "string" && name.trim() ? name : null;
  } catch {
    return null;
  }
}

// Decide where an export lands. An existing directory or a trailing separator
// means "put it in here"; anything else is taken as the literal filename.
function resolveExportTarget({
  output_path,
  entity_set,
  record_id,
  sub_path,
  buffer,
  contentType,
  suggested,
}) {
  const leaf = String(sub_path).split("/").filter(Boolean).pop() ?? "content";
  const name = suggested
    ? safeFileName(suggested)
    : `${safeFileName(entity_set)}_${safeFileName(record_id)}_${safeFileName(leaf)}${sniffExtension(buffer, contentType)}`;
  if (!output_path) {
    return resolve(env("BC_EXPORT_DIR") || process.cwd(), name);
  }
  const candidate = resolve(output_path);
  const isDirectory =
    (existsSync(candidate) && statSync(candidate).isDirectory()) || /[\\/]$/.test(output_path);
  return isDirectory ? resolve(candidate, name) : candidate;
}

// ─── Item attribute helpers ─────────────────────────────────────────────────
// Item attributes are not fields on the item card. Each assignment is a row in
// the Item Attribute Value Mapping table (7505) — keyed by table id + item no +
// attribute id — pointing at an option row in Item Attribute Value (7501),
// which belongs to a definition in Item Attribute (7500). None of these tables
// are exposed on Microsoft's standard v2.0 API, so set_item_attribute needs a
// custom AL API route that publishes them as itemAttributes,
// itemAttributeValues, and itemAttributeValueMappings with AL-style field
// names (name/type on 7500; attributeID/id/value on 7501;
// tableID/no/itemAttributeID/itemAttributeValueID on 7505).

const ITEM_ATTRIBUTE_TABLE_ID = 27; // table 27 = Item

// OData string literal: single quotes double up.
function odataString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function resolveItemAttributeRoute(api_route) {
  const route = resolveRoute(api_route || env("BC_ITEM_ATTR_API_ROUTE"));
  if (route === "v2.0") {
    throw new Error(
      "Item attributes are not exposed on the standard v2.0 API. Pass api_route (or set BC_ITEM_ATTR_API_ROUTE) to a custom AL API that publishes itemAttributes, itemAttributeValues, and itemAttributeValueMappings.",
    );
  }
  return route;
}

async function queryEntitySet(env, route, companyId, entitySet, query) {
  const data = await bcApi(
    "GET",
    companyPath(env, route, companyId, `/${encodeURIComponent(entitySet)}`),
    undefined,
    query,
  );
  return data.value ?? [];
}

// Match an input string against candidate rows: exact first, then
// case-insensitive. One winner returns; anything else throws through the
// callbacks so each caller words its own error.
function matchOne(rows, field, input, { onAmbiguous, onMissing }) {
  const wanted = String(input).trim();
  const exact = rows.filter((r) => String(r[field] ?? "").trim() === wanted);
  if (exact.length === 1) return exact[0];
  const ci = rows.filter(
    (r) =>
      String(r[field] ?? "")
        .trim()
        .toLowerCase() === wanted.toLowerCase(),
  );
  if (ci.length === 1) return ci[0];
  if (ci.length > 1 || exact.length > 1) throw onAmbiguous(exact.length > 1 ? exact : ci);
  throw onMissing();
}

async function resolveItemAttribute(env, route, companyId, attributeName) {
  const rows = await queryEntitySet(env, route, companyId, "itemAttributes", { $top: 1000 });
  return matchOne(rows, "name", attributeName, {
    onAmbiguous: (matches) =>
      new Error(
        `"${attributeName}" matches ${matches.length} attributes: ${matches.map((r) => `"${r.name}" (id ${r.id})`).join(", ")}. Repeat with the exact name.`,
      ),
    onMissing: () => {
      const names = rows.map((r) => String(r.name ?? "")).filter(Boolean);
      const near = names.filter((n) =>
        n.toLowerCase().includes(String(attributeName).trim().toLowerCase()),
      );
      return new Error(
        `No item attribute named "${attributeName}". ` +
          (near.length
            ? `Close matches: ${near.join(", ")}.`
            : `Known attributes: ${names.join(", ")}.`),
      );
    },
  });
}

async function resolveItemAttributeOption(env, route, companyId, attribute, value) {
  const options = await queryEntitySet(env, route, companyId, "itemAttributeValues", {
    $filter: `attributeID eq ${Number(attribute.id)}`,
    $top: 1000,
  });
  const option = matchOne(options, "value", value, {
    onAmbiguous: (matches) =>
      new Error(
        `"${value}" is ambiguous for attribute "${attribute.name}": ${matches.map((r) => `"${r.value}" (id ${r.id})`).join(", ")}. Repeat with the exact casing.`,
      ),
    onMissing: () =>
      new Error(
        `"${value}" is not an option for attribute "${attribute.name}". Valid options: ${options
          .map((r) => String(r.value ?? ""))
          .filter(Boolean)
          .join(
            " | ",
          )}. This tool never creates new options — add it in BC first if it should exist.`,
      ),
  });
  return { option, options };
}

// Best-effort item existence check. Custom APIs name the item key per their AL
// page ("no" is conventional; standard v2.0 uses "number"), and some routes
// don't publish items at all — those degrade to null ("unchecked") rather than
// blocking, since BC validates the mapping's table relation on write anyway.
// Only the two expected shapes are swallowed: 400 (unknown key field) and 404
// (items not published on this route). Auth failures, throttling that outlived
// the retries, and server errors propagate so they are not mistaken for
// "unchecked".
async function checkItemExists(env, route, companyId, itemNo) {
  for (const field of ["no", "number"]) {
    try {
      const rows = await queryEntitySet(env, route, companyId, "items", {
        $filter: `${field} eq ${odataString(itemNo)}`,
        $select: field,
        $top: 1,
      });
      return rows.length > 0;
    } catch (e) {
      if (e?.status === 400 || e?.status === 404) continue;
      throw e;
    }
  }
  return null;
}

// GET a resource and return null on 404 instead of throwing. Used by the
// destructive tools' plan step to detect existence before delete.
async function fetchExistingOrNull(path) {
  try {
    return await bcApi("GET", path);
  } catch (e) {
    if (e?.status === 404) return null;
    throw e;
  }
}

function ok(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

// Wraps a tool handler so any thrown error is returned as a structured
// MCP tool error instead of escaping as a protocol-level failure. This lets
// the LLM see the error message and react to it.
function safeTool(handler) {
  return async (args) => {
    try {
      return await handler(args);
    } catch (e) {
      const message = e?.message ?? String(e);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  };
}

const TRUNCATE_CHARS = 24_576;

// Truncate a value when its JSON representation exceeds `max` chars, returning
// a small envelope describing the truncation. Query results over wide entities
// (generalLedgerEntries, salesInvoiceLines, ...) can otherwise blow the LLM
// context window.
function maybeTruncate(value, max = TRUNCATE_CHARS) {
  if (value == null) return value;
  const json = JSON.stringify(value);
  if (json == null || json.length <= max) return value;
  return {
    _truncated: true,
    _totalChars: json.length,
    _preview: json.slice(0, max),
    _hint:
      "Narrow the query with $select/$filter/top, or pass full=true for the untruncated payload.",
  };
}

// Extracts a human-meaningful subject from an Entra access token's middle
// segment. Returns "unknown" on any parse failure — never throws, since this
// is only used for audit logging.
function parseTokenSubject(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return "unknown";
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return (
      payload.upn ||
      payload.preferred_username ||
      payload.unique_name ||
      payload.appid ||
      payload.oid ||
      "unknown"
    );
  } catch {
    return "unknown";
  }
}

// Wraps a mutating tool so each invocation is audit-logged to stderr with
// timestamp, tool name, target resource, caller identity, and outcome.
// Layered on top of safeTool — errors are still structured for the LLM.
function writeTool(toolName, getTarget, handler) {
  return safeTool(async (args) => {
    const target = getTarget(args);
    const token = await getToken();
    const caller = parseTokenSubject(token);
    const startedAt = new Date().toISOString();
    console.error(
      `[bc-mcp][AUDIT] ${startedAt} tool=${toolName} target=${target} caller=${caller} status=ATTEMPT`,
    );
    try {
      const result = await handler(args);
      console.error(
        `[bc-mcp][AUDIT] ${new Date().toISOString()} tool=${toolName} target=${target} caller=${caller} status=SUCCESS`,
      );
      return result;
    } catch (e) {
      const msg = (e?.message ?? String(e)).slice(0, 200);
      console.error(
        `[bc-mcp][AUDIT] ${new Date().toISOString()} tool=${toolName} target=${target} caller=${caller} status=FAILURE error=${msg}`,
      );
      throw e;
    }
  });
}

const SERVER_MODE = (env("BC_MCP_MODE") ?? "read").toLowerCase();
if (SERVER_MODE !== "read" && SERVER_MODE !== "write") {
  // Matches how BC_AUTH_MODE handles an unknown value. Failing quietly into
  // read mode leaves the user hunting for tools that were never registered,
  // and a stderr warning is invisible in a desktop client.
  console.error(`Invalid BC_MCP_MODE "${SERVER_MODE}". Valid: read, write`);
  process.exit(1);
}
const WRITE_ENABLED = SERVER_MODE === "write";
const DESTRUCTIVE_REQUESTED = env("BC_MCP_ALLOW_DELETE") === "true";
const DESTRUCTIVE_ENABLED = WRITE_ENABLED && DESTRUCTIVE_REQUESTED;
if (WRITE_ENABLED) {
  console.error(
    "[bc-mcp] write mode enabled — create/update/bound-action/export tools are exposed. These mutate real ERP data or write local files.",
  );
}
if (DESTRUCTIVE_ENABLED) {
  console.error(
    "[bc-mcp] destructive mode enabled — delete_entity is exposed (plan/apply confirmation required)",
  );
} else if (DESTRUCTIVE_REQUESTED && !WRITE_ENABLED) {
  console.error(
    "[bc-mcp] WARNING: BC_MCP_ALLOW_DELETE=true ignored because BC_MCP_MODE is not 'write'.",
  );
}

// ─── Plan/apply token store for destructive mutations ───────────────────────
// Tokens bind a specific (tool, target, payload) to a confirmation call.
// The plan step returns a token; the apply step (dry_run=false) must echo it
// back. Tokens expire after PLAN_TTL_MS. Captured @odata.etag enforces
// optimistic concurrency on the apply via If-Match.
const PLAN_TTL_MS = 10 * 60 * 1000;
const PLAN_STORE_MAX = 100;
const pendingPlans = new Map();

function hashPayload(payload) {
  return JSON.stringify(payload ?? null);
}

function createPlanToken(toolName, target, payload, etag) {
  // Bound the store: evict the oldest entry (Map preserves insertion order)
  // when at capacity. Prevents a buggy client from exhausting memory before
  // the periodic sweep runs.
  if (pendingPlans.size >= PLAN_STORE_MAX) {
    const oldest = pendingPlans.keys().next().value;
    if (oldest !== undefined) pendingPlans.delete(oldest);
  }
  const token = crypto.randomUUID();
  const expiresAt = Date.now() + PLAN_TTL_MS;
  pendingPlans.set(token, {
    toolName,
    target,
    payloadHash: hashPayload(payload),
    etag,
    expiresAt,
  });
  return { token, expiresAt: new Date(expiresAt).toISOString() };
}

function consumePlanToken(token, toolName, target, payload) {
  const entry = pendingPlans.get(token);
  if (!entry) {
    throw new Error(
      `Invalid confirm_token. Tokens expire after ${PLAN_TTL_MS / 60_000}m; request a new plan with dry_run=true.`,
    );
  }
  if (Date.now() > entry.expiresAt) {
    pendingPlans.delete(token);
    throw new Error(`confirm_token expired. Request a new plan with dry_run=true.`);
  }
  if (
    entry.toolName !== toolName ||
    entry.target !== target ||
    entry.payloadHash !== hashPayload(payload)
  ) {
    throw new Error(
      `confirm_token does not match the current call. If the payload changed since the plan, request a new plan.`,
    );
  }
  pendingPlans.delete(token);
  return entry;
}

// Sweep expired plans every minute. .unref() so the timer doesn't keep the
// Node event loop alive at shutdown.
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of pendingPlans) {
    if (entry.expiresAt < now) pendingPlans.delete(token);
  }
}, 60_000).unref();

// Shared plan/apply executor used by every destructive tool. Splits the call
// into "compute plan + issue token" (dry_run, default) vs. "consume token +
// apply with If-Match" (dry_run=false).
async function executePlanApply({
  toolName,
  action,
  target,
  payload,
  dry_run,
  confirm_token,
  fetchBefore,
  buildAfter,
  apply,
}) {
  const isDryRun = dry_run !== false;
  if (isDryRun) {
    const before = await fetchBefore();
    const etag = before?.["@odata.etag"];
    const { token, expiresAt } = createPlanToken(toolName, target, payload, etag);
    return ok({
      plan_type: "DRY_RUN",
      action,
      target,
      before: before ?? null,
      after: buildAfter(),
      confirm_token: token,
      expires_at: expiresAt,
      hint: `To apply, call ${toolName} again with dry_run=false and confirm_token="${token}".`,
    });
  }
  if (!confirm_token) {
    throw new Error(
      "confirm_token is required when dry_run=false. Run with dry_run=true first to generate a plan.",
    );
  }
  const entry = consumePlanToken(confirm_token, toolName, target, payload);
  try {
    const result = await apply(entry.etag);
    return ok({ plan_type: "APPLIED", action, target, result });
  } catch (e) {
    if (e?.status === 412) {
      throw new Error(
        `Resource ${target} changed since the plan was computed (HTTP 412 Precondition Failed). Request a new plan with dry_run=true.`,
      );
    }
    throw e;
  }
}

// Shared zod fragments for the entity tools.
const envInput = z
  .string()
  .optional()
  .describe("Environment name from list_environments. Falls back to BC_DEFAULT_ENVIRONMENT.");
const companyInput = z
  .string()
  .optional()
  .describe("Company id (GUID) from list_companies. Falls back to BC_DEFAULT_COMPANY_ID.");
const routeInput = z
  .string()
  .optional()
  .describe(
    'API route under /api/. Defaults to the standard "v2.0"; pass "{publisher}/{group}/{version}" for a custom AL API.',
  );
const planApplyInputs = {
  dry_run: z
    .boolean()
    .optional()
    .describe("If true (default), return the planned change without applying."),
  confirm_token: z
    .string()
    .optional()
    .describe("Token returned by a recent dry_run. Required when dry_run=false."),
};

const server = new McpServer({ name: "business-central-mcp", version: VERSION });

// ─── Read tools ─────────────────────────────────────────────────────────────

server.registerTool(
  "list_environments",
  {
    description:
      "List all Business Central environments in the tenant (production + sandboxes) via the environment discovery API. Each environment's `name` is the `environment` argument to every other tool. Requires BC admin-center access; if this returns 401/403, pass known environment names directly to the other tools.",
    inputSchema: {},
  },
  safeTool(async () => {
    const data = await bcApi("GET", "/environments/v1.1");
    const summary = (data.value ?? [])
      .filter((e) => (e.applicationFamily ?? "BusinessCentral") === "BusinessCentral")
      .map((e) => ({
        name: e.name,
        type: e.type,
        countryCode: e.countryCode,
        webClientUrl: e.webClientLoginUrl,
      }));
    return ok(summary);
  }),
);

server.registerTool(
  "list_companies",
  {
    description:
      "List the companies (legal entities) in a Business Central environment. Each company's `id` (GUID) is the `company_id` argument to the entity tools.",
    inputSchema: {
      environment: envInput,
    },
  },
  safeTool(async ({ environment }) => {
    const env = resolveEnv(environment);
    const data = await bcApi("GET", dataPath(env, "v2.0", "/companies"));
    const summary = (data.value ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      displayName: c.displayName,
      businessProfileId: c.businessProfileId || undefined,
    }));
    return ok(summary);
  }),
);

server.registerTool(
  "list_entity_sets",
  {
    description:
      "List the entity sets (API endpoints) available on an API route — customers, items, salesInvoices, generalLedgerEntries, etc. Use the returned names as `entity_set` in query_entities. Defaults to the standard v2.0 API; pass api_route for a custom AL API.",
    inputSchema: {
      environment: envInput,
      api_route: routeInput,
    },
  },
  safeTool(async ({ environment, api_route }) => {
    const env = resolveEnv(environment);
    const route = resolveRoute(api_route);
    const data = await bcApi("GET", dataPath(env, route, "/"));
    return ok((data.value ?? []).map((s) => s.name ?? s.url).sort());
  }),
);

server.registerTool(
  "query_entities",
  {
    description:
      "Query an entity set in a company with OData options ($filter, $select, $orderby, $expand). Returns up to `top` records (default 20) plus a nextLink when more pages exist; pass it back as `next_link` to page. Prefer $select to keep responses small — wide entities like generalLedgerEntries are truncated otherwise.",
    inputSchema: {
      entity_set: z
        .string()
        .describe("Entity set name from list_entity_sets (e.g. 'customers', 'salesInvoices')"),
      environment: envInput,
      company_id: companyInput,
      api_route: routeInput,
      filter: z
        .string()
        .optional()
        .describe('OData $filter expression, e.g. "postingDate ge 2026-07-01 and amount gt 100"'),
      select: z
        .string()
        .optional()
        .describe("OData $select column list, e.g. 'number,displayName,balanceDue'"),
      orderby: z.string().optional().describe("OData $orderby, e.g. 'postingDate desc'"),
      expand: z.string().optional().describe("OData $expand, e.g. 'salesInvoiceLines'"),
      top: z
        .number()
        .int()
        .positive()
        .max(1000)
        .optional()
        .describe("Max records to return per page. Defaults to 20."),
      count: z
        .boolean()
        .optional()
        .describe("Include the total matching record count as @odata.count."),
      next_link: z.string().optional().describe("A nextLink from a previous response, for paging"),
      full: z.boolean().optional().describe("Return untruncated payloads. Defaults to false."),
    },
  },
  safeTool(
    async ({
      entity_set,
      environment,
      company_id,
      api_route,
      filter,
      select,
      orderby,
      expand,
      top,
      count,
      next_link,
      full,
    }) => {
      // A nextLink is an already-constructed absolute URL; call it directly
      // rather than re-deriving query params.
      if (next_link) {
        const token = await getToken();
        const res = await fetch(next_link, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`BusinessCentral GET nextLink -> ${res.status}: ${text}`);
        const data = text ? JSON.parse(text) : {};
        return ok({
          count: data["@odata.count"],
          records: full ? (data.value ?? []) : maybeTruncate(data.value ?? []),
          nextLink: data["@odata.nextLink"] ?? null,
        });
      }
      const env = resolveEnv(environment);
      const route = resolveRoute(api_route);
      const companyId = resolveCompany(company_id);
      const data = await bcApi(
        "GET",
        companyPath(env, route, companyId, `/${encodeURIComponent(entity_set)}`),
        undefined,
        {
          $filter: filter,
          $select: select,
          $orderby: orderby,
          $expand: expand,
          $top: top ?? 20,
          $count: count ? "true" : undefined,
        },
      );
      return ok({
        count: data["@odata.count"],
        records: full ? (data.value ?? []) : maybeTruncate(data.value ?? []),
        nextLink: data["@odata.nextLink"] ?? null,
      });
    },
  ),
);

server.registerTool(
  "get_entity",
  {
    description:
      "Get a single record by its id (GUID) from an entity set, including its @odata.etag (needed for update/delete concurrency). For records keyed by number/code, use query_entities with $filter instead.",
    inputSchema: {
      entity_set: z.string().describe("Entity set name from list_entity_sets"),
      record_id: z.string().describe("The record's id (GUID)"),
      environment: envInput,
      company_id: companyInput,
      api_route: routeInput,
      expand: z.string().optional().describe("OData $expand, e.g. 'salesInvoiceLines'"),
      sub_path: z
        .string()
        .optional()
        .describe(
          "Navigation path beneath the record, e.g. 'pdfDocument' or 'attachments'. Slashes are preserved, so multi-segment paths work. Media metadata read this way exposes an @odata.mediaReadLink; pass the same path to export_file to fetch the bytes.",
        ),
    },
  },
  safeTool(
    async ({ entity_set, record_id, environment, company_id, api_route, expand, sub_path }) => {
      const env = resolveEnv(environment);
      const route = resolveRoute(api_route);
      const companyId = resolveCompany(company_id);
      const base = entityPath(env, route, companyId, entity_set, record_id);
      const data = await bcApi(
        "GET",
        sub_path ? `${base}/${encodeNavPath(sub_path)}` : base,
        undefined,
        { $expand: expand },
      );
      return ok(data);
    },
  ),
);

// ─── Write tools — registered only when BC_MCP_MODE=write ──────────────────

if (WRITE_ENABLED) {
  server.registerTool(
    "export_file",
    {
      description:
        "Download a binary document out of Business Central and save it to a local file — a posted invoice PDF, an attachment, or a picture. WRITE OPERATION: BC is only read, but the tool writes a file to the local filesystem, so it is gated behind write mode like every other tool with side effects. Typical sub_path values: 'pdfDocument/pdfDocumentContent' on salesInvoices/salesCreditMemos/purchaseInvoices, 'content' on attachments, 'picture' on items. Call get_entity with the same sub_path first to confirm the media link exists.",
      inputSchema: {
        entity_set: z.string().describe("Entity set holding the record, e.g. 'salesInvoices'"),
        record_id: z.string().describe("The record's id (GUID)"),
        sub_path: z
          .string()
          .describe(
            "Media navigation path beneath the record, e.g. 'pdfDocument/pdfDocumentContent'. Slashes are preserved.",
          ),
        output_path: z
          .string()
          .optional()
          .describe(
            "Destination file, or a directory to name the file automatically. Defaults to BC_EXPORT_DIR, else the working directory.",
          ),
        environment: envInput,
        company_id: companyInput,
        api_route: routeInput,
        max_bytes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Refuse downloads larger than this. Defaults to 64 MiB."),
        overwrite: z
          .boolean()
          .optional()
          .describe("Replace the destination file if it already exists. Defaults to false."),
      },
    },
    writeTool(
      "export_file",
      ({ entity_set, record_id, sub_path, environment, company_id }) =>
        `env=${environment || DEFAULT_ENVIRONMENT || "?"} company=${company_id || DEFAULT_COMPANY_ID || "?"} set=${entity_set} id=${record_id} media=${sub_path}`,
      async ({
        entity_set,
        record_id,
        sub_path,
        output_path,
        environment,
        company_id,
        api_route,
        max_bytes,
        overwrite,
      }) => {
        const env = resolveEnv(environment);
        const route = resolveRoute(api_route);
        const companyId = resolveCompany(company_id);
        const mediaPath = `${entityPath(env, route, companyId, entity_set, record_id)}/${encodeNavPath(sub_path)}`;
        const { buffer, contentType, contentDisposition } = await bcApiBinary(
          mediaPath,
          {},
          max_bytes ?? MAX_EXPORT_BYTES,
        );
        const suggested =
          filenameFromDisposition(contentDisposition) ??
          (await lookupRecordFileName(env, route, companyId, entity_set, record_id));
        const target = resolveExportTarget({
          output_path,
          entity_set,
          record_id,
          sub_path,
          buffer,
          contentType,
          suggested,
        });
        mkdirSync(dirname(target), { recursive: true });
        try {
          writeFileSync(target, buffer, { flag: overwrite === true ? "w" : "wx" });
        } catch (e) {
          if (e?.code === "EEXIST" && overwrite !== true) {
            throw new Error(`${target} already exists. Pass overwrite=true to replace it.`);
          }
          throw e;
        }
        return ok({
          file: target,
          bytes: buffer.length,
          contentType,
          sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
          source: `${entity_set}(${record_id})/${sub_path}`,
        });
      },
    ),
  );

  server.registerTool(
    "create_entity",
    {
      description:
        "Create a new record in an entity set (e.g. a customer, item, or sales order header). WRITE OPERATION: this inserts real ERP data. Returns the created record including its id and @odata.etag.",
      inputSchema: {
        entity_set: z.string().describe("Entity set name from list_entity_sets"),
        record: z
          .record(z.unknown())
          .describe("The record body as field/value pairs, e.g. {displayName: 'New Customer'}"),
        environment: envInput,
        company_id: companyInput,
        api_route: routeInput,
      },
    },
    writeTool(
      "create_entity",
      ({ entity_set, environment, company_id }) =>
        `env=${environment || DEFAULT_ENVIRONMENT || "?"} company=${company_id || DEFAULT_COMPANY_ID || "?"} set=${entity_set}`,
      async ({ entity_set, record, environment, company_id, api_route }) => {
        const env = resolveEnv(environment);
        const route = resolveRoute(api_route);
        const companyId = resolveCompany(company_id);
        const data = await bcApi(
          "POST",
          companyPath(env, route, companyId, `/${encodeURIComponent(entity_set)}`),
          record,
        );
        return ok({ created: true, record: data });
      },
    ),
  );

  server.registerTool(
    "update_entity",
    {
      description:
        "Update fields on an existing record (PATCH). WRITE OPERATION: this modifies real ERP data. Concurrency-safe: uses the record's current @odata.etag as If-Match (fetched automatically unless `etag` is passed); a 412 means the record changed underneath you — re-read and retry.",
      inputSchema: {
        entity_set: z.string().describe("Entity set name from list_entity_sets"),
        record_id: z.string().describe("The record's id (GUID)"),
        record: z.record(z.unknown()).describe("Only the fields to change, e.g. {blocked: 'All'}"),
        etag: z
          .string()
          .optional()
          .describe("@odata.etag from a recent get_entity. Fetched automatically if omitted."),
        environment: envInput,
        company_id: companyInput,
        api_route: routeInput,
      },
    },
    writeTool(
      "update_entity",
      ({ entity_set, record_id, environment, company_id }) =>
        `env=${environment || DEFAULT_ENVIRONMENT || "?"} company=${company_id || DEFAULT_COMPANY_ID || "?"} set=${entity_set} id=${record_id}`,
      async ({ entity_set, record_id, record, etag, environment, company_id, api_route }) => {
        const env = resolveEnv(environment);
        const route = resolveRoute(api_route);
        const companyId = resolveCompany(company_id);
        const path = entityPath(env, route, companyId, entity_set, record_id);
        let ifMatch = etag;
        if (!ifMatch) {
          const current = await bcApi("GET", path);
          ifMatch = current?.["@odata.etag"];
        }
        if (!ifMatch) {
          throw new Error(
            `Could not determine @odata.etag for ${entity_set}(${record_id}); pass etag explicitly.`,
          );
        }
        const data = await bcApi("PATCH", path, record, undefined, { "If-Match": ifMatch });
        return ok({ updated: true, record: data });
      },
    ),
  );

  server.registerTool(
    "set_item_attribute",
    {
      description:
        "Set an item attribute on an item: resolves the attribute by name, validates the value against the attribute's option list, and updates (or creates) the item's mapping row. Requires a custom AL API route that publishes itemAttributes, itemAttributeValues, and itemAttributeValueMappings — the standard v2.0 API does not expose them; pass api_route or set BC_ITEM_ATTR_API_ROUTE. Two-step: the first call (dry_run=true, default) returns current value → new value with resolved ids plus a confirm_token; a second call with dry_run=false and that token applies it and re-reads the row to verify. Only Option-type attributes are supported, and a value missing from the option list is an error — this tool never creates new dropdown options. WRITE OPERATION: modifies real ERP item master data.",
      inputSchema: {
        item_no: z.string().describe("The item's No. (e.g. '90031') — not its GUID"),
        attribute_name: z
          .string()
          .describe("Item attribute name exactly as defined in BC, e.g. 'Group Name'"),
        value: z
          .string()
          .describe(
            "Target option value, e.g. 'Roll'. Matched exactly first, then case-insensitively, against the attribute's option list.",
          ),
        environment: envInput,
        company_id: companyInput,
        api_route: z
          .string()
          .optional()
          .describe(
            'Custom AL API route publishing the item-attribute entity sets, "{publisher}/{group}/{version}". Falls back to BC_ITEM_ATTR_API_ROUTE.',
          ),
        ...planApplyInputs,
      },
    },
    writeTool(
      "set_item_attribute",
      ({ item_no, attribute_name, value, environment, company_id }) =>
        `env=${environment || DEFAULT_ENVIRONMENT || "?"} company=${company_id || DEFAULT_COMPANY_ID || "?"} item=${item_no} attribute=${attribute_name} value=${value}`,
      async ({
        item_no,
        attribute_name,
        value,
        environment,
        company_id,
        api_route,
        dry_run,
        confirm_token,
      }) => {
        const env = resolveEnv(environment);
        const route = resolveItemAttributeRoute(api_route);
        const companyId = resolveCompany(company_id);

        const attribute = await resolveItemAttribute(env, route, companyId, attribute_name);
        if (String(attribute.type) !== "Option") {
          throw new Error(
            `Attribute "${attribute.name}" is type ${attribute.type}; only Option-type attributes are supported.`,
          );
        }
        if (attribute.blocked) {
          throw new Error(`Attribute "${attribute.name}" is blocked in BC.`);
        }
        const { option, options } = await resolveItemAttributeOption(
          env,
          route,
          companyId,
          attribute,
          value,
        );
        if (option.blocked) {
          throw new Error(`Option "${option.value}" (id ${option.id}) is blocked in BC.`);
        }

        const itemExists = await checkItemExists(env, route, companyId, item_no);
        if (itemExists === false) {
          throw new Error(`Item ${item_no} does not exist in this company.`);
        }

        const mappingFilter = `tableID eq ${ITEM_ATTRIBUTE_TABLE_ID} and no eq ${odataString(item_no)} and itemAttributeID eq ${Number(attribute.id)}`;
        const mappings = await queryEntitySet(env, route, companyId, "itemAttributeValueMappings", {
          $filter: mappingFilter,
          $top: 2,
        });
        if (mappings.length > 1) {
          throw new Error(
            `Found ${mappings.length} mapping rows for item ${item_no} / attribute "${attribute.name}"; expected at most one. Inspect itemAttributeValueMappings manually.`,
          );
        }
        const current = mappings[0] ?? null;
        const currentOption = current
          ? (options.find((o) => o.id === current.itemAttributeValueID) ?? null)
          : null;

        const summary = {
          item_no,
          attribute: { id: attribute.id, name: attribute.name },
          current_value: current
            ? {
                id: current.itemAttributeValueID,
                value: currentOption?.value ?? "(unknown option)",
              }
            : null,
          new_value: { id: option.id, value: option.value },
          item_checked: itemExists ?? "items not queryable on this route; existence not verified",
        };

        if (current && current.itemAttributeValueID === option.id) {
          return ok({
            already_set: true,
            ...summary,
            hint: "No write performed — the mapping already points at this option.",
          });
        }

        const target = `env=${env} company=${companyId} item=${item_no} attribute=${attribute.id} value=${option.id}`;
        // Recomputed on both the plan and apply calls; a mismatch (e.g. the
        // mapping row appeared or vanished in between) invalidates the token.
        const payload = {
          env,
          companyId,
          route,
          item_no,
          attributeId: attribute.id,
          optionId: option.id,
          mappingSystemId: current?.systemId ?? null,
        };

        return executePlanApply({
          toolName: "set_item_attribute",
          action: current ? "update item attribute mapping" : "create item attribute mapping",
          target,
          payload,
          dry_run,
          confirm_token,
          fetchBefore: async () => (current ? { ...current, _resolved: summary } : null),
          buildAfter: () => summary,
          apply: async (etag) => {
            let written;
            if (current) {
              written = await bcApi(
                "PATCH",
                entityPath(env, route, companyId, "itemAttributeValueMappings", current.systemId),
                { itemAttributeValueID: option.id },
                undefined,
                { "If-Match": etag ?? current["@odata.etag"] },
              );
            } else {
              written = await bcApi(
                "POST",
                companyPath(env, route, companyId, "/itemAttributeValueMappings"),
                {
                  tableID: ITEM_ATTRIBUTE_TABLE_ID,
                  no: item_no,
                  itemAttributeID: attribute.id,
                  itemAttributeValueID: option.id,
                },
              );
            }
            const verify = await queryEntitySet(
              env,
              route,
              companyId,
              "itemAttributeValueMappings",
              { $filter: mappingFilter, $top: 1 },
            );
            return { ...summary, written: written ?? null, verified: verify[0] ?? null };
          },
        });
      },
    ),
  );

  server.registerTool(
    "invoke_bound_action",
    {
      description:
        "Invoke an OData bound action on a record — e.g. 'post' on a salesInvoice, 'ship' on a salesOrder, 'cancel' on a postedInvoice. WRITE OPERATION with real business consequences: posting documents creates ledger entries that cannot simply be deleted. Know what the action does before calling it.",
      inputSchema: {
        entity_set: z.string().describe("Entity set name from list_entity_sets"),
        record_id: z.string().describe("The record's id (GUID)"),
        action_name: z
          .string()
          .describe(
            "The bound action name, e.g. 'post', 'ship', 'cancel' (Microsoft.NAV.* is prefixed automatically)",
          ),
        body: z.record(z.unknown()).optional().describe("Optional action parameters as an object"),
        environment: envInput,
        company_id: companyInput,
        api_route: routeInput,
      },
    },
    writeTool(
      "invoke_bound_action",
      ({ entity_set, record_id, action_name, environment, company_id }) =>
        `env=${environment || DEFAULT_ENVIRONMENT || "?"} company=${company_id || DEFAULT_COMPANY_ID || "?"} set=${entity_set} id=${record_id} action=${action_name}`,
      async ({ entity_set, record_id, action_name, body, environment, company_id, api_route }) => {
        const env = resolveEnv(environment);
        const route = resolveRoute(api_route);
        const companyId = resolveCompany(company_id);
        const action = action_name.includes(".") ? action_name : `Microsoft.NAV.${action_name}`;
        const data = await bcApi(
          "POST",
          entityPath(env, route, companyId, entity_set, record_id) +
            `/${encodeURIComponent(action)}`,
          body && Object.keys(body).length ? body : undefined,
        );
        return ok({ invoked: true, action, result: data ?? null });
      },
    ),
  );
}

// ─── Destructive tools — registered only when ──────────────────────────────
//      BC_MCP_MODE=write AND BC_MCP_ALLOW_DELETE=true
// Uses the dry_run/confirm_token plan-apply pattern: the plan step fetches the
// existing record (captures its @odata.etag), shows what will be removed, and
// returns a single-use token. The apply step (dry_run=false) requires that
// token and uses If-Match for optimistic concurrency.

if (DESTRUCTIVE_ENABLED) {
  server.registerTool(
    "delete_entity",
    {
      description:
        "Permanently delete a record from an entity set. Two-step: first call (dry_run=true, default) returns the record that will be removed and a confirm_token; second call (dry_run=false with that token) deletes it. This cannot be undone. Posted documents cannot be deleted — use invoke_bound_action('cancel'/'creditMemo' flows) instead.",
      inputSchema: {
        entity_set: z.string().describe("Entity set name from list_entity_sets"),
        record_id: z.string().describe("The record's id (GUID)"),
        environment: envInput,
        company_id: companyInput,
        api_route: routeInput,
        ...planApplyInputs,
      },
    },
    writeTool(
      "delete_entity",
      ({ entity_set, record_id, environment, company_id }) =>
        `env=${environment || DEFAULT_ENVIRONMENT || "?"} company=${company_id || DEFAULT_COMPANY_ID || "?"} set=${entity_set} id=${record_id}`,
      async ({
        entity_set,
        record_id,
        environment,
        company_id,
        api_route,
        dry_run,
        confirm_token,
      }) => {
        const env = resolveEnv(environment);
        const route = resolveRoute(api_route);
        const companyId = resolveCompany(company_id);
        const path = entityPath(env, route, companyId, entity_set, record_id);
        const target = `env=${env} company=${companyId} set=${entity_set} id=${record_id}`;
        return executePlanApply({
          toolName: "delete_entity",
          action: "delete",
          target,
          payload: { entity_set, record_id, env, companyId },
          dry_run,
          confirm_token,
          fetchBefore: async () => {
            const r = await fetchExistingOrNull(path);
            if (!r) {
              throw new Error(`${entity_set}(${record_id}) does not exist; nothing to delete.`);
            }
            return r;
          },
          buildAfter: () => null,
          apply: (etag) =>
            bcApi("DELETE", path, undefined, undefined, etag ? { "If-Match": etag } : {}),
        });
      },
    ),
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
