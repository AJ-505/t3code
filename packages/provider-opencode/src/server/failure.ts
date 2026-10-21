import type { OrchestrationV2ProviderFailureClass } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

const RATE_LIMIT_STATUS = 429;
const BALANCE_EXHAUSTED_STATUS = 402;
const PERMISSION_STATUSES: ReadonlySet<number> = new Set([401, 403]);
const VALIDATION_STATUSES: ReadonlySet<number> = new Set([400, 404, 409, 422]);
const RESET_HEADERS: ReadonlyArray<string> = [
  "retry-after",
  "x-ratelimit-reset",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
  "x-ratelimit-reset-after",
];
const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i;
const DURATION_UNITS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};
const RATE_LIMIT_TEXT = /\b(?:rate limit|usage limit|quota|key limit|too many requests)\b/i;
const RATE_LIMIT_TYPES: ReadonlySet<string> = new Set([
  "provider.quota",
  "provider.rate-limit",
  "RateLimitError",
]);
const AUTH_TYPES: ReadonlySet<string> = new Set(["provider.auth", "ProviderAuthError"]);
const VALIDATION_TYPES: ReadonlySet<string> = new Set([
  "provider.content-filter",
  "provider.invalid-output",
  "provider.invalid-request",
  "provider.unsupported-operation",
  "ContextOverflowError",
]);
const TRANSPORT_TYPES: ReadonlySet<string> = new Set([
  "provider.connect",
  "provider.timeout",
  "provider.transport",
]);

export interface OpenCodeProviderFault {
  readonly class: OrchestrationV2ProviderFailureClass;
  readonly retryable: boolean | null;
  readonly resetAt: string | null;
}

interface OpenCodeFaultFields {
  readonly status: number | undefined;
  readonly type: string | undefined;
  readonly message: string | undefined;
  readonly headers: unknown;
  readonly body: string | undefined;
  readonly retryable: boolean | undefined;
}

function readValue(input: unknown, key: string): unknown {
  return typeof input === "object" && input !== null && key in input
    ? (input as Record<string, unknown>)[key]
    : undefined;
}

function readNested(input: unknown, ...keys: ReadonlyArray<string>): unknown {
  let current: unknown = input;
  for (const key of keys) {
    current = readValue(current, key);
    if (current === undefined) return undefined;
  }
  return current;
}

function readString(input: unknown, ...keys: ReadonlyArray<string>): string | undefined {
  const value = readNested(input, ...keys);
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readNumber(input: unknown, ...keys: ReadonlyArray<string>): number | undefined {
  const value = readNested(input, ...keys);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(input: unknown, ...keys: ReadonlyArray<string>): boolean | undefined {
  const value = readNested(input, ...keys);
  return typeof value === "boolean" ? value : undefined;
}

/**
 * The v1 protocol reports provider faults as a tagged error union with the
 * status code and response headers on `data`. The v2 protocol reports a
 * structured error with the status code beside the message and the provider
 * response body. Both are read here so one classifier serves both adapters.
 */
function faultFields(error: unknown): OpenCodeFaultFields {
  const v1Data = readValue(error, "data");
  return {
    status: readNumber(error, "status") ?? readNumber(v1Data, "statusCode"),
    type: readString(error, "type") ?? readString(error, "name"),
    message: readString(error, "message") ?? readString(v1Data, "message"),
    headers: readValue(v1Data, "responseHeaders"),
    body: readString(error, "response", "body"),
    retryable: readBoolean(v1Data, "isRetryable"),
  };
}

function isoFromEpochMillis(epochMillis: number): string | null {
  const made = DateTime.make(epochMillis);
  return Option.isNone(made) ? null : DateTime.formatIso(made.value);
}

function isoFromDateString(value: string): string | null {
  const made = DateTime.make(value);
  return Option.isNone(made) ? null : DateTime.formatIso(made.value);
}

function parseResetHeader(
  header: string,
  value: string,
  nowEpochMillis: number,
): string | null {
  const duration = DURATION_PATTERN.exec(value);
  if (duration !== null) {
    const amount = Number(duration[1]);
    const unit = DURATION_UNITS[duration[2]?.toLowerCase() ?? ""];
    if (Number.isFinite(amount) && unit !== undefined) {
      return isoFromEpochMillis(nowEpochMillis + amount * unit);
    }
  }
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) {
    const relative = header === "retry-after" || header === "x-ratelimit-reset-after";
    return isoFromEpochMillis(relative ? nowEpochMillis + asNumber * 1_000 : asNumber * 1_000);
  }
  return isoFromDateString(value);
}

function resetAtFromHeaders(headers: unknown, nowEpochMillis: number): string | null {
  if (headers === undefined) return null;
  for (const header of RESET_HEADERS) {
    const raw = readString(headers, header);
    if (raw === undefined) continue;
    const parsed = parseResetHeader(header, raw, nowEpochMillis);
    if (parsed !== null) return parsed;
  }
  return null;
}

function resetAtFromBody(body: string | undefined): string | null {
  if (body === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const candidates = [
    readNested(parsed, "error", "metadata", "reset_at"),
    readNested(parsed, "error", "reset_at"),
    readNested(parsed, "reset_at"),
    readNested(parsed, "error", "metadata", "resetAfter"),
    readNested(parsed, "error", "resetAfter"),
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.trim().length === 0) continue;
    const parsedDate = isoFromDateString(candidate);
    if (parsedDate !== null) return parsedDate;
  }
  return null;
}

export function readOpenCodeResetAt(
  fields: OpenCodeFaultFields,
  nowEpochMillis: number,
): string | null {
  return resetAtFromHeaders(fields.headers, nowEpochMillis) ?? resetAtFromBody(fields.body);
}

/**
 * The orchestration layer routes on the failure class: a `usage_limit`
 * failure arms the recovery worker that resumes the thread once the quota
 * window resets, while a `provider_error` failure ends the run. Reporting
 * every provider fault as `provider_error` therefore turns a throttled turn
 * into a dead thread.
 *
 * OpenCode types an empty balance as `provider.quota` too, but it answers
 * that with HTTP 402. A 402 balance does not reset on a window, so it is not
 * a usage limit and must not arm the recovery worker.
 */
export function classifyOpenCodeProviderFault(input: {
  readonly error: unknown;
  readonly message: string;
  readonly nowEpochMillis: number;
}): OpenCodeProviderFault {
  const fields = faultFields(input.error);
  const message = input.message.length > 0 ? input.message : (fields.message ?? "");
  const type = fields.type ?? "";
  const status = fields.status;

  if (AUTH_TYPES.has(type) || (status !== undefined && PERMISSION_STATUSES.has(status))) {
    return { class: "permission_error", retryable: false, resetAt: null };
  }

  if (status === BALANCE_EXHAUSTED_STATUS) {
    return { class: "provider_error", retryable: false, resetAt: null };
  }

  if (
    status === RATE_LIMIT_STATUS ||
    RATE_LIMIT_TYPES.has(type) ||
    RATE_LIMIT_TEXT.test(message)
  ) {
    return {
      class: "usage_limit",
      // A 429 is a window that opens again, so the turn can be retried. A
      // quota without a status has no known window, which is what the other
      // adapters report.
      retryable: status === RATE_LIMIT_STATUS ? true : null,
      resetAt: readOpenCodeResetAt(fields, input.nowEpochMillis),
    };
  }

  if (VALIDATION_TYPES.has(type) || (status !== undefined && VALIDATION_STATUSES.has(status))) {
    return { class: "validation_error", retryable: false, resetAt: null };
  }

  if (TRANSPORT_TYPES.has(type) || (status !== undefined && status >= 500)) {
    return { class: "transport_error", retryable: true, resetAt: null };
  }

  if (fields.retryable !== undefined) {
    return {
      class: fields.retryable ? "transport_error" : "provider_error",
      retryable: fields.retryable,
      resetAt: null,
    };
  }

  return { class: "provider_error", retryable: null, resetAt: null };
}
