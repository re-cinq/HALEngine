import {jest} from '@jest/globals';
import request from 'supertest';
import type {ErrorRequestHandler, Request, Response, Router} from 'express';
import {createApp} from './createApp.js';
import {httpErrorHandler} from './httpErrorHandler.js';
import {InMemorySessionStore} from '../infrastructure/stores/inMemorySessionStore.js';
import {AIError} from '../types/ai.js';
import type {ChatOrchestrator} from '../orchestration/chatOrchestrator.js';
import type {AuthenticatedRequest, HttpAuthMiddleware} from '../types/auth.js';
import {captureErrors} from '../shared/logCaptureTestSupport.js';

const errors = captureErrors();

// An app whose only extra route, GET /hal/boom, fails with `error`; `async` makes it a rejected promise instead.
const failingWith = (error: unknown, options: {async?: boolean; errorHandler?: ErrorRequestHandler} = {}) =>
  createApp({
    errorHandler: options.errorHandler,
    additionalRoutes: (router: Router) => {
      router.get(
        '/boom',
        options.async
          ? async () => {
              throw error;
            }
          : () => {
              throw error;
            }
      );
    },
  });

const signedIn: HttpAuthMiddleware = (req, _res, next) => {
  (req as AuthenticatedRequest).user = {id: 'alice'};
  next();
};

const chatApp = (processMessage: () => Promise<string>) =>
  createApp({
    orchestrator: {processMessage} as unknown as ChatOrchestrator,
    sessionStore: new InMemorySessionStore(),
    authMiddleware: signedIn,
  });

const withStatus = (fields: {status?: number; statusCode?: number}) =>
  Object.assign(new Error('status carrier'), fields);

describe('the default HTTP error handler', () => {
  it('answers a truncated JSON body to POST /hal/chats with 400 {"error":"Bad Request"} as JSON, with no HTML or stack', async () => {
    const response = await request(chatApp(async () => 'reply'))
      .post('/hal/chats')
      .set('content-type', 'application/json')
      .send('{"content": ');

    expect({
      status: response.status,
      type: response.type,
      body: response.body,
      leaks: response.text.includes('<!DOCTYPE html>') || response.text.includes('at '),
    }).toEqual({status: 400, type: 'application/json', body: {error: 'Bad Request'}, leaks: false});
  });

  it('answers a synchronous throw and a rejected promise of boom-secret-42 with 500 {"error":"Internal Server Error"}, keeping the message out of the response', async () => {
    const answers = [];
    for (const async of [false, true]) {
      const response = await request(failingWith(new Error('boom-secret-42'), {async})).get('/hal/boom');
      answers.push({
        status: response.status,
        body: response.body,
        leaked: `${response.text}${JSON.stringify(response.headers)}`.includes('boom-secret-42'),
      });
    }

    expect(answers).toEqual(Array(2).fill({status: 500, body: {error: 'Internal Server Error'}, leaked: false}));
  });

  it('answers AIError codes RATE_LIMITED 429, SERVICE_UNAVAILABLE 503, TIMEOUT 504 and every other code 502, each with its fixed sentence', async () => {
    const unavailable = 'AI service temporarily unavailable';
    const table = [
      {code: 'RATE_LIMITED', status: 429, error: 'AI service is busy, please try again'},
      {code: 'SERVICE_UNAVAILABLE', status: 503, error: unavailable},
      {code: 'TIMEOUT', status: 504, error: 'AI service timed out'},
      ...[
        'BEDROCK_ERROR',
        'AUTH_ERROR',
        'ACCESS_DENIED',
        'VALIDATION_ERROR',
        'PARSE_ERROR',
        'TOOL_INPUT_PARSE_ERROR',
      ].map(code => ({code, status: 502, error: unavailable})),
    ];
    const answers = [];
    for (const {code} of table) {
      const response = await request(failingWith(new AIError('vendor detail', code))).get('/hal/boom');
      answers.push({code, status: response.status, error: (response.body as {error: string}).error});
    }

    expect(answers).toEqual(table);
  });

  it('honours status 404 and statusCode 403 with their standard phrases, and answers status 302, 700 and 499 with 500', async () => {
    const table = [
      {fields: {status: 404}, status: 404, error: 'Not Found'},
      {fields: {statusCode: 403}, status: 403, error: 'Forbidden'},
      {fields: {status: 302}, status: 500, error: 'Internal Server Error'},
      {fields: {status: 700}, status: 500, error: 'Internal Server Error'},
      {fields: {status: 499}, status: 500, error: 'Internal Server Error'},
    ];
    const answers = [];
    for (const {fields} of table) {
      const response = await request(failingWith(withStatus(fields))).get('/hal/boom');
      answers.push({fields, status: response.status, error: (response.body as {error: string}).error});
    }

    expect(answers).toEqual(table);
  });

  it('leaves the response to a consumer errorHandler that answers 418, logging nothing of its own', async () => {
    const teapot: ErrorRequestHandler = (_err, _req, res, _next) => void res.status(418).json({error: 'teapot'});

    const response = await request(failingWith(new Error('handled'), {errorHandler: teapot})).get('/hal/boom');

    expect({status: response.status, body: response.body, defaultLogged: errors.length}).toEqual({
      status: 418,
      body: {error: 'teapot'},
      defaultLogged: 0,
    });
  });

  it('answers 500 {"error":"Internal Server Error"} when a consumer errorHandler passes the error on with next(err) or throws its own, leaking neither error', async () => {
    const passesOn: ErrorRequestHandler = (err, _req, _res, next) => next(err);
    const throwsItsOwn: ErrorRequestHandler = (_err, _req, _res, _next) => {
      throw new Error('handler-secret-7');
    };
    const answers = [];
    for (const errorHandler of [passesOn, throwsItsOwn]) {
      const response = await request(failingWith(new Error('route-secret-3'), {errorHandler})).get('/hal/boom');
      answers.push({
        status: response.status,
        body: response.body,
        leaked: /route-secret-3|handler-secret-7/.test(response.text),
      });
    }

    expect(answers).toEqual(Array(2).fill({status: 500, body: {error: 'Internal Server Error'}, leaked: false}));
  });

  it('adds nothing to a response a route already began with partial before throwing, and logs the error once', async () => {
    const app = createApp({
      additionalRoutes: (router: Router) => {
        router.get('/partial', (_req, res) => {
          res.write('partial');
          throw new Error('after the first byte');
        });
      },
    });

    const body = await new Promise<string>(resolve => {
      const server = app.listen(0, () => {
        const {port} = server.address() as {port: number};
        let received = '';
        fetch(`http://127.0.0.1:${port}/hal/partial`, {signal: AbortSignal.timeout(5000)})
          .then(async response => {
            const reader = response.body?.getReader();
            for (;;) {
              if (!reader) break;
              const {done, value} = await reader.read();
              if (done) break;
              received += new TextDecoder().decode(value);
            }
          })
          .catch(() => undefined)
          .finally(() => server.close(() => resolve(received)));
      });
    });

    expect({body, logged: errors.length}).toEqual({body: 'partial', logged: 1});
  });

  it('logs method, path, status, code, message and stack, and keeps the query string token=abc123 out of every field', async () => {
    await request(chatApp(async () => 'reply'))
      .post('/hal/chats?token=abc123')
      .set('content-type', 'application/json')
      .send('{"content": ');

    const [line] = errors;
    expect({
      line,
      fields: Object.keys(line ?? {}).sort(),
      leaked: JSON.stringify(line).includes('abc123'),
    }).toMatchObject({
      line: {category: 'http', method: 'POST', path: '/hal/chats', status: 400, code: null},
      fields: ['category', 'code', 'message', 'method', 'path', 'stack', 'status'],
      leaked: false,
    });
  });

  it('answers POST /hal/chats/:id/messages with 502 {"error":"AI service temporarily unavailable"} when the orchestrator rejects with a PROVIDER_ERROR', async () => {
    const app = chatApp(
      jest.fn<() => Promise<string>>().mockRejectedValue(new AIError('upstream failed', 'PROVIDER_ERROR'))
    );
    const created = await request(app).post('/hal/chats').send({});

    const response = await request(app)
      .post(`/hal/chats/${(created.body as {id: string}).id}/messages`)
      .send({content: 'hej'});

    expect({status: response.status, body: response.body}).toEqual({
      status: 502,
      body: {error: 'AI service temporarily unavailable'},
    });
  });

  it('hands an error raised after the headers were sent to next and writes nothing more', () => {
    const late = new Error('after the headers');
    const next = jest.fn();
    const status = jest.fn();

    httpErrorHandler(
      late,
      {method: 'GET', path: '/hal/late'} as Request,
      {headersSent: true, status} as unknown as Response,
      next
    );

    const {calls} = status.mock;
    expect({next: next.mock.calls, written: calls.length}).toEqual({next: [[late]], written: 0});
  });
});
