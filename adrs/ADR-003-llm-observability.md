---
adr_number: 3
title: LLM Observability via Dash0 and OpenLLMetry
status: proposed
date: 2026-04-02
domains:
  - observability
  - operations
  - aws
---

# ADR-003: LLM Observability via Dash0 and OpenLLMetry

This ADR records a proposal to trace AI calls with OpenLLMetry, exporting to Dash0 over OpenTelemetry, while keeping CloudWatch for AWS-native metrics and alarms. The split is deliberate: LLM traces need span attributes that a generic metrics backend has no vocabulary for — prompt, completion, token counts, tool calls — while cost and throttling alarms belong where the AWS bill and the Bedrock quotas already live. It is **proposed, not adopted**: `src/` contains no OpenTelemetry, Dash0 or CloudWatch integration.

## Context

Debugging a wrong answer after the fact requires knowing what was sent, what came back, which tools were called and what they returned. Without that record, a failure report is unactionable. Separately, Bedrock's cost and throttling risks — both rated high in the Bedrock spike — need alarms, and those are AWS-side concerns.

## Decision

Proposed, not yet implemented:

- Instrument AI calls with OpenLLMetry, which emits OpenTelemetry spans carrying LLM-specific attributes, and export to Dash0.
- Keep CloudWatch for AWS-native metrics, log groups and alarms, including the cost and throttling alarms the Bedrock spike calls for.
- Truncate or omit prompt and response content in logs. The Bedrock spike is explicit that full prompts and responses must never be logged, on PII grounds.

## Rationale

OpenTelemetry keeps the instrumentation vendor-neutral, so the backend can change without re-instrumenting. Dash0 reads LLM spans natively where a generic metrics store would flatten them. CloudWatch requires no new infrastructure and is already reachable through the IAM role the Bedrock provider uses.

## Consequences

If adopted: an OpenTelemetry dependency in a library whose current runtime dependencies are deliberately minimal (`cookie`, `cookie-parser`, `cors`, `express`, `uuid`, `ws`). For a pluggable engine, instrumentation is better exposed as a seam — the existing `OrchestratorHooks` lifecycle and `UsageStore` are the natural places — than wired in directly, so that a consumer chooses their own backend.

## Alternatives considered

**CloudWatch alone.** Simpler and already available, but it has no LLM span vocabulary, so traces would be unstructured log lines.

**No tracing.** The status quo, and tenable only while the engine is a library rather than an operated service.

## References

- `docs/spikes/spike-ai-response-validation.md` § 7 (Observability Stack) — the full spike, including the CloudWatch integration sketch. This ADR summarises; the spike remains the record.
- Related: [ADR-002](ADR-002-response-validation.md), [ADR-004](ADR-004-bedrock-guardrails.md), from the same spike.
