import type {ToolDefinition} from '../../types/ai.js';
import type {OutgoingMessage} from '../../types/messages.js';
import {log} from '../../shared/logger.js';

export interface ToolResponse {
  result: string;
  clientMessages?: OutgoingMessage[];
  suppressAssistantResponse?: boolean;
}

export interface ToolContext {
  userId: string | number;
  sessionId?: string;
  workspaceId?: string | number;
  authHeaders?: {
    cookie?: string;
    authorization?: string;
    host?: string;
  };
}

export type ToolExecutor = (input: Record<string, unknown>, context?: ToolContext) => Promise<string | ToolResponse>;

export function normalizeToolResponse(response: string | ToolResponse): ToolResponse {
  return typeof response === 'string' ? {result: response} : response;
}

export type ToolDefinitionSource = ToolDefinition | (() => ToolDefinition);

export interface RegisteredTool {
  definition: ToolDefinition;
  execute: ToolExecutor;
}

interface StoredTool {
  definitionSource: ToolDefinitionSource;
  execute: ToolExecutor;
}

export class ToolRegistry {
  private readonly tools = new Map<string, StoredTool>();

  private resolveDefinition(source: ToolDefinitionSource): ToolDefinition {
    return typeof source === 'function' ? source() : source;
  }

  register(definition: ToolDefinitionSource, execute: ToolExecutor): void {
    const resolved = this.resolveDefinition(definition);
    this.tools.set(resolved.name, {definitionSource: definition, execute});
  }

  get(name: string): RegisteredTool | undefined {
    const tool = this.tools.get(name);
    if (!tool) return undefined;
    return {definition: this.resolveDefinition(tool.definitionSource), execute: tool.execute};
  }

  getDefinitions(): ToolDefinition[] {
    return [...this.tools.values()].map(t => this.resolveDefinition(t.definitionSource));
  }

  getPromptInstructions(): string[] {
    return this.getDefinitions()
      .filter(t => t.promptInstructions)
      .map(t => `${t.name}: ${t.promptInstructions}`);
  }

  getExamplePrompts(): string[] {
    return this.getDefinitions().flatMap(t => t.examplePrompts ?? []);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async execute(name: string, input: Record<string, unknown>, context?: ToolContext): Promise<ToolResponse> {
    const tool = this.tools.get(name);
    if (!tool) {
      log.warn('tool', 'tool not found', {name});
      throw new Error(`Unknown tool: ${name}`);
    }
    log.info('tool', 'executing', {name, inputKeys: Object.keys(input)});
    const rawResult = await tool.execute(input, context);
    const response = normalizeToolResponse(rawResult);
    log.info('tool', 'execution complete', {
      name,
      rawType: typeof rawResult,
      clientMessageCount: response.clientMessages?.length ?? 0,
      clientMessageTypes: response.clientMessages?.map(m => m.type) ?? [],
      suppressAssistantResponse: response.suppressAssistantResponse ?? false,
    });
    return response;
  }
}
