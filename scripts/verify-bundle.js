#!/usr/bin/env node
// Simulates a Claude Desktop install of the packed .mcpb and boots what comes
// out of it.
//
// `npm run build:mcpb` proves the staged directory works. This proves the
// *archive* works, and that the manifest's user_config actually produces a
// launchable server: it unpacks the bundle, runs the manifest through the
// MCPB toolkit's own `getMcpConfigForManifest` (the same substitution Desktop
// performs), then spawns exactly the command, args, and environment that
// comes back.
//
// What it cannot cover is the Desktop UI itself and the Entra browser
// round-trip. Everything up to the moment the browser opens is exercised here.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getMcpConfigForManifest } from "@anthropic-ai/mcpb";

import { listTools } from "./lib/stdio-client.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const INSTALLED = join(DIST, "installed");
const MCPB_CLI = join(ROOT, "node_modules", "@anthropic-ai", "mcpb", "dist", "cli", "cli.js");

const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
const archive = join(DIST, `${manifest.name}-${manifest.version}.mcpb`);

if (!existsSync(archive)) {
  console.error(`no bundle at ${archive}\nrun \`npm run build:mcpb\` first`);
  process.exit(1);
}

console.log(`unpacking ${manifest.name}-${manifest.version}.mcpb`);
rmSync(INSTALLED, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
execFileSync(process.execPath, [MCPB_CLI, "unpack", archive, INSTALLED], { stdio: "pipe" });

const installedManifest = JSON.parse(readFileSync(join(INSTALLED, "manifest.json"), "utf8"));

// Stand-ins for the directories Desktop resolves on the user's machine.
const SYSTEM_DIRS = {
  HOME: join(INSTALLED, "home"),
  DESKTOP: join(INSTALLED, "home", "Desktop"),
  DOCUMENTS: join(INSTALLED, "home", "Documents"),
  DOWNLOADS: join(INSTALLED, "home", "Downloads"),
};

const TENANT = "00000000-0000-0000-0000-000000000000";

// `export_dir` is required and declares no default, so Desktop collects a real
// path through its directory picker. A `${DOCUMENTS}` default cannot stand in:
// the toolkit expands system directories *before* user_config values, so it
// would reach the server as that literal string, and `hasRequiredConfigMissing`
// inspects only userConfig, so accepting a prefilled literal would satisfy
// `required` and land a placeholder in the environment.
const EXPORT_DIR = join(INSTALLED, "home", "Documents");

const READ_TOOLS = [
  "get_entity",
  "list_companies",
  "list_entity_sets",
  "list_environments",
  "query_entities",
];
const ALL_TOOLS = [
  ...READ_TOOLS,
  "create_entity",
  "delete_entity",
  "export_file",
  "invoke_bound_action",
  "update_entity",
];

const CASES = [
  {
    // The path the README leads with: pick interactive, type a tenant, leave
    // everything else alone. Every optional field is blank here, which is
    // exactly the case that leaks `${user_config.*}` placeholders when the
    // manifest forgets a default.
    name: "interactive, only the tenant filled in",
    userConfig: { tenant_id: TENANT, export_dir: EXPORT_DIR },
    expected: READ_TOOLS,
    expectEnv: {
      BC_AUTH_MODE: "interactive",
      BC_MCP_MODE: "read",
      AZURE_CLIENT_ID: "",
      BC_EXPORT_DIR: EXPORT_DIR,
    },
  },
  {
    name: "interactive, write mode with deletion enabled",
    userConfig: { tenant_id: TENANT, export_dir: EXPORT_DIR, mode: "write", allow_delete: true },
    expected: ALL_TOOLS,
    expectEnv: { BC_MCP_ALLOW_DELETE: "true" },
  },
  {
    name: "service principal",
    userConfig: {
      tenant_id: TENANT,
      export_dir: EXPORT_DIR,
      auth_mode: "service-principal",
      client_id: "verify",
      client_secret: "verify",
    },
    expected: READ_TOOLS,
    expectEnv: { AZURE_CLIENT_ID: "verify" },
  },
];

let failed = 0;

for (const testCase of CASES) {
  try {
    const config = await getMcpConfigForManifest({
      manifest: installedManifest,
      extensionPath: INSTALLED,
      systemDirs: SYSTEM_DIRS,
      userConfig: testCase.userConfig,
      pathSeparator: "/",
    });

    if (!config) {
      throw new Error("Desktop would refuse to launch this configuration");
    }

    // A surviving `${...}` means an optional field has no default in the
    // manifest. The server guards against it, but the manifest should not
    // produce one in the first place.
    for (const [key, value] of Object.entries(config.env)) {
      if (/\$\{/.test(value)) {
        throw new Error(`${key} kept an unsubstituted placeholder: ${value}`);
      }
    }
    for (const [key, value] of Object.entries(testCase.expectEnv)) {
      if (config.env[key] !== value) {
        throw new Error(
          `${key} was ${JSON.stringify(config.env[key])}, expected ${JSON.stringify(value)}`,
        );
      }
    }

    const { tools: actual } = await listTools({
      command: config.command,
      args: config.args,
      env: config.env,
    });
    const expected = [...testCase.expected].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `tools mismatch\n      expected: ${expected.join(", ")}\n      actual:   ${actual.join(", ")}`,
      );
    }
    console.log(`ok    ${testCase.name} (${actual.length} tools)`);
  } catch (error) {
    console.error(`FAIL  ${testCase.name}: ${error.message}`);
    failed += 1;
  }
}

// A blank tenant must be caught by Desktop at install time, not by the server
// at first use.
const withoutTenant = await getMcpConfigForManifest({
  manifest: installedManifest,
  extensionPath: INSTALLED,
  systemDirs: SYSTEM_DIRS,
  userConfig: {},
  pathSeparator: "/",
});
if (withoutTenant === undefined) {
  console.log("ok    missing tenant is refused before launch");
} else {
  console.error("FAIL  missing tenant should have been refused before launch");
  failed += 1;
}

const total = CASES.length + 1;
if (failed > 0) {
  console.error(`\n${failed} of ${total} bundle checks failed`);
  process.exit(1);
}
console.log(`\nall ${total} bundle checks passed`);
