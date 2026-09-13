// Runtime half of the smoke test: what a consumer gets from a bare install with
// no optional peer present. Any throw here fails the check.
import assert from 'node:assert/strict';
import {createProvider, createMockProvider, createHalEngine, ToolRegistry} from '@re-cinq/hal-engine';

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
  [{type: 'vertex', projectId: 'p', location: 'europe-west4', modelId: 'm'}, '@google-cloud/vertexai'],
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

assert.ok(new ToolRegistry(), 'ToolRegistry is not constructible');

// The named factory as well as the switch: it is the one provider a consumer with no cloud account
// can reach, and nothing above would notice if that export stopped resolving from the tarball.
assert.equal(typeof createMockProvider({}).sendMessage, 'function', 'createMockProvider built no provider');

// Everything above exercises the package without starting it. The engine is where a consumer's
// install is really tested: express, ws, cors, cookie-parser and uuid all have to resolve from the
// tarball's own dependencies, and nothing before this line would notice if one of them did not.
const engine = createHalEngine({
  provider: {type: 'mock'},
  prompt: {identity: 'You are a smoke test.'},
  auth: {ws: async () => ({id: 'smoke-user'})},
  transport: {port: 0},
});

// Port 0: the OS picks a free one, so CI cannot collide with whatever else is listening.
await engine.start();
const {port} = engine.server.address();
assert.ok(port > 0, `engine did not bind a port: ${port}`);

const response = await fetch(`http://127.0.0.1:${port}/hal/health`);
const health = await response.json();
assert.equal(response.status, 200, `health check answered ${response.status}`);
assert.equal(health.status, 'ok', `health check said ${JSON.stringify(health)}`);
assert.ok(health.timestamp, 'health check carried no timestamp');

// One full turn, provider through orchestrator, asserting the text the mock actually produces.
const said = 'what is the weather';
const reply = await engine.orchestrator.processMessage({
  sessionId: 'smoke-session',
  userId: 'smoke-user',
  entries: [{role: 'user', content: said, timestamp: new Date().toISOString()}],
});
// Trimmed: the mock yields each word with a trailing space, so the last chunk leaves one behind.
// That is the fixture's own chunking artefact rather than anything the orchestrator promises.
assert.equal(reply.trim(), `Mock response to: "${said}"`, `unexpected assistant text: ${reply}`);

await engine.stop();

// No process.exit(): the runner fails this if the process does not end on its own, because a smoke
// test that needs --forceExit is hiding a leaked handle from every consumer.
console.log(`smoke: runtime OK — ${Object.keys(exported).length} exports, health 200 on port ${port}, one full turn`);
