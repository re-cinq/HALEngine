import {jest} from '@jest/globals';
import {Ajv} from 'ajv';
import {ToolRegistry} from './registry.js';
import {setLogger} from '../../shared/logger.js';

afterEach(() => setLogger(undefined));
afterEach(() => jest.restoreAllMocks());

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
    const received: Record<string, unknown>[] = [];
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'echo',
        description: 'echoes input',
        inputSchema: {type: 'object', required: ['city'], properties: {city: {type: 'string'}}},
      },
      async input => {
        received.push(input);
        return 'ok';
      }
    );

    await registry.execute('echo', {city: 'NYC', extra: 'noise'});

    expect(received).toEqual([{city: 'NYC', extra: 'noise'}]);
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

  it('compiles a static schema once, at register, however many calls follow', async () => {
    const registry = new ToolRegistry();
    const compile = jest.spyOn(Ajv.prototype, 'compile');
    registry.register(
      {name: 'count', description: 'counts calls', inputSchema: {type: 'object', properties: {n: {type: 'number'}}}},
      async () => 'counted'
    );

    await Promise.all(Array.from({length: 10}, (_, n) => registry.execute('count', {n})));

    expect(compile).toHaveBeenCalledTimes(1);
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

describe('ToolRegistry.execute — a tool name the model invented', () => {
  it('answers an unregistered name with a result naming it and every registered tool, instead of throwing', async () => {
    const response = await registryWith('get_weather', 'list_locations').execute('nope', {});

    const absent = ['nope', 'get_weather', 'list_locations'].filter(name => !response.result.includes(name));
    expect({response, absent}).toEqual({response: {result: expect.any(String)}, absent: []});
  });

  it('says that no tools are registered when the registry is empty, ending in no empty list', async () => {
    const {result} = await new ToolRegistry().execute('nope', {});

    expect(result).toBe("There is no tool named 'nope', and no tools are registered.");
  });

  it('bounds an invented name to 64 characters in its answer and in its one warn line, under tool', async () => {
    const lines = recordLog();

    const {result} = await registryWith('get_weather').execute('x'.repeat(200), {});

    const longestRun = Math.max(...(result.match(/x+/g) ?? ['']).map(run => run.length));
    expect({longestRun, warns: lines.warn}).toEqual({
      longestRun: 64,
      warns: [{category: 'tool', message: 'tool not found', name: 'x'.repeat(64)}],
    });
  });
});

describe('ToolRegistry.execute — an executor that throws', () => {
  it('answers an executor that rejects with a result naming the tool, never the thrown message', async () => {
    const response = await throwing('get_weather', new Error('ECONNREFUSED 10.0.0.4:8080')).execute('get_weather', {});

    const leaks = ['ECONNREFUSED', '10.0.0.4'].filter(text => response.result.includes(text));
    expect({response, leaks}).toEqual({response: {result: expect.stringContaining('get_weather')}, leaks: []});
  });

  it('answers a throw of any shape alike: a string, undefined, a plain object, an object with no prototype', async () => {
    const thrown: unknown[] = ['boom', undefined, {code: 500}, Object.create(null)];

    const responses = await Promise.all(thrown.map(value => throwing('get_weather', value).execute('get_weather', {})));

    expect(responses).toEqual(thrown.map(() => ({result: 'The get_weather tool failed and returned no result.'})));
  });

  it('logs a throw once, at error under tool, with the tool name and error type, its message cut to 500 characters', async () => {
    const lines = recordLog();

    await throwing('get_weather', new TypeError('y'.repeat(2000))).execute('get_weather', {});

    expect(lines.error).toEqual([
      {
        category: 'tool',
        message: 'tool executor threw',
        name: 'get_weather',
        errorType: 'TypeError',
        error: 'y'.repeat(500),
      },
    ]);
  });

  it('logs a throw after its signal was aborted, not timed out, at info as tool call abandoned, and no error line', async () => {
    const lines = recordLog();

    await failWith(AbortSignal.abort());

    expect({info: lines.info, error: lines.error}).toEqual({
      info: [
        {category: 'tool', message: 'executing', name: 'get_weather', inputKeys: []},
        {category: 'tool', message: 'tool call abandoned', name: 'get_weather', errorType: 'TypeError'},
      ],
      error: [],
    });
  });

  it('logs a throw as abandoned after a signal aborted with a reason that is no error, a string or null', async () => {
    const lines = recordLog();

    await failWith(AbortSignal.abort('socket closed'));
    await failWith(AbortSignal.abort(null));

    const abandoned = lines.info.filter(line => line.message === 'tool call abandoned');
    expect({abandoned: abandoned.length, error: lines.error}).toEqual({abandoned: 2, error: []});
  });

  it('keeps a throw at error as tool executor threw while its signal is live and after it timed out', async () => {
    const lines = recordLog();

    await failWith(new AbortController().signal);
    await failWith(
      AbortSignal.abort(new DOMException("Tool 'get_weather' did not answer within 30000 ms", 'TimeoutError'))
    );

    const threw = {category: 'tool', message: 'tool executor threw', name: 'get_weather', errorType: 'TypeError'};
    expect(lines.error).toEqual([
      {...threw, error: 'fetch failed'},
      {...threw, error: 'fetch failed'},
    ]);
  });
});

describe('ToolRegistry.execute — what reaches the model and the log', () => {
  it('keeps every value of the call input out of the answer and the log, for an invented name and a throwing executor', async () => {
    const lines = recordLog();
    const input = {location: 'Berlin', fullName: 'Ada Example'};

    const invented = await registryWith('get_weather').execute('nope', input);
    const crashed = await throwing('get_weather', new Error('failed')).execute('get_weather', input);

    const everything = [invented.result, crashed.result, ...lines.all].join('\n');
    expect({leaks: ['Berlin', 'Ada'].filter(value => everything.includes(value))}).toEqual({leaks: []});
  });

  it('rejects an input that is not an object whatever the schema, a caller bug, naming its kind and never its value', async () => {
    const permissive = new ToolRegistry();
    permissive.register({name: 'lookup', description: 'Accepts anything.', inputSchema: {}}, async () => 'ok');
    const malformed: unknown[] = [null, undefined, ['a'], 'secret-text'];

    const outcomes = await Promise.all(
      [registryWith('lookup'), permissive].flatMap(registry =>
        malformed.map(input =>
          registry.execute('lookup', input as Record<string, unknown>).then(
            () => 'resolved',
            (error: Error) => `${error.name}: ${error.message}`
          )
        )
      )
    );

    const kinds = ['null', 'undefined', 'an array', 'string'];
    const rejected = kinds.map(kind => `TypeError: Tool 'lookup' needs an object as input, and got ${kind}`);
    expect(outcomes).toEqual([...rejected, ...rejected]);
  });
});

// One registered tool per name, each answering 'ok'.
function registryWith(...names: string[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const name of names) {
    registry.register({name, description: `The ${name} tool.`, inputSchema: {type: 'object'}}, async () => 'ok');
  }
  return registry;
}

// One registered tool whose executor throws `thrown`, whatever its shape.
function throwing(name: string, thrown: unknown): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({name, description: `The ${name} tool.`, inputSchema: {type: 'object'}}, async () => {
    throw thrown;
  });
  return registry;
}

// A get_weather call whose request fails the same way whatever `signal` its context carries, so only the signal decides the log line.
async function failWith(signal: AbortSignal): Promise<void> {
  await throwing('get_weather', new TypeError('fetch failed')).execute('get_weather', {}, {userId: 'u', signal});
}

type LoggedLine = Record<string, unknown>;

// Every line the call logged, and the info, warn and error lines on their own.
function recordLog(): {info: LoggedLine[]; warn: LoggedLine[]; error: LoggedLine[]; all: string[]} {
  const lines = {info: [] as LoggedLine[], warn: [] as LoggedLine[], error: [] as LoggedLine[], all: [] as string[]};
  const into = (level?: 'info' | 'warn' | 'error') => (category: string, message: string, fields?: LoggedLine) => {
    const line = {category, message, ...fields};
    lines.all.push(JSON.stringify(line));
    if (level) lines[level].push(line);
  };
  setLogger({debug: into(), info: into('info'), warn: into('warn'), error: into('error')});
  return lines;
}
