import type {ToolConfiguration, Tool, Message as BedrockMessage} from '@aws-sdk/client-bedrock-runtime';
import type {DocumentType} from '@smithy/types';
import type {Message, ToolCallContent, ToolResultContent, ToolDefinition} from '../../types/ai.js';
/** What the target model accepts on the wire; a field Bedrock documents for some models only is sent to those alone. */
export interface BedrockWire {
  toolResultStatus: boolean;
}

const NO_STATUS: BedrockWire = {toolResultStatus: false};

// Bedrock documents toolResult.status for Amazon Nova and Anthropic Claude 3 and 4 models only, so only those ids get it.
const TOOL_RESULT_STATUS_MODELS = /anthropic\.claude-(3|(opus|sonnet|haiku)-4)|amazon\.nova-/;

/** Whether Bedrock documents `toolResult.status` for this model id, inference-profile prefixes and ARNs included. */
export function supportsToolResultStatus(modelId: string): boolean {
  return TOOL_RESULT_STATUS_MODELS.test(modelId);
}

export function mapMessage(m: Message, wire: BedrockWire = NO_STATUS): BedrockMessage {
  if (typeof m.content === 'string') {
    return {role: m.role, content: [{text: m.content}]};
  }
  return {role: m.role, content: m.content.map(block => mapContentBlock(block, wire))};
}

function mapContentBlock(block: ToolCallContent | ToolResultContent, wire: BedrockWire) {
  return block.type === 'tool_use' ? mapToolUseBlock(block) : mapToolResultBlock(block, wire);
}

function mapToolUseBlock(block: ToolCallContent) {
  return {toolUse: {toolUseId: block.toolUseId, name: block.name, input: block.input as DocumentType}};
}

// The literal, not the SDK's ToolResultStatus: that is a value import, and this module must import the optional peer as types only.
function mapToolResultBlock(block: ToolResultContent, wire: BedrockWire) {
  const status = block.isError === true && wire.toolResultStatus ? {status: 'error' as const} : {};
  return {toolResult: {toolUseId: block.toolUseId, content: [{text: block.content}], ...status}};
}

export function mapToolConfig(tools: ToolDefinition[]): ToolConfiguration {
  return {
    tools: tools.map((t): Tool.ToolSpecMember => ({
      toolSpec: {
        name: t.name,
        description: t.description,
        inputSchema: {json: t.inputSchema as DocumentType},
      },
    })),
  };
}
