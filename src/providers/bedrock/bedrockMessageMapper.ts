import type {ToolConfiguration, Tool, Message as BedrockMessage} from '@aws-sdk/client-bedrock-runtime';
import type {DocumentType} from '@smithy/types';
import type {Message, ToolCallContent, ToolResultContent, ToolDefinition} from '../../types/ai.js';
export function mapMessage(m: Message): BedrockMessage {
  if (typeof m.content === 'string') {
    return {role: m.role, content: [{text: m.content}]};
  }
  return {role: m.role, content: m.content.map(mapContentBlock)};
}

function mapContentBlock(block: ToolCallContent | ToolResultContent) {
  return block.type === 'tool_use' ? mapToolUseBlock(block) : mapToolResultBlock(block);
}

function mapToolUseBlock(block: ToolCallContent) {
  return {toolUse: {toolUseId: block.toolUseId, name: block.name, input: block.input as DocumentType}};
}

function mapToolResultBlock(block: ToolResultContent) {
  return {toolResult: {toolUseId: block.toolUseId, content: [{text: block.content}]}};
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
