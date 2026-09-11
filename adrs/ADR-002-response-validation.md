---
adr_number: 2
title: AI Response Validation and Error Classification
status: proposed
date: 2026-04-02
domains:
  - ai-providers
  - validation
  - observability
---

# ADR-002: AI Response Validation and Error Classification

This ADR records a proposal to validate AI responses with Zod schemas backed by domain-specific sanity checks, and to classify failures through an explicit decision tree that separates a model hallucinating from a data source returning wrong-but-plausible values. The proposal came out of a proof of concept that returned inaccurate data, where the team could not tell whether the model or the upstream API was at fault. It is **proposed, not adopted**: `package.json` carries no `zod` dependency and `src/` contains no validation layer.

## Context

A tool-using chat engine can produce a wrong answer in at least six distinguishable ways, and the mitigation differs for each. Treating them as one undifferentiated "AI got it wrong" category means the team cannot act on a failure report. The spike identified the six as: model hallucination, data source error, tool selection error, tool input error, response format error, and reasoning error.

## Decision

Proposed, not yet implemented:

- Validate structured responses and tool inputs against Zod schemas, so a format error is caught as a format error rather than surfacing as a wrong answer.
- Add domain-specific sanity checks on tool results, since a schema-valid response can still be factually impossible.
- Route failures through the error-source decision tree the spike sets out, which asks in order: is the format valid, were the expected tools called, were the tool inputs valid, does tool output match ground truth, does the response match tool output.

## Rationale

Schema validation is cheap and catches the mechanical failures outright. The remaining classes need the decision tree, because the same observable symptom — a wrong answer — has different causes, and only the ordering of those questions separates them. Distinguishing an AI error from a data error is the specific need the spike was opened to address.

## Consequences

If adopted: a runtime dependency on Zod, schema definitions to maintain alongside the tool registry, and a place in the orchestration layer for validation to live. Sanity checks are domain knowledge, so they cannot ship in a generic engine — they would need to be a pluggable seam, consistent with how `AIProvider` and `SessionStore` already work.

## Alternatives considered

**No validation layer.** The status quo. Acceptable while the engine is generic and the consumer owns correctness, which is why this ADR stays `proposed`.

## References

- `docs/spikes/spike-ai-response-validation.md` §§ Error Classification Framework, 1 (Schema Validation with Zod), 2 (Sanity Checks for Domain Data) — the full spike, with code sketches. This ADR summarises; the spike remains the record.
- Related: [ADR-003](ADR-003-llm-observability.md), [ADR-004](ADR-004-bedrock-guardrails.md), from the same spike.
