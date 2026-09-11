export interface PromptBuilderConfig {
  identity: string;
  domainContext?: string;
  responseGuidelines?: string;
  toolPreamble?: string;
}

export interface PromptBuilderOptions {
  toolInstructions?: string[];
  additionalContext?: string;
}

const DEFAULT_TOOL_PREAMBLE = `When users ask questions that relate to available tools, USE THE PROVIDED TOOLS to get accurate, real-time information.

IMPORTANT:
- Always use tools for specific data rather than guessing.
- If a tool call fails, explain the error and offer alternatives.
- Combine tool results with your knowledge to provide comprehensive answers.

CLARIFICATION RULE: If you are unsure which filter to apply or how to interpret the user's request, ASK the user for clarification BEFORE calling the tool.
When a question is clear and maps directly to known filters, proceed without asking.`;

export class PromptBuilder {
  constructor(private readonly config: PromptBuilderConfig) {}

  build(options: PromptBuilderOptions = {}): string {
    const {toolInstructions, additionalContext} = options;
    const parts: string[] = [this.config.identity];

    if (this.config.domainContext) {
      parts.push(this.config.domainContext);
    }

    if (toolInstructions?.length) {
      const preamble = this.config.toolPreamble ?? DEFAULT_TOOL_PREAMBLE;
      const numbered = toolInstructions.map((instruction, i) => `${i + 1}. ${instruction}`).join('\n\n');
      parts.push(`${preamble}\n\n${numbered}`);
    }

    if (this.config.responseGuidelines) {
      parts.push(`Response Guidelines:\n${this.config.responseGuidelines}`);
    }

    if (additionalContext) {
      parts.push(`Additional Context:\n${additionalContext}`);
    }

    return parts.join('\n\n');
  }
}
