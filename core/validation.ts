/** Pure structural validation for model-authored plan operations. */

import type { ToolOp } from "./types.ts";

const SUPPORTED_TOOLS = new Set(["read", "grep", "find", "ls", "bash", "edit", "write"]);

const optionalString = (op: ToolOp, key: string): string | null =>
  op[key] === undefined || typeof op[key] === "string" ? null : `${key} must be a string`;
const optionalNumber = (op: ToolOp, key: string): string | null =>
  op[key] === undefined || (typeof op[key] === "number" && Number.isFinite(op[key])) ? null : `${key} must be a finite number`;
const optionalBoolean = (op: ToolOp, key: string): string | null =>
  op[key] === undefined || typeof op[key] === "boolean" ? null : `${key} must be a boolean`;

/** Validate one operation before any consumer can assume its shape. */
export function validateOperation(operation: unknown): string | null {
  if (typeof operation === "string") return null;
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    return "operation must be a shell string or tool object";
  }
  const op = operation as ToolOp;
  if (typeof op.tool !== "string" || op.tool === "") return "tool operation needs a non-empty string tool";
  if (!SUPPORTED_TOOLS.has(op.tool)) {
    return `unknown tool "${op.tool}" (supported tools: read, grep, find, ls, bash, edit, write)`;
  }
  const requiredString = (key: string): string | null =>
    typeof op[key] === "string" && op[key] !== "" ? null : `${op.tool} requires a non-empty string ${key}`;
  switch (op.tool) {
    case "read":
      return requiredString("path") ?? optionalNumber(op, "offset") ?? optionalNumber(op, "limit");
    case "grep":
      return requiredString("pattern") ?? optionalString(op, "path") ?? optionalString(op, "glob") ??
        optionalBoolean(op, "ignoreCase") ?? optionalBoolean(op, "literal") ?? optionalNumber(op, "context") ??
        optionalNumber(op, "limit");
    case "find":
      return requiredString("pattern") ?? optionalString(op, "path") ?? optionalNumber(op, "limit");
    case "ls":
      return optionalString(op, "path") ?? optionalNumber(op, "limit");
    case "bash":
      return requiredString("command");
    case "edit":
      return requiredString("path") ?? (op.edits !== undefined && !Array.isArray(op.edits) ? "edit edits must be an array" : null);
    case "write":
      return requiredString("path") ?? requiredString("content");
    default:
      return null;
  }
}
