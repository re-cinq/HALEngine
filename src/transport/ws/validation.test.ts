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

  it('refuses a limit that is not a whole number from one to two hundred', () => {
    const refusals = [0, 201, 1.5, '10', Number.NaN].map(
      limit => validateMessage({type: 'list_conversations', limit}).valid
    );

    expect(refusals).toEqual([false, false, false, false, false]);
  });

  it('refuses a cursor missing either half, or carrying a time nothing can parse', () => {
    const refusals = [
      {updatedAt: '2026-01-01T00:00:00.000Z'},
      {sessionId: 'abc-123'},
      {updatedAt: 'last tuesday', sessionId: 'abc-123'},
      {updatedAt: '2026-01-01T00:00:00.000Z', sessionId: '../etc/passwd'},
      {updatedAt: 1767225600000, sessionId: 'abc-123'},
      'abc-123',
    ].map(before => validateMessage({type: 'list_conversations', before}).valid);

    expect(refusals).toEqual([false, false, false, false, false, false]);
  });

  it('answers a frame naming an inherited member as an unknown type, rather than reaching it', () => {
    const results = ['constructor', '__proto__', 'toString'].map(type => validateMessage({type}));

    expect(results.map(result => result.valid)).toEqual([false, false, false]);
  });
});
