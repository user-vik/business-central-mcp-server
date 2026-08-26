// Minimal MCP stdio client, enough to boot a server and read back what it
// advertises. Shared by the smoke test and the bundle build, which both need
// to ask a spawned server what tools it actually registers.

import { spawn } from "node:child_process";

export const DEFAULT_TIMEOUT_MS = 30_000;

// A developer's own BC_*/AZURE_* exports must not leak into the child, or
// results would depend on their local shell.
export function cleanEnv(overrides) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("BC_") && !key.startsWith("AZURE_")) env[key] = value;
  }
  return { ...env, ...overrides };
}

// Completes the MCP handshake and resolves the sorted tool names.
//
// `command` defaults to the current interpreter. A manifest says `"node"`,
// which Claude Desktop resolves to the runtime it ships; mapping that to
// process.execPath is the closest equivalent here and avoids depending on a
// `node` on PATH.
export function listTools({ command = process.execPath, args, env, timeoutMs } = {}) {
  const limit = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      env: cleanEnv(env),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error(`timed out after ${limit}ms\n${stderr}`));
    }, limit);

    const finish = (error, value) => {
      clearTimeout(timer);
      child.kill();
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.on("error", (error) => finish(error));
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        finish(new Error(`server exited with code ${code}\n${stderr}`));
      }
    });

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      // The stdio transport is newline-delimited JSON; the trailing element is
      // a partial line until the next chunk arrives.
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
        clientInfo: { name: "stdio-client", version: "1.0.0" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  });
}

// Runs the server until it exits on its own and returns its stderr. Used for
// the startup-refusal cases, where the process is expected to die during
// module load rather than reach the handshake.
export function runUntilExit({ command = process.execPath, args, env, timeoutMs } = {}) {
  const limit = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      env: cleanEnv(env),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error(`did not exit within ${limit}ms`));
    }, limit);

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stderr });
    });
  });
}
