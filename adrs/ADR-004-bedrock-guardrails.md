---
adr_number: 4
title: Content Filtering via AWS Bedrock Guardrails
status: proposed
date: 2026-04-02
domains:
  - safety
  - bedrock
  - compliance
---

# ADR-004: Content Filtering via AWS Bedrock Guardrails

This ADR records a proposal to filter content with AWS Bedrock Guardrails, configured provider-side with input and output strength settings per category, rather than with an application-layer filter in the orchestration loop. It is **proposed, not adopted**: no guardrail configuration exists in `src/` or `example/`.

## Context

A chat engine exposed to end users can be steered toward harmful content, and can relay harmful content back. Bedrock offers guardrails as a managed control applied to both the prompt and the completion, configurable by category and strength, and reachable independently through the `ApplyGuardrail` API.

## Decision

Proposed, not yet implemented: enable Bedrock guardrails with content-policy filters on the categories the spike names, at HIGH input and output strength, applied to Bedrock calls.

## Rationale

Filtering at the provider is applied to both directions by the same service that runs the model, so it cannot be bypassed by a code path that forgets to call the filter. It is configuration rather than code, and it requires no model of its own.

## Consequences

If adopted: guardrails are Bedrock-specific, so a consumer on Vertex, OpenAI or Anthropic gets nothing from this decision — the engine would have either a filtering seam every provider implements or an accepted asymmetry. Guardrails are separately billed and add latency to every call. False positives on legitimate domain vocabulary are a real cost at HIGH strength and would need tuning against real traffic.

## Alternatives considered

**Application-layer filtering in the orchestrator.** Provider-neutral and testable in-repo, but it is another moving part to maintain, and a filter HAL Engine writes is a filter HAL Engine has to keep current.

**No filtering.** The status quo. Defensible for a library that does not choose its own deployment context, which is why this stays `proposed` and would more properly be the consumer's decision.

## References

- `docs/spikes/spike-ai-response-validation.md` § 8 (AWS Bedrock Guardrails) — the full spike, with the `CreateGuardrailCommand` configuration sketch. This ADR summarises; the spike remains the record.
- Related: [ADR-001](ADR-001-bedrock-converse-api.md), [ADR-002](ADR-002-response-validation.md), [ADR-003](ADR-003-llm-observability.md).
