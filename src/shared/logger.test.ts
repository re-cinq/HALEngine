import {jest} from '@jest/globals';
import {log} from './logger.js';

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
