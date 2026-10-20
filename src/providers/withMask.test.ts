import {withMask} from './withMask.js';
import {fixtureMask, recording, STOP, text} from './maskTestSupport.js';
import type {SendMessageParams, StructuredOutputParams} from '../types/ai.js';
import {collectChunks} from './providerTestSupport.js';

const PARAMS: SendMessageParams = {
  systemPrompt: 'Never invent a status for Ada Example.',
  tools: [{name: 'lookup', description: 'Looks up a booking for Ada Example.', inputSchema: {type: 'object'}}],
  messages: [
    {role: 'user', content: 'Is the booking for Ada Example delivered?'},
    {
      role: 'assistant',
      content: [
        {type: 'tool_use', toolUseId: 'c1', name: 'lookup', input: {signer: 'Ada Example', tags: ['Ada Example']}},
      ],
    },
    {role: 'user', content: [{type: 'tool_result', toolUseId: 'c1', content: '{"signerName":"Ada Example"}'}]},
  ],
};

describe('withMask', () => {
  it('sends the provider no Ada Example in a text message, a tool-call input value or a tool-result string', async () => {
    const {provider, sent} = recording([STOP]);

    await collectChunks(withMask(provider, fixtureMask().mask).sendMessage(PARAMS));

    const wire = JSON.stringify(sent[0].messages);
    expect({leaked: wire.includes('Ada Example'), tokens: wire.split('[[NAME_1]]').length - 1}).toEqual({
      leaked: false,
      tokens: 4,
    });
  });

  it('passes the system prompt and the tool definitions through byte-identical, since masking them would corrupt instructions', async () => {
    const {provider, sent} = recording([STOP]);

    await collectChunks(withMask(provider, fixtureMask().mask).sendMessage(PARAMS));

    expect({systemPrompt: sent[0].systemPrompt, tools: sent[0].tools}).toEqual({
      systemPrompt: PARAMS.systemPrompt,
      tools: PARAMS.tools,
    });
  });

  it('restores a token split across two chunks to Ada Example approved it, with no chunk carrying part of it', async () => {
    const {provider} = recording([text('[[NAM'), text('E_1]] approved it'), STOP]);

    const chunks = await collectChunks(withMask(provider, fixtureMask().mask).sendMessage(PARAMS));

    const texts = chunks.filter(chunk => chunk.type === 'text').map(chunk => chunk.text);
    expect({joined: texts.join(''), split: texts.some(chunk => chunk.includes('[['))}).toEqual({
      joined: 'Ada Example approved it',
      split: false,
    });
  });

  it('releases the text it held back as a text chunk before the stop chunk, in that order', async () => {
    const {provider} = recording([text('Signed by [[NAME_1]]'), STOP]);

    const chunks = await collectChunks(withMask(provider, fixtureMask().mask).sendMessage(PARAMS));

    expect(chunks.map(chunk => chunk.type).slice(-2)).toEqual(['text', 'stop']);
  });

  it('delegates generateStructured with its parameters untouched', async () => {
    const {provider} = recording([STOP]);
    const params: StructuredOutputParams<unknown> = {
      messages: [{role: 'user', content: 'Ada Example'}],
      systemPrompt: 's',
      responseSchema: {type: 'object'},
    };

    expect(await withMask(provider, fixtureMask().mask).generateStructured(params)).toBe(params);
  });

  it('fails the call with nothing sent when apply throws', async () => {
    const {provider, sent} = recording([STOP]);
    const failing = fixtureMask(() => {
      throw new Error('detector failed');
    });

    const raised = await collectChunks(withMask(provider, failing.mask).sendMessage(PARAMS)).catch(
      (error: Error) => error.message
    );

    expect({raised, sent: sent.length}).toEqual({raised: 'detector failed', sent: 0});
  });
});
