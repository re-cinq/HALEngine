import {Ajv} from 'ajv';
import type {ErrorObject, ValidateFunction} from 'ajv';
import type {ToolDefinition} from '../../types/ai.js';
import type {OutgoingMessage} from '../../types/messages.js';
import {log} from '../../shared/logger.js';

const MAX_NAME_IN_ANSWER = 64;
const MAX_LOGGED_ERROR = 500;

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
  /** Aborted when the orchestrator abandons this call at its `toolTimeoutMs` deadline; pass it to `fetch` so the call's own request stops too. */
  signal?: AbortSignal;
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
  private readonly ajv = new Ajv({allErrors: true});
  private readonly staticValidators = new Map<string, ValidateFunction>();
  private readonly dynamicValidatorCache = new WeakMap<object, ValidateFunction>();

  private resolveDefinition(source: ToolDefinitionSource): ToolDefinition {
    return typeof source === 'function' ? source() : source;
  }

  private compileSchema(schema: Record<string, unknown>, toolName: string): ValidateFunction {
    try {
      return this.ajv.compile(schema);
    } catch (err) {
      throw new Error(`Tool '${toolName}' has an uncompilable inputSchema: ${(err as Error).message}`, {cause: err});
    }
  }

  private getValidator(name: string, tool: StoredTool): ValidateFunction {
    if (typeof tool.definitionSource !== 'function') {
      return this.staticValidators.get(name)!;
    }
    const definition = tool.definitionSource();
    const schema = definition.inputSchema;
    const cached = this.dynamicValidatorCache.get(schema);
    if (cached) return cached;
    const compiled = this.compileSchema(schema, name);
    this.dynamicValidatorCache.set(schema, compiled);
    return compiled;
  }

  register(definition: ToolDefinitionSource, execute: ToolExecutor): void {
    const resolved = this.resolveDefinition(definition);
    if (typeof definition !== 'function') {
      this.staticValidators.set(resolved.name, this.compileSchema(resolved.inputSchema, resolved.name));
    }
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

  /** Resolves for every call the model authored, a throwing executor's too; only a caller's malformed input rejects (specs/hal-engine-tool-executor-throw/spec.md). */
  async execute(name: string, input: Record<string, unknown>, context?: ToolContext): Promise<ToolResponse> {
    const tool = this.tools.get(name);
    if (!tool) return missingTool(name, [...this.tools.keys()]);

    const validate = this.getValidator(name, tool);
    if (!validate(input)) return invalidInput(name, validate.errors ?? []);

    log.info('tool', 'executing', {name, inputKeys: Object.keys(input)});
    try {
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
    } catch (error) {
      return crashed(name, error);
    }
  }
}

// Names each failing path and its constraint but never the value, so the model can correct the call.
function invalidInput(name: string, errors: ErrorObject[]): ToolResponse {
  const message = errors.map(e => `${e.instancePath || '(root)'} ${e.message}`).join('; ');
  log.warn('tool', 'input validation failed', {name, paths: errors.map(e => e.instancePath)});
  return {result: `Tool '${name}' input invalid: ${message}`};
}

// A name the model invented is its mistake to correct, so it is answered, bounded, with nothing from the call's input.
function missingTool(name: string, registered: string[]): ToolResponse {
  const attempted = name.slice(0, MAX_NAME_IN_ANSWER);
  log.warn('tool', 'tool not found', {name: attempted});
  if (registered.length === 0) return {result: `There is no tool named '${attempted}', and no tools are registered.`};
  return {result: `There is no tool named '${attempted}'. The available tools are: ${registered.join(', ')}.`};
}

// The model learns only that the call failed: a thrown message can carry a host name or another user's identifier.
function crashed(name: string, error: unknown): ToolResponse {
  log.error('tool', 'tool executor threw', {
    name,
    errorType: error instanceof Error ? error.name : typeof error,
    error: describeThrow(error).slice(0, MAX_LOGGED_ERROR),
  });
  return {result: `The ${name} tool failed and returned no result.`};
}

// A probe, not a fallback path: an object with no prototype has no string form, and the log must not throw for it.
function describeThrow(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return typeof error;
  }
}
