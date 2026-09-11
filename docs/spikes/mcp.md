# Building a Modular AI Agent with MCP

> **Status: spike. Nothing here is built.** Reviewed 2026-09-11.
>
> **Shipped.** Nothing from this document. The tool system it motivates does exist — `ToolRegistry`, `ToolDefinition`, `ToolExecutor` in `src/orchestration/tools/` — but tools are registered in-process against that registry, not served over MCP. No MCP client, server or transport is in `src/`.
>
> **Superseded.** §4's bridge from tools to Bedrock is now `src/providers/bedrock/`, which maps tool calls to and from provider format inside the provider layer. That section describes work the architecture has since absorbed.
>
> **Still open.** Integrating MCP as a tool source is [ADR-005](../../adrs/ADR-005-mcp-tool-integration.md), recorded 2026-04-02 and still `proposed`.
>
> Nothing below this block has been changed.


Date: January 15, 2026
Topic: Modular AI Tool Integration

## Overview

We are building a pluggable AI tool system that connects Large Language Models (LLMs) to real-world data sources. Traditionally, connecting an AI to databases or external APIs requires writing custom "glue code" for every different AI provider.

To solve this, we use the **Model Context Protocol (MCP)**. This lets us build our tools once and use them with any AI model. Currently, we are running this with AWS Bedrock, using an adapter to bridge the gap between the new MCP standard and Bedrock's current API. This approach gives us strict type safety, better error handling, and the ability to switch AI models later without rewriting our data tools.

## 1. The Problem

Application data is often fragmented. It lives in different places: databases, weather APIs, search engines, and third-party services. If we want an AI to answer questions like "What is the weather in Berlin?", the AI needs a way to "call" these systems.

Usually, developers hard-code these connections. But that locks you into one vendor. If we define our tools specifically for AWS Bedrock today, we have to rewrite them if we want to test OpenAI or a local model tomorrow.

## 2. Our Solution: The MCP Server

We implemented a standard **MCP Server** using Node.js and TypeScript. Think of this server as a "USB port" for our data -- it doesn't care which computer (or AI) plugs into it, it just provides a standard way to interact.

### 2.1 How it Works

1. **Discovery:** The server tells the AI, "Hey, I know how to get\_weather and search\_database."
2. **Microservice Architecture:** We run this server as a dedicated HTTP service using **Server-Sent Events (SSE)**. This allows multiple users (or multiple AI agents) to connect simultaneously over the network, making the system scalable and decoupled from the main application.
3. **Strict Rules:** We use a library called **Zod** to define the rules for our data. If the AI tries to call a tool with missing data or the wrong data type, our server catches it before it hits the database.

## 3. Implementation: Defining the Tools (HTTP/SSE)

We use express and SSEServerTransport to serve the tools over HTTP. This handles the concurrency required for multiple users.


**src/server.ts**

```ts
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

const server = new McpServer({
  name: "app-tools",
  version: "1.0.0"
});

// TOOL 1: Weather Information
server.tool(
  "get_weather",
  "Get current weather for a location.",
  {
    location: z.string(),
    units: z.enum(["celsius", "fahrenheit"]).optional()
  },
  async ({ location, units }) => {
    // Tool logic...
    return {
      content: [{ type: "text", text: `Weather for ${location}...` }]
    };
  }
);

// TOOL 2: Database Search
server.tool(
  "search_database",
  "Search the application database.",
  {
    query: z.string(),
    category: z.string().optional(),
    max_results: z.number().default(10)
  },
  async ({ query, category, max_results }) => {
    // Tool logic...
    return {
      content: [{ type: "text", text: `Search results for "${query}"...` }]
    };
  }
);

const app = express();

let transport: SSEServerTransport | null = null;

app.get("/sse", async (req, res) => {
  console.log("New MCP connection established");
  transport = new SSEServerTransport("/messages", res);
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  if (transport) {
    await transport.handlePostMessage(req, res);
  }
});

app.listen(3001, () => {
  console.log("MCP Server running on port 3001 via SSE");
});
```

## 4. The Bridge: Connecting to AWS Bedrock

Here is the tricky part: AWS Bedrock doesn't "speak" MCP natively yet. It uses its own format called toolConfig. To fix this, we built a **Backend-for-Frontend (BFF)** that acts as a translator.

### 4.1 Schema Translation

Bedrock needs to understand the tools defined in our MCP server. We use a utility to convert MCP schemas into Bedrock's format.

```ts
import { ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { Tool as BedrockTool } from "@aws-sdk/client-bedrock-runtime";

/**
 * Converts MCP Tool definitions into AWS Bedrock Tool Specification
 */
export function mapMcpToolsToBedrock(mcpTools: ListToolsResult): BedrockTool[] {
  return mcpTools.tools.map((tool) => ({
    toolSpec: {
      name: tool.name,
      description: tool.description,
      inputSchema: {
        json: tool.inputSchema as any // MCP schemas are JSON-Schema compatible
      }
    }
  }));
}
```

### 4.2 The Execution Loop

Our Node.js backend sits between the user and the tools. It handles the "ping-pong" between Bedrock's decision engine and the MCP tool execution.
**Note on Connection:** The mcpClient passed to this executor would now be initialized with SSEClientTransport(new URL("http://localhost:3001/sse")) instead of StdioClientTransport.

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

export class BedrockMcpExecutor {
  private mcpClient: Client;

  constructor(mcpClient: Client) {
    this.mcpClient = mcpClient;
  }

  /**
   * Executes a tool request coming from Bedrock
   * @param userContext - Optional user data (e.g. roles) to check permissions
   */
  async executeTool(toolUseId: string, toolName: string, input: any, userContext?: any): Promise<any> {
    try {
      console.log(`[Executor] Calling tool: ${toolName}`);

      // --- SECURITY CHECK START ---
      const SENSITIVE_TOOLS = ["search_database"]; // Example restricted tool

      if (SENSITIVE_TOOLS.includes(toolName)) {
        if (!userContext || userContext.role !== 'premium') {
            return {
                toolResult: {
                    toolUseId: toolUseId,
                    content: [{ text: "Error: Access Denied. You need a Premium subscription to use this tool." }],
                    status: "error"
                }
            };
        }
      }
      // --- SECURITY CHECK END ---

      const result = await this.mcpClient.callTool({
        name: toolName,
        arguments: input
      });

      return {
        toolResult: {
          toolUseId: toolUseId,
          content: result.content.map(c => ({
            text: c.type === 'text' ? c.text : JSON.stringify(c)
          })),
          status: "success"
        }
      };

    } catch (error: any) {
      return {
        toolResult: {
          toolUseId: toolUseId,
          content: [{ text: `Error executing tool: ${error.message}` }],
          status: "error"
        }
      };
    }
  }
}
```

### 4.3 Context Propagation

Authorization requires the "user context" to travel from the initial API request down to the tool executor. We handle this in the Chat Service layer.

```ts
// src/chat-service.ts (Pseudo-code)

async function handleChatRequest(req: Request, res: Response) {
  // 1. AUTHENTICATION (Who are you?)
  const token = req.headers['authorization'];
  const user = verifyToken(token); // returns { id: "123", role: "free" }

  // 2. PREPARE CONTEXT
  const userContext = {
    userId: user.id,
    role: user.role
  };

  // 3. AI PROVIDER LOOP
  if (providerResponse.stopReason === "tool_use") {
     const result = await executor.executeTool(
        toolId,
        toolName,
        toolInput,
        userContext // <--- Authorization Context passed here
     );
  }
}
```

## 5. Tool Design Best Practices

The AI chooses tools solely based on descriptions. Quality descriptions are critical for performance.

| Type | Best Practice | Bad Example | Good Example |
| :---- | :---- | :---- | :---- |
| **Context** | State **when** to use the tool. | "Get info." | "Use this tool when the user asks for current weather conditions, temperature, or forecast for a specific location." |
| **Output** | State **what** the tool returns. | "Returns data." | "Returns a JSON object with temperature, conditions, humidity, and wind speed." |
| **Constraints** | State what it **cannot** do. | "Finds items." | "Only searches the current database; do not use for historical data queries." |

## 6. Verification: Local Testing Strategy

We can test the MCP server logic completely locally before connecting to AWS, saving on token costs and debugging time.

### Option 1: MCP Inspector (UI)

Testing with SSE requires pointing the inspector to the running server URL.
```
# Start your server first
node dist/server.js
# Then inspect via URL (requires inspector supporting SSE or manual client)
```

### Option 2: Integration Script (HTTP)

```ts
// test/local-test.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

async function runLocalTest() {
  const transport = new SSEClientTransport(new URL("http://localhost:3001/sse"));

  const client = new Client({ name: "tester", version: "1.0" }, { capabilities: {} });
  await client.connect(transport);

  console.log("--- Testing 'get_weather' over HTTP ---");
  // ... rest of the test logic
}
runLocalTest();
```
