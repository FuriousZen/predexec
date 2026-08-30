/** Pure structural validation for model-authored plan operations. */

import {
  MAX_COMMAND_LENGTH,
  MAX_FIND_RESULTS,
  MAX_GREP_CONTEXT,
  MAX_GREP_PATTERN_LENGTH,
  MAX_GREP_RESULTS,
  MAX_LS_ENTRIES,
  MAX_READ_LINES,
  type ToolOp,
} from "./types.ts";

const SUPPORTED_TOOLS = new Set(["read", "grep", "find", "ls", "bash", "edit", "write"]);

const optionalString = (op: ToolOp, key: string): string | null =>
  op[key] === undefined || typeof op[key] === "string" ? null : `${key} must be a string`;
const boundedInteger = (op: ToolOp, key: string, min: number, max: number): string | null => {
  if (op[key] === undefined) return null;
  if (typeof op[key] !== "number" || !Number.isSafeInteger(op[key])) return `${key} must be an integer`;
  if (op[key] < min) return `${key} must be ${min === 0 ? "a non-negative" : "a positive"} integer`;
  if (op[key] > max) return `${key} must be at most ${max}`;
  return null;
};
const optionalBoolean = (op: ToolOp, key: string): string | null =>
  op[key] === undefined || typeof op[key] === "boolean" ? null : `${key} must be a boolean`;
const stringLength = (op: ToolOp, key: string, max = MAX_COMMAND_LENGTH): string | null =>
  typeof op[key] === "string" && op[key].length > max
    ? `${key} exceeds the maximum length of ${max} characters`
    : null;

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
  const checkedString = (...keys: string[]): string | null => keys.map((key) => stringLength(op, key)).find(Boolean) ?? null;
  switch (op.tool) {
    case "read":
      return requiredString("path") ?? checkedString("path") ?? boundedInteger(op, "offset", 1, Number.MAX_SAFE_INTEGER) ?? boundedInteger(op, "limit", 1, MAX_READ_LINES);
    case "grep":
      return requiredString("pattern") ?? stringLength(op, "pattern", MAX_GREP_PATTERN_LENGTH) ?? checkedString("path", "glob") ?? optionalString(op, "path") ?? optionalString(op, "glob") ??
        optionalBoolean(op, "ignoreCase") ?? optionalBoolean(op, "literal") ?? boundedInteger(op, "context", 0, MAX_GREP_CONTEXT) ??
        boundedInteger(op, "limit", 1, MAX_GREP_RESULTS);
    case "find":
      return requiredString("pattern") ?? checkedString("pattern", "path") ?? optionalString(op, "path") ?? boundedInteger(op, "limit", 1, MAX_FIND_RESULTS);
    case "ls":
      return checkedString("path") ?? optionalString(op, "path") ?? boundedInteger(op, "limit", 1, MAX_LS_ENTRIES);
    case "bash":
      return requiredString("command") ?? checkedString("command");
    case "edit":
      return requiredString("path") ?? checkedString("path") ?? (op.edits !== undefined && !Array.isArray(op.edits) ? "edit edits must be an array" : null);
    case "write":
      return requiredString("path") ?? requiredString("content") ?? checkedString("path", "content");
    default:
      return null;
  }
}
