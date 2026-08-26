#!/usr/bin/env node
// Boots the server over stdio and asserts the tool surface it advertises.
//
// `npm run lint` catches parse errors, but not an import-time crash, a bad
// transport wiring, or a tool that silently stops registering. Those only
// surface when the process actually speaks MCP, so this does exactly that:
// spawn the real entry point, complete the handshake, and compare
// `tools/list` against the modes documented in `.env.example`.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { listTools, runUntilExit } from "./lib/stdio-client.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = resolve(ROOT, "index.js");

// Throwaway service-principal credentials keep startup non-interactive and
// offline. @azure/identity does not contact Entra until a token is actually
// requested, and the handshake never requests one.
const BASE_ENV = {
  BC_AUTH_MODE: "service-principal",
  AZURE_TENANT_ID: "00000000-0000-0000-0000-000000000000",
  AZURE_CLIENT_ID: "smoke-test",
  AZURE_CLIENT_SECRET: "smoke-test",
};

// Mirrors AZURE_CLI_CLIENT_ID in index.js. Interactive sign-in falls back to
// this public client when no client id is configured.
const AZURE_CLI_CLIENT_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46";

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
  {
    // An MCPB client passes `${user_config.<key>}` through verbatim when an
    // optional field is blank and the manifest gives it no default.
    //
    // Asserting the tool surface alone would not catch a regression here:
    // tools/list never requests a token, so a credential built with the literal
    // as its client id still lists five tools. The stderr assertions are what
    // make this bite.
    name: "interactive survives unsubstituted placeholders",
    env: {
      BC_AUTH_MODE: "interactive",
      AZURE_TENANT_ID: "00000000-0000-0000-0000-000000000000",
      AZURE_CLIENT_ID: "${user_config.client_id}",
      AZURE_CLIENT_SECRET: "${user_config.client_secret}",
    },
    expected: READ_TOOLS,
    expectStderr: [
      new RegExp(`interactive sign-in as client ${AZURE_CLI_CLIENT_ID}`),
      /interactive sign-in as client .*public Azure CLI client/,
      /ignoring unsubstituted configuration:.*AZURE_CLIENT_ID/,
      /ignoring unsubstituted configuration:.*AZURE_CLIENT_SECRET/,
    ],
  },
  {
    // The counterpart: a real client id must be used verbatim, so the case
    // above is proving a fallback rather than a constant.
    name: "interactive honours an explicit client id",
    env: {
      BC_AUTH_MODE: "interactive",
      AZURE_TENANT_ID: "00000000-0000-0000-0000-000000000000",
      AZURE_CLIENT_ID: "11111111-2222-3333-4444-555555555555",
    },
    expected: READ_TOOLS,
    expectStderr: [/interactive sign-in as client 11111111-2222-3333-4444-555555555555$/m],
    rejectStderr: [/public Azure CLI client/],
  },
];

// The placeholder guard is only meaningful if an unsubstituted value reads as
// *unset*. Without it the literal is truthy, requireEnv is satisfied, and the
// server boots with a garbage tenant that only fails later at the Entra
// round-trip, where the error says nothing about the real cause.
const REFUSAL_CASES = [
  {
    name: "placeholder tenant refuses to start",
    env: { BC_AUTH_MODE: "interactive", AZURE_TENANT_ID: "${user_config.tenant_id}" },
    expectStderr: /requires AZURE_TENANT_ID/,
  },
  {
    name: "blank tenant refuses to start",
    env: { BC_AUTH_MODE: "interactive", AZURE_TENANT_ID: "" },
    expectStderr: /requires AZURE_TENANT_ID/,
  },
  {
    // BC_MCP_MODE arrives as free text from the install dialog, because the
    // manifest schema has no enum for string fields. A typo used to degrade
    // silently to read mode, leaving the user hunting for absent tools.
    name: "unrecognised BC_MCP_MODE refuses to start",
    env: { BC_MCP_MODE: "readwrite" },
    expectStderr: /Invalid BC_MCP_MODE "readwrite"/,
  },
];

let failed = 0;

for (const testCase of CASES) {
  try {
    const { tools, stderr } = await listTools({
      args: [ENTRY],
      env: { ...BASE_ENV, ...testCase.env },
    });
    const expected = [...testCase.expected].sort();
    const problems = [];
    if (JSON.stringify(tools) !== JSON.stringify(expected)) {
      problems.push(`expected tools: ${expected.join(", ")}`);
      problems.push(`actual tools:   ${tools.join(", ")}`);
    }
    for (const pattern of testCase.expectStderr ?? []) {
      if (!pattern.test(stderr)) problems.push(`stderr missing ${pattern}`);
    }
    for (const pattern of testCase.rejectStderr ?? []) {
      if (pattern.test(stderr)) problems.push(`stderr unexpectedly matched ${pattern}`);
    }
    if (problems.length > 0) {
      console.error(`FAIL  ${testCase.name}`);
      for (const problem of problems) console.error(`      ${problem}`);
      if (stderr.trim()) console.error(`      stderr: ${stderr.trim()}`);
      failed += 1;
    } else {
      console.log(`ok    ${testCase.name} (${tools.length} tools)`);
    }
  } catch (error) {
    console.error(`FAIL  ${testCase.name}: ${error.message}`);
    failed += 1;
  }
}

for (const testCase of REFUSAL_CASES) {
  try {
    const { code, stderr } = await runUntilExit({
      args: [ENTRY],
      env: { ...BASE_ENV, ...testCase.env },
    });
    if (code === 0) {
      console.error(`FAIL  ${testCase.name}: exited 0, expected a non-zero exit`);
      failed += 1;
    } else if (!testCase.expectStderr.test(stderr)) {
      console.error(`FAIL  ${testCase.name}: stderr did not match ${testCase.expectStderr}`);
      console.error(`      stderr: ${stderr.trim()}`);
      failed += 1;
    } else {
      console.log(`ok    ${testCase.name} (exit ${code})`);
    }
  } catch (error) {
    console.error(`FAIL  ${testCase.name}: ${error.message}`);
    failed += 1;
  }
}

const total = CASES.length + REFUSAL_CASES.length;
if (failed > 0) {
  console.error(`\n${failed} of ${total} smoke tests failed`);
  process.exit(1);
}
console.log(`\nall ${total} smoke tests passed`);
