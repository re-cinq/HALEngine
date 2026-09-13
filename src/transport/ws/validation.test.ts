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
});
