import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { classifyOpenCodeProviderFault } from "./failure.ts";

const NOW = DateTime.makeUnsafe("2026-10-20T12:00:00.000Z");
const NOW_EPOCH_MILLIS = DateTime.toEpochMillis(NOW);

const classify = (error: unknown, message = "") =>
  classifyOpenCodeProviderFault({
    error,
    message,
    nowEpochMillis: NOW_EPOCH_MILLIS,
  });

describe("classifyOpenCodeProviderFault", () => {
  it("classifies a v2 structured 429 as a usage limit", () => {
    const fault = classify({
      type: "RateLimitError",
      message: "Rate limit exceeded. Please try again later.",
      status: 429,
      response: { body: "{}" },
    });
    assert.equal(fault.class, "usage_limit");
    assert.equal(fault.retryable, true);
  });

  it("classifies a v1 tagged 429 as a usage limit", () => {
    const fault = classify({
      name: "APIError",
      data: { message: "Rate limit exceeded.", statusCode: 429 },
    });
    assert.equal(fault.class, "usage_limit");
    assert.equal(fault.retryable, true);
  });

  it.each([
    ["provider.quota", "usage_limit"],
    ["provider.rate-limit", "usage_limit"],
    ["provider.error", "provider_error"],
  ] as const)("classifies a %s failure as %s", (type, expected) => {
    const fault = classify({ type, message: "Provider rejected the request" });
    assert.equal(fault.class, expected);
  });

  it.each([
    "Rate limit exceeded. Please try again later.",
    "Go usage limit exceeded",
    "Key limit exceeded (total limit)",
  ])("classifies %s as a usage limit", (message) => {
    const fault = classify({ type: "UnknownError", message }, message);
    assert.equal(fault.class, "usage_limit");
    assert.equal(fault.retryable, null);
  });

  it("reports a quota without a status as a usage limit with no retry", () => {
    const fault = classify({
      type: "provider.quota",
      message: "Provider rejected the request",
    });
    assert.equal(fault.class, "usage_limit");
    assert.equal(fault.retryable, null);
  });

  it("reads a reset time from the v1 response headers", () => {
    const fault = classify({
      name: "APIError",
      data: {
        message: "Rate limit exceeded.",
        statusCode: 429,
        responseHeaders: { "retry-after": "120" },
      },
    });
    assert.equal(fault.class, "usage_limit");
    assert.equal(fault.resetAt, "2026-10-20T12:02:00.000Z");
  });

  it("reads a reset time from the v2 response body", () => {
    const fault = classify({
      type: "RateLimitError",
      message: "Rate limit exceeded.",
      status: 429,
      response: {
        body: JSON.stringify({ error: { metadata: { reset_at: "2026-10-20T13:00:00.000Z" } } }),
      },
    });
    assert.equal(fault.class, "usage_limit");
    assert.equal(fault.resetAt, "2026-10-20T13:00:00.000Z");
  });

  it.each([
    ["1m", "2026-10-20T12:01:00.000Z"],
    ["90s", "2026-10-20T12:01:30.000Z"],
    ["2h", "2026-10-20T14:00:00.000Z"],
  ])("reads a reset time from the %s duration header form", (duration, expected) => {
    const fault = classify({
      name: "APIError",
      data: {
        message: "Rate limit exceeded.",
        statusCode: 429,
        responseHeaders: { "x-ratelimit-reset-requests": duration },
      },
    });
    assert.equal(fault.class, "usage_limit");
    assert.equal(fault.resetAt, expected);
  });

  it("reads a reset time from an absolute epoch header", () => {
    const resetEpochSeconds = Math.floor(NOW_EPOCH_MILLIS / 1_000) + 300;
    const fault = classify({
      name: "APIError",
      data: {
        message: "Rate limit exceeded.",
        statusCode: 429,
        responseHeaders: { "x-ratelimit-reset": String(resetEpochSeconds) },
      },
    });
    assert.equal(fault.class, "usage_limit");
    assert.equal(fault.resetAt, "2026-10-20T12:05:00.000Z");
  });

  it("reads a reset time from an http date header", () => {
    const fault = classify({
      name: "APIError",
      data: {
        message: "Rate limit exceeded.",
        statusCode: 429,
        responseHeaders: { "retry-after": "2026-10-20T12:30:00.000Z" },
      },
    });
    assert.equal(fault.class, "usage_limit");
    assert.equal(fault.resetAt, "2026-10-20T12:30:00.000Z");
  });

  it("does not treat an empty balance as a usage limit", () => {
    const fault = classify({
      type: "provider.quota",
      message: "Your balance is empty",
      status: 402,
    });
    assert.equal(fault.class, "provider_error");
    assert.equal(fault.retryable, false);
    assert.equal(fault.resetAt, null);
  });

  it.each([401, 403])("classifies %s as a permission error", (status) => {
    const fault = classify({ type: "APIError", message: "Invalid credential", status });
    assert.equal(fault.class, "permission_error");
    assert.equal(fault.retryable, false);
  });

  it("classifies a provider auth error as a permission error", () => {
    const fault = classify({ type: "provider.auth", message: "no key", status: 401 });
    assert.equal(fault.class, "permission_error");
    assert.equal(fault.retryable, false);
  });

  it.each([400, 404, 409, 422])("classifies %s as a validation error", (status) => {
    const fault = classify({
      type: "APIError",
      message: "This model is not available in your country",
      status,
    });
    assert.equal(fault.class, "validation_error");
    assert.equal(fault.retryable, false);
  });

  it("classifies a context overflow as a validation error", () => {
    const fault = classify({ type: "ContextOverflowError", message: "too long", status: 400 });
    assert.equal(fault.class, "validation_error");
    assert.equal(fault.retryable, false);
  });

  it("classifies a server error as a retryable transport error", () => {
    const fault = classify({ type: "APIError", message: "upstream", status: 503 });
    assert.equal(fault.class, "transport_error");
    assert.equal(fault.retryable, true);
  });

  it("classifies a provider timeout as a retryable transport error", () => {
    const fault = classify({ type: "provider.timeout", message: "upstream" });
    assert.equal(fault.class, "transport_error");
    assert.equal(fault.retryable, true);
  });

  it("honours the v1 provider retryable flag", () => {
    const retryable = classify({
      name: "APIError",
      data: { message: "upstream", isRetryable: true },
    });
    assert.equal(retryable.class, "transport_error");
    assert.equal(retryable.retryable, true);

    const permanent = classify({
      name: "APIError",
      data: { message: "upstream", isRetryable: false },
    });
    assert.equal(permanent.class, "provider_error");
    assert.equal(permanent.retryable, false);
  });

  it("falls back to a provider error", () => {
    const fault = classify({ type: "UnknownError", message: "something broke" });
    assert.equal(fault.class, "provider_error");
    assert.equal(fault.retryable, null);
  });

  it("does not name a reset time the provider did not report", () => {
    const fault = classify({
      type: "RateLimitError",
      message: "Rate limit exceeded.",
      status: 429,
    });
    assert.equal(fault.resetAt, null);
  });
});
