import {InMemoryPromptStore} from './inMemoryPromptStore.js';

describe('InMemoryPromptStore', () => {
  let store: InMemoryPromptStore;

  beforeEach(() => {
    store = new InMemoryPromptStore();
  });

  describe('findByName', () => {
    it('returns prompt template when found', async () => {
      store.add('greeting', 'Hello {name}!');
      const result = await store.findByName('greeting');
      expect(result).toEqual({name: 'greeting', template: 'Hello {name}!'});
    });

    it('returns undefined when not found', async () => {
      expect(await store.findByName('nonexistent')).toBeUndefined();
    });
  });

  describe('resolve', () => {
    it('returns template without substitution when no variables', async () => {
      store.add('static', 'No variables here');
      expect(await store.resolve('static')).toBe('No variables here');
    });

    it('substitutes single variable', async () => {
      store.add('greeting', 'Hello {name}!');
      expect(await store.resolve('greeting', {name: 'Alice'})).toBe('Hello Alice!');
    });

    it('substitutes multiple variables', async () => {
      store.add('evaluation', 'Question: {question}\nAnswer: {answer}');
      const result = await store.resolve('evaluation', {
        question: 'What is AI?',
        answer: 'Artificial Intelligence',
      });
      expect(result).toBe('Question: What is AI?\nAnswer: Artificial Intelligence');
    });

    it('substitutes all occurrences of same variable', async () => {
      store.add('repeat', '{name} said hi. {name} waved.');
      expect(await store.resolve('repeat', {name: 'Bob'})).toBe('Bob said hi. Bob waved.');
    });

    it('leaves unmatched placeholders intact', async () => {
      store.add('partial', 'Hello {name}, your {role} is ready');
      expect(await store.resolve('partial', {name: 'Alice'})).toBe('Hello Alice, your {role} is ready');
    });

    it('throws when prompt not found', async () => {
      await expect(store.resolve('missing')).rejects.toThrow('Prompt not found: missing');
    });
  });
});
