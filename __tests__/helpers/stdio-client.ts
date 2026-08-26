/**
 * Shared stdio JSON-RPC test client for spawning `predexec-mcp` (or the packed
 * equivalent) as a real child process and driving it over stdin/stdout.
 *
 * Both server.test.ts and pack.test.ts used to hand-roll this ~140-line
 * client independently. The newline-buffering and id-matching logic below is
 * kept verbatim from server.test.ts's original inline version — do not
 * "clean it up" without re-reading why: JSON.parse is deliberately NOT
 * try/caught around a line, because a stdio MCP server's stdout carries the
 * protocol only (see CLAUDE.md "mcp/server.ts must never write to stdout") —
 * a line that fails to parse as JSON is a real bug in the server under test,
 * not something to swallow.
 *
 * Two behaviors are superset in from pack.test.ts's independent version, and
 * are always-on (they cost nothing when a caller's test never exercises
 * them): raw stdout chunks are always recorded (server.test.ts used this to
 * assert "every stdout chunk parses as JSON"), and stderr is always
 * accumulated with pending requests rejected on unexpected child exit/error
 * (pack.test.ts used this so a crashed child fails fast with useful output
 * instead of hanging a `request()` promise forever).
 */
import { spawn } from "node:child_process";

type Json = Record<string, any>;

export interface McpTestClient {
  request(method: string, params?: unknown): Promise<any>;
  notify(method: string, params?: unknown): void;
  rawStdoutChunks: string[];
  stderr(): string;
  kill(): void;
}

export function spawnMcpClient(
  binPath: string,
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv; nodeArgs?: string[] },
): McpTestClient {
  const child = spawn(process.execPath, [...(opts?.nodeArgs ?? []), binPath], {
    cwd: opts?.cwd,
    env: { ...process.env, ...opts?.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pending = new Map<number, { resolve: (msg: Json) => void; reject: (err: Error) => void }>();
  let nextId = 1;
  let buffer = "";
  const rawStdoutChunks: string[] = [];
  let stderrBuf = "";
  let killed = false;

  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    stderrBuf += chunk;
  });

  child.on("error", (err) => {
    for (const { reject } of pending.values()) reject(err);
    pending.clear();
  });

  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      for (const { reject } of pending.values()) {
        reject(new Error(`child process exited with code ${code}: ${stderrBuf}`));
      }
      pending.clear();
    }
  });

  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    rawStdoutChunks.push(chunk);
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (typeof msg.id === "number" && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) {
          reject(new Error(`JSON-RPC error response: ${JSON.stringify(msg.error)}`));
        } else {
          resolve(msg);
        }
      }
    }
  });

  const request = (method: string, params?: unknown): Promise<Json> => {
    const id = nextId++;
    const answered = new Promise<Json>((resolve, reject) => pending.set(id, { resolve, reject }));
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n");
    return answered;
  };

  const notify = (method: string, params?: unknown): void => {
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }) + "\n");
  };

  const kill = (): void => {
    if (killed) return;
    killed = true;
    child.kill("SIGTERM");
  };

  return { request, notify, rawStdoutChunks, stderr: () => stderrBuf, kill };
}
