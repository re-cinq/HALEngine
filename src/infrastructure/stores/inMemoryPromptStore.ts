import type {PromptStore, PromptTemplate} from '../../types/promptStore.js';

function substituteVariables(template: string, variables: Record<string, string>): string {
  return Object.entries(variables).reduce((result, [key, value]) => result.replaceAll(`{${key}}`, value), template);
}

export class InMemoryPromptStore implements PromptStore {
  private readonly prompts = new Map<string, PromptTemplate>();

  add(name: string, template: string): void {
    this.prompts.set(name, {name, template});
  }

  async findByName(name: string): Promise<PromptTemplate | undefined> {
    return this.prompts.get(name);
  }

  async resolve(name: string, variables?: Record<string, string>): Promise<string> {
    const prompt = this.prompts.get(name);
    if (!prompt) throw new Error(`Prompt not found: ${name}`);
    if (!variables) return prompt.template;
    return substituteVariables(prompt.template, variables);
  }
}
