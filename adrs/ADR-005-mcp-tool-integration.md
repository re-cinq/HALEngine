---
adr_number: 5
title: MCP Server over HTTP/SSE with a Bedrock Adapter
status: proposed
date: 2026-04-02
domains:
  - tools
  - integration
  - architecture
---

# ADR-005: MCP Server over HTTP/SSE with a Bedrock Adapter

This ADR records a proposal to define tools once against the Model Context Protocol, serve them from a standalone MCP server over HTTP with Server-Sent Events, and bridge them to Bedrock through a translating layer that maps MCP tool definitions onto Bedrock's `toolConfig` format. The aim is that a tool written once works against any model. It is **proposed, not adopted**: there is no `@modelcontextprotocol` dependency in `package.json` and no MCP code in `src/` — tools are registered through the in-repo `ToolRegistry` in `src/orchestration/`.

Note that `docs/spikes/mcp.md` is written in the past tense, as though the server were built. No such code exists in this repository; the document is preserved unchanged as the record of the design, and this ADR carries the corrected status.

## Context

Tool definitions written directly against one provider's format lock the engine to that provider. HAL Engine already solves this for the model call through the `AIProvider` interface, but tool schemas remain a place where a vendor format could leak into the tool layer. MCP is a vendor-neutral standard for exactly this.

## Decision

Proposed, not yet implemented:

- Define tools against MCP with Zod schemas for input validation.
- Serve them from a dedicated MCP server over HTTP/SSE, so multiple agents can connect concurrently and the tools are decoupled from the chat application.
- Bridge to Bedrock with a translating layer, since Bedrock does not speak MCP natively: map `ListToolsResult` onto Bedrock's `toolSpec` shape, and map calls back the other way.

## Rationale

One tool definition serving any model is the same argument that produced the `AIProvider` abstraction, applied a layer out. Running tools as a separate service also decouples their deployment from the chat server.

## Consequences

If adopted: a second deployable service, a network hop on every tool call, and a translation layer to maintain for each provider that does not speak MCP. It would sit alongside or replace `ToolRegistry`, which today registers tools in-process with a `ToolContext` carrying session, user and workspace — an in-process seam an out-of-process MCP server cannot offer without passing that context over the wire.

## Alternatives considered

**The current in-process `ToolRegistry`.** What HAL Engine does today: tools registered with a JSON Schema and an executor, mapped to provider format inside the provider layer, per CLAUDE.md's provider contract. This already keeps provider formats out of the tool definition, which is most of the benefit MCP offers here, without a second service.

## References

- `docs/spikes/mcp.md` §§ 2 (The MCP Server), 4 (The Bridge: Connecting to AWS Bedrock), 5 (Tool Design Best Practices) — the full document. This ADR summarises; the spike remains the record.
- `docs/adding-a-tool.md`, `specs/hal-engine-tool-responses/spec.md` — how tools actually work today.
