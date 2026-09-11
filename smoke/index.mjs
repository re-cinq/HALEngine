// Runtime half of the smoke test: what a consumer gets from a bare install with
// no optional peer present. Any throw here fails the check.
import assert from 'node:assert/strict';
import {createProvider, createHalEngine, ToolRegistry} from '@re-cinq/hal-engine';

const exported = await import('@re-cinq/hal-engine');
assert.ok(Object.keys(exported).length > 0, 'package root exported nothing');

// The mock provider is the only one a machine with no cloud account can drive.
const chunks = [];
for await (const chunk of createProvider({type: 'mock'}).sendMessage({
  messages: [{role: 'user', content: 'smoke'}],
  systemPrompt: 'system',
})) {
  chunks.push(chunk.type);
}
assert.equal(chunks.at(-1), 'stop', `mock stream did not end with stop: ${chunks.join(',')}`);

// An absent optional peer must fail at construction with a named AIError, not at
// import and not with a raw MODULE_NOT_FOUND from inside dist/.
for (const [config, peer] of [
  [{type: 'vertex', projectId: 'p', location: 'europe-west1', modelId: 'm'}, '@google-cloud/vertexai'],
  [{type: 'bedrock', region: 'eu-west-1', modelId: 'm', maxTokens: 16}, '@aws-sdk/client-bedrock-runtime'],
]) {
  assert.throws(
    () => createProvider(config),
    error => {
      assert.equal(error.name, 'AIError', `${peer}: expected AIError, got ${error.name}`);
      assert.equal(error.code, 'OPTIONAL_PEER_MISSING', `${peer}: unexpected code ${error.code}`);
      assert.ok(error.message.includes(peer), `${peer}: message does not name the package`);
      return true;
    }
  );
}

assert.equal(typeof createHalEngine, 'function', 'createHalEngine is not callable');
assert.ok(new ToolRegistry(), 'ToolRegistry is not constructible');

console.log(`smoke: runtime OK — ${Object.keys(exported).length} exports, mock streamed ${chunks.length} chunks`);
