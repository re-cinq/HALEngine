import {jest} from '@jest/globals';
import {log, setLogger} from './logger.js';

// The line format is the contract: anything reading the stream parses it, and nothing in here reads it back.

interface Line {
  severity: string;
  message: string;
  timestamp: string;
  category: string;
  data?: Record<string, unknown>;
}

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  const outSpy = jest.spyOn(console, 'log').mockImplementation((raw: unknown) => void out.push(String(raw)));
  const errSpy = jest.spyOn(console, 'error').mockImplementation((raw: unknown) => void err.push(String(raw)));

  return {
    out,
    err,
    restore: () => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
};

describe('the logger line format', () => {
  let sink: ReturnType<typeof capture>;

  beforeEach(() => {
    sink = capture();
  });

  afterEach(() => {
    sink.restore();
  });

  it('writes one parseable JSON object per call', () => {
    log.info('ws', 'connected');
    const [raw] = sink.out;

    expect({lines: sink.out.length, newlines: raw.includes('\n')}).toEqual({lines: 1, newlines: false});
  });

  it('carries severity, message, timestamp and category, in that order', () => {
    log.info('ws', 'connected');

    expect(Object.keys(JSON.parse(sink.out[0]) as Line)).toEqual(['severity', 'message', 'timestamp', 'category']);
  });

  it('nests caller fields under data rather than at the top level', () => {
    log.info('ws', 'connected', {sessionId: 's1'});

    const line = JSON.parse(sink.out[0]) as Line;
    expect({keys: Object.keys(line), data: line.data}).toEqual({
      keys: ['severity', 'message', 'timestamp', 'category', 'data'],
      data: {sessionId: 's1'},
    });
  });

  it('cannot have its own keys overwritten by a caller field of the same name', () => {
    log.info('ws', 'connected', {severity: 'DEBUG', message: 'spoofed'});

    const line = JSON.parse(sink.out[0]) as Line;
    expect({severity: line.severity, message: line.message}).toEqual({severity: 'INFO', message: 'connected'});
  });

  it('uses the uppercase level name as severity', () => {
    log.info('ws', 'i');
    log.warn('ws', 'w');
    log.error('ws', 'e');

    const severities = [...sink.out, ...sink.err].map(raw => (JSON.parse(raw) as Line).severity);
    expect(severities).toEqual(['INFO', 'WARN', 'ERROR']);
  });

  it('sends ERROR to stderr and every other level to stdout', () => {
    log.info('ws', 'i');
    log.warn('ws', 'w');
    log.error('ws', 'e');

    expect({stdout: sink.out.length, stderr: sink.err.length}).toEqual({stdout: 2, stderr: 1});
  });

  it('timestamps in ISO-8601 UTC', () => {
    log.info('ws', 'connected');

    const {timestamp} = JSON.parse(sink.out[0]) as Line;
    expect({iso: /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(timestamp), parses: !isNaN(Date.parse(timestamp))}).toEqual({
      iso: true,
      parses: true,
    });
  });

  it('drops a level below the configured threshold before writing anything', () => {
    log.debug('ws', 'noisy');

    expect({stdout: sink.out.length, stderr: sink.err.length}).toEqual({stdout: 0, stderr: 0});
  });
});

// A logger that throws takes down the call site it observes, so the emitter has to survive its own input.
describe('the logger on input it cannot serialise', () => {
  let sink: ReturnType<typeof capture>;

  beforeEach(() => {
    sink = capture();
  });

  afterEach(() => {
    sink.restore();
  });

  const cyclic = () => {
    const value: Record<string, unknown> = {userId: 'u1'};
    value.self = value;
    return value;
  };

  it('does not throw out of the call site it was observing', () => {
    expect(() => log.info('ws', 'connected', cyclic())).not.toThrow();
  });

  it('still writes a parseable line, with the envelope intact and data marked', () => {
    log.info('ws', 'connected', cyclic());

    const line = JSON.parse(sink.out[0]) as Line;
    expect({severity: line.severity, message: line.message, category: line.category, data: line.data}).toEqual({
      severity: 'INFO',
      message: 'connected',
      category: 'ws',
      data: '[unserialisable]: Converting circular structure to JSON',
    });
  });

  it('names the reason a BigInt field could not be written', () => {
    log.info('ws', 'connected', {id: 1n});

    expect((JSON.parse(sink.out[0]) as Line).data).toBe('[unserialisable]: Do not know how to serialize a BigInt');
  });

  it('keeps the degraded line on the stream its severity selects', () => {
    log.error('vertex', 'stream error', cyclic());

    expect({stdout: sink.out.length, stderr: sink.err.length}).toEqual({stdout: 0, stderr: 1});
  });
});

// The config option is the documented route; this is the mechanism underneath it.
describe('swapping the logger', () => {
  afterEach(() => {
    setLogger();
  });

  it('sends lines to a supplied logger instead of the console', () => {
    const sink = capture();
    const seen: unknown[][] = [];
    setLogger({
      debug: (...args: unknown[]) => void seen.push(args),
      info: (...args: unknown[]) => void seen.push(args),
      warn: (...args: unknown[]) => void seen.push(args),
      error: (...args: unknown[]) => void seen.push(args),
    });

    log.info('ws', 'connected', {sessionId: 's1'});
    sink.restore();

    expect({delivered: seen, stdout: sink.out.length}).toEqual({
      delivered: [['ws', 'connected', {sessionId: 's1'}]],
      stdout: 0,
    });
  });

  it('restores the built-in console logger when called with nothing', () => {
    const sink = capture();
    setLogger({debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined});
    setLogger();

    log.info('ws', 'connected');
    sink.restore();

    expect(sink.out.length).toBe(1);
  });
});
