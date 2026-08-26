#!/usr/bin/env node
// Builds the installable MCP bundle (.mcpb) for Claude Desktop.
//
// The bundle is a zip of a manifest, the server, and its production
// dependencies. Claude Desktop ships its own Node runtime, so nothing here
// needs a toolchain on the user's machine; `command: "node"` in the manifest
// resolves to that bundled runtime.
//
// Layout produced under dist/bundle:
//
//   manifest.json      what Desktop reads to render the install dialog
//   icon.png
//   node_modules/      production deps, resolved upward from server/
//   server/index.js    entry point, with package.json beside it because
//                      index.js reads its own version from there
//
// Also enforces the two ways this bundle can silently rot: a manifest version
// that drifts from package.json, and a manifest tool list that drifts from
// what the server actually registers.
//
// There is deliberately no prune step and no .mcpbignore: `mcpb pack` already
// drops source maps, type declarations, lockfiles, and tooling dotfiles by
// default (see @anthropic-ai/mcpb/dist/node/files.js). Pruning them here as
// well changed the archive by 0.1 MB and only made the build lie about what
// it was doing.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { listTools } from "./lib/stdio-client.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const BUNDLE = join(DIST, "bundle");
const MCPB_CLI = join(ROOT, "node_modules", "@anthropic-ai", "mcpb", "dist", "cli", "cli.js");

const SERVER_FILES = ["index.js", "package.json", "README.md", "LICENSE", "CHANGELOG.md"];
const ROOT_FILES = ["manifest.json", "icon.png"];

const run = (file, args, options = {}) =>
  execFileSync(file, args, { stdio: "inherit", cwd: ROOT, ...options });

const step = (message) => console.log(`\n▸ ${message}`);

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));

step("checking manifest against package.json");
if (manifest.version !== pkg.version) {
  console.error(
    `manifest.json version ${manifest.version} does not match package.json ${pkg.version}`,
  );
  process.exit(1);
}
console.log(`  version ${pkg.version}`);

step("staging bundle");
// Windows can hold transient handles on a freshly written tree (indexer,
// scanner, a shell still parked inside it), so retry rather than fail.
rmSync(DIST, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
mkdirSync(join(BUNDLE, "server"), { recursive: true });
for (const file of ROOT_FILES) cpSync(join(ROOT, file), join(BUNDLE, file));
for (const file of SERVER_FILES) cpSync(join(ROOT, file), join(BUNDLE, "server", file));

// npm needs a manifest pair at the install root. node_modules lands at the
// bundle root, where Node's resolution finds it walking up from server/.
cpSync(join(ROOT, "package.json"), join(BUNDLE, "package.json"));
cpSync(join(ROOT, "package-lock.json"), join(BUNDLE, "package-lock.json"));

step("installing production dependencies");
run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
  cwd: BUNDLE,
  shell: process.platform === "win32",
});
rmSync(join(BUNDLE, "package.json"));
rmSync(join(BUNDLE, "package-lock.json"));

step("verifying the bundled server");
const entry = join(BUNDLE, "server", "index.js");
const declared = manifest.tools.map((tool) => tool.name).sort();
// Most permissive configuration, so every tool the server can register does.
const { tools: actual } = await listTools({
  args: [entry],
  env: {
    BC_AUTH_MODE: "service-principal",
    AZURE_TENANT_ID: "00000000-0000-0000-0000-000000000000",
    AZURE_CLIENT_ID: "build",
    AZURE_CLIENT_SECRET: "build",
    BC_MCP_MODE: "write",
    BC_MCP_ALLOW_DELETE: "true",
  },
});
if (JSON.stringify(declared) !== JSON.stringify(actual)) {
  console.error("manifest.json tools do not match what the server registers");
  console.error(`  declared: ${declared.join(", ")}`);
  console.error(`  actual:   ${actual.join(", ")}`);
  process.exit(1);
}
console.log(`  handshake ok, ${actual.length} tools match the manifest`);

step("validating manifest");
run(process.execPath, [MCPB_CLI, "validate", join(BUNDLE, "manifest.json")]);

step("packing");
const outfile = join(DIST, `${manifest.name}-${manifest.version}.mcpb`);
run(process.execPath, [MCPB_CLI, "pack", BUNDLE, outfile], {
  stdio: ["inherit", "pipe", "inherit"],
});

const bytes = statSync(outfile).size;
console.log(`\n${outfile}`);
console.log(`${(bytes / 1024 / 1024).toFixed(2)} MB`);
