import {readdirSync, readFileSync} from 'node:fs';
import {join, relative} from 'node:path';
import {clientErrorFor} from './errorMapping.js';
import {AIError} from '../types/ai.js';
import {ErrorCodes} from '../types/session.js';

const UNAVAILABLE = 'AI service temporarily unavailable';
const TRANSPORT = join(process.cwd(), 'src', 'transport');
// A provider code named in transport source: a quoted literal, a code comparison, or one of the provider ErrorCodes.
const MAPS_A_PROVIDER_CODE =
  /['"](RATE_LIMITED|SERVICE_UNAVAILABLE|TIMEOUT|UPSTREAM_ERROR)['"]|\.code\s*===|ErrorCodes\.(RATE_LIMITED|SERVICE_UNAVAILABLE|TIMEOUT|UPSTREAM_ERROR)/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('TestSupport.ts')
      ? [path]
      : [];
  });
}

describe('the one AIError table', () => {
  it('answers RATE_LIMITED, SERVICE_UNAVAILABLE and TIMEOUT with their own code, status and fixed sentence', () => {
    const answers = ['RATE_LIMITED', 'SERVICE_UNAVAILABLE', 'TIMEOUT'].map(code =>
      clientErrorFor(new AIError('x', code))
    );

    expect(answers).toEqual([
      {code: 'RATE_LIMITED', status: 429, message: 'AI service is busy, please try again'},
      {code: 'SERVICE_UNAVAILABLE', status: 503, message: UNAVAILABLE},
      {code: 'TIMEOUT', status: 504, message: 'AI service timed out'},
    ]);
  });

  it('answers nine other AIError codes and one named constructor from the one fallback row, UPSTREAM_ERROR and 502', () => {
    const codes = [
      'AUTH_ERROR',
      'ACCESS_DENIED',
      'VALIDATION_ERROR',
      'INTERNAL_ERROR',
      'PROVIDER_ERROR',
      'PARSE_ERROR',
      'TOOL_INPUT_PARSE_ERROR',
      'BEDROCK_ERROR',
      'UNKNOWN_ERROR',
      'constructor',
    ];
    const rows = new Set(codes.map(code => clientErrorFor(new AIError('x', code))));

    expect([...rows]).toEqual([{code: 'UPSTREAM_ERROR', status: 502, message: UNAVAILABLE}]);
  });

  it('defines ten ErrorCodes: TOO_MANY_REQUESTS, CREDENTIAL_EXPIRED and the three provider conditions added beside the five the protocol first had', () => {
    expect(Object.keys(ErrorCodes)).toEqual([
      'INVALID_MESSAGE',
      'INVALID_FORMAT',
      'TOO_MANY_REQUESTS',
      'RATE_LIMITED',
      'SERVICE_UNAVAILABLE',
      'TIMEOUT',
      'UPSTREAM_ERROR',
      'SERVER_ERROR',
      'UNSUPPORTED',
      'CREDENTIAL_EXPIRED',
    ]);
  });

  it('is the only non-test file under src/transport that maps a provider error code', () => {
    const mapping = sourceFiles(TRANSPORT)
      .filter(path => MAPS_A_PROVIDER_CODE.test(readFileSync(path, 'utf8')))
      .map(path => relative(process.cwd(), path));

    expect(mapping).toEqual([join('src', 'transport', 'errorMapping.ts')]);
  });
});
