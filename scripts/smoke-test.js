#!/usr/bin/env node
// Boots the server over stdio and asserts the tool surface it advertises.
//
// `npm run lint` catches parse errors, but not an import-time crash, a bad
// transport wiring, or a tool that silently stops registering. Those only
// surface when the process actually speaks MCP, so this does exactly that:
// spawn the real entry point, complete the handshake, and compare
// `tools/list` against the modes documented in `.env.example`.

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = resolve(ROOT, "index.js");
const TIMEOUT_MS = 30_000;

// Fake service-principal credentials keep startup non-interactive and offline.
// @azure/identity does not contact Entra until a token is actually requested,
// and the handshake never requests one.
const BASE_ENV = {
  BC_AUTH_MODE: "service-principal",
  AZURE_TENANT_ID: "00000000-0000-0000-0000-000000000000",
  AZURE_CLIENT_ID: "smoke-test",
  AZURE_CLIENT_SECRET: "smoke-test",
};

const READ_TOOLS = [
  "get_entity",
  "list_companies",
  "list_entity_sets",
  "list_environments",
  "query_entities",
];

const WRITE_TOOLS = [
  ...READ_TOOLS,
  "create_entity",
  "export_file",
  "invoke_bound_action",
  "update_entity",
];

const DESTRUCTIVE_TOOLS = [...WRITE_TOOLS, "delete_entity"];

// A developer's own BC_*/AZURE_* exports must not leak into the child, or the
// assertions below would pass or fail based on their local shell.
function cleanEnv(overrides) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("BC_") && !key.startsWith("AZURE_")) env[key] = value;
  }
  return { ...env, ...BASE_ENV, ...overrides };
}

function listTools(overrides) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [ENTRY], {
      env: cleanEnv(overrides),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error(`timed out after ${TIMEOUT_MS}ms\n${stderr}`));
    }, TIMEOUT_MS);

    const finish = (error, value) => {
      clearTimeout(timer);
      child.kill();
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => finish(error));
    child.stdin.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        finish(new Error(`server exited with code ${code}\n${stderr}`));
      }
    });

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      // The stdio transport is newline-delimited JSON; the last element is a
      // partial line until the next chunk arrives.
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          finish(new Error(`non-JSON line on stdout: ${line}`));
          return;
        }
        if (message.id === 2) {
          if (message.error) {
            finish(new Error(`tools/list failed: ${JSON.stringify(message.error)}`));
            return;
          }
          finish(null, message.result.tools.map((tool) => tool.name).sort());
        }
      }
    });

    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "smoke-test", version: "1.0.0" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  });
}

const CASES = [
  { name: "read mode (default)", env: {}, expected: READ_TOOLS },
  { name: "write mode", env: { BC_MCP_MODE: "write" }, expected: WRITE_TOOLS },
  {
    name: "write mode + delete opt-in",
    env: { BC_MCP_MODE: "write", BC_MCP_ALLOW_DELETE: "true" },
    expected: DESTRUCTIVE_TOOLS,
  },
  {
    // BC_MCP_ALLOW_DELETE must be inert without write mode.
    name: "delete opt-in ignored in read mode",
    env: { BC_MCP_ALLOW_DELETE: "true" },
    expected: READ_TOOLS,
  },
];

let failed = 0;
for (const testCase of CASES) {
  try {
    const actual = await listTools(testCase.env);
    const expected = [...testCase.expected].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      console.error(`FAIL  ${testCase.name}`);
      console.error(`      expected: ${expected.join(", ")}`);
      console.error(`      actual:   ${actual.join(", ")}`);
      failed += 1;
    } else {
      console.log(`ok    ${testCase.name} (${actual.length} tools)`);
    }
  } catch (error) {
    console.error(`FAIL  ${testCase.name}: ${error.message}`);
    failed += 1;
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${CASES.length} smoke tests failed`);
  process.exit(1);
}
console.log(`\nall ${CASES.length} smoke tests passed`);
