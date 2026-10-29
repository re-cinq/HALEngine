import {validateMessage} from './validation.js';

// One wire name for the client frame: the alias is gone, and the frame the validator returns is the exported shape.

describe('the websocket frame validator', () => {
  it('accepts user_message and returns the frame the exported union describes', () => {
    const result = validateMessage({type: 'user_message', content: 'hello'});

    expect(result).toEqual({valid: true, data: {type: 'user_message', content: 'hello'}});
  });

  it('rejects send_message, which is no longer a wire name', () => {
    const result = validateMessage({type: 'send_message', content: 'hello'});

    expect(result).toEqual({valid: false, error: 'Unknown message type: send_message'});
  });

  it('drops any field the frame does not define, rather than forwarding it', () => {
    const result = validateMessage({type: 'user_message', content: 'hello', chatId: 'c1'});

    expect(result).toEqual({valid: true, data: {type: 'user_message', content: 'hello'}});
  });
  it('accepts list_conversations with no window, and keeps no field the frame does not define', () => {
    const result = validateMessage({type: 'list_conversations', userId: 'someone-else'});

    expect(result).toEqual({valid: true, data: {type: 'list_conversations', limit: undefined, before: undefined}});
  });

  it('accepts a whole-number limit inside the page bound and a cursor carrying both halves', () => {
    const before = {updatedAt: '2026-01-01T00:00:00.000Z', sessionId: 'abc-123'};

    const result = validateMessage({type: 'list_conversations', limit: 200, before});

    expect(result).toEqual({valid: true, data: {type: 'list_conversations', limit: 200, before}});
  });

  it('refuses a limit that is not a whole number from one to two hundred, naming the field', () => {
    const refusals = [0, 201, 1.5, '10', Number.NaN].map(limit => {
      const result = validateMessage({type: 'list_conversations', limit});
      return result.valid ? 'accepted' : result.error;
    });

    const named = 'list_conversations limit must be a whole number from 1 to 200';

    expect(refusals).toEqual([named, named, named, named, named]);
  });

  it('refuses a cursor missing either half, or carrying a time nothing can parse, naming the field', () => {
    const refusals = [
      {updatedAt: '2026-01-01T00:00:00.000Z'},
      {sessionId: 'abc-123'},
      {updatedAt: 'last tuesday', sessionId: 'abc-123'},
      {updatedAt: '2026-01-01T00:00:00.000Z', sessionId: '../etc/passwd'},
      {updatedAt: 1767225600000, sessionId: 'abc-123'},
      'abc-123',
    ].map(before => {
      const result = validateMessage({type: 'list_conversations', before});
      return result.valid ? 'accepted' : result.error;
    });

    const named = 'list_conversations before must carry an ISO updatedAt and a sessionId';

    expect(refusals).toEqual([named, named, named, named, named, named]);
  });

  it('answers a frame naming an inherited member as an unknown type, rather than reaching it', () => {
    const results = ['constructor', '__proto__', 'toString'].map(type => validateMessage({type}));

    expect(results.map(result => result.valid)).toEqual([false, false, false]);
  });

  it('accepts content of exactly 10,000 characters and refuses 10,001, naming the limit', () => {
    const longest = validateMessage({type: 'user_message', content: 'x'.repeat(10_000)});
    const over = validateMessage({type: 'user_message', content: 'x'.repeat(10_001)});

    expect({longest: longest.valid, over}).toEqual({
      longest: true,
      over: {valid: false, error: 'Message content too long (max 10000 chars)'},
    });
  });

  it('refuses content of three spaces as empty', () => {
    const result = validateMessage({type: 'user_message', content: '   '});

    expect(result).toEqual({valid: false, error: 'Message content cannot be empty'});
  });

  it('refuses a frame of type nope, naming the type', () => {
    expect(validateMessage({type: 'nope'})).toEqual({valid: false, error: 'Unknown message type: nope'});
  });

  it('refuses a ping with no timestamp or a text one, and passes a numeric timestamp through unchanged', () => {
    expect({
      missing: validateMessage({type: 'ping'}),
      text: validateMessage({type: 'ping', timestamp: '1705312200000'}),
      numeric: validateMessage({type: 'ping', timestamp: 1705312200000}),
    }).toEqual({
      missing: {valid: false, error: 'ping must have timestamp number'},
      text: {valid: false, error: 'ping must have timestamp number'},
      numeric: {valid: true, data: {type: 'ping', timestamp: 1705312200000}},
    });
  });
});
