import {ToolRegistry} from './registry.js';
import {setLogger} from '../../shared/logger.js';

afterEach(() => setLogger(undefined));

describe('ToolRegistry.execute — input validation', () => {
  it('returns a ToolResponse naming the missing required field and does not invoke the executor', async () => {
    let executorCalls = 0;
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'weather',
        description: 'get weather',
        inputSchema: {type: 'object', required: ['location'], properties: {location: {type: 'string'}}},
      },
      async () => {
        executorCalls++;
        return 'sunny';
      }
    );

    const toolResponse = await registry.execute('weather', {});

    expect({toolResult: toolResponse.result, executorCalls}).toEqual({
      toolResult: expect.stringMatching(/location/),
      executorCalls: 0,
    });
  });

  it('passes valid input with an extra property through to the executor unchanged', async () => {
    let receivedInput: Record<string, unknown> = {};
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'echo',
        description: 'echoes input',
        inputSchema: {type: 'object', required: ['city'], properties: {city: {type: 'string'}}},
      },
      async input => {
        receivedInput = input;
        return 'ok';
      }
    );

    await registry.execute('echo', {city: 'NYC', extra: 'noise'});

    expect(receivedInput).toEqual({city: 'NYC', extra: 'noise'});
  });

  it('rejects a call whose field type is wrong, naming the field path and expected type but not the value', async () => {
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'notify',
        description: 'sends notification',
        inputSchema: {type: 'object', required: ['email'], properties: {email: {type: 'string'}}},
      },
      async () => 'sent'
    );

    const toolResponse = await registry.execute('notify', {email: 42});

    expect({
      hasFieldName: /email/.test(toolResponse.result),
      hasType: /string/.test(toolResponse.result),
      hasValue: /42/.test(toolResponse.result),
    }).toEqual({hasFieldName: true, hasType: true, hasValue: false});
  });

  it('throws at register time when the inputSchema is uncompilable and the message names the tool', () => {
    const registry = new ToolRegistry();

    expect(() =>
      registry.register(
        {name: 'broken', description: 'broken tool', inputSchema: {type: 'not-a-real-type'}},
        async () => 'x'
      )
    ).toThrow(/broken/);
  });

  it('validates each call against the schema the definition function returns at that call', async () => {
    let schemaVersion = 'first';
    const registry = new ToolRegistry();
    registry.register(
      () => ({
        name: 'versioned',
        description: 'schema changes per call',
        inputSchema:
          schemaVersion === 'first'
            ? {type: 'object', required: ['alpha'], properties: {alpha: {type: 'string'}}}
            : {type: 'object', required: ['beta'], properties: {beta: {type: 'string'}}},
      }),
      async () => 'ok'
    );

    const firstResponse = await registry.execute('versioned', {beta: 'x'});
    schemaVersion = 'second';
    const secondResponse = await registry.execute('versioned', {alpha: 'x'});

    expect({
      firstRejectsAlpha: /alpha/.test(firstResponse.result),
      secondRejectsBeta: /beta/.test(secondResponse.result),
    }).toEqual({firstRejectsAlpha: true, secondRejectsBeta: true});
  });

  it('throws for an unregistered tool name', async () => {
    const registry = new ToolRegistry();

    await expect(registry.execute('ghost', {})).rejects.toThrow('Unknown tool: ghost');
  });

  it('does not include the rejected field value in the returned text or any log line', async () => {
    const capturedLines: string[] = [];
    const capture = (_: string, msg: string, fields?: Record<string, unknown>): void =>
      void capturedLines.push(JSON.stringify({msg, fields}));
    setLogger({debug: capture, info: capture, warn: capture, error: capture});
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'lookup',
        description: 'looks up records',
        inputSchema: {type: 'object', required: ['id'], properties: {id: {type: 'string'}}},
      },
      async () => 'found'
    );

    const toolResponse = await registry.execute('lookup', {id: 99999});
    const allOutput = [toolResponse.result, ...capturedLines].join('\n');

    expect({
      rejectionNamesField: /\bid\b/.test(toolResponse.result),
      hasIdentifyingValue: /99999/.test(allOutput),
    }).toEqual({rejectionNamesField: true, hasIdentifyingValue: false});
  });
});
