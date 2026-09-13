// The other half of the install matrix: both optional peers present, which is the state a consumer
// who actually calls Bedrock or Vertex is in. The bare fixture proves an absent peer fails well;
// this one proves a present peer is reached, so neither provider is dead on arrival.
import assert from 'node:assert/strict';
import {createProvider} from '@re-cinq/hal-engine';

for (const [config, peer] of [
  [{type: 'vertex', projectId: 'smoke', location: 'europe-west4', modelId: 'gemini-2.5-flash'}, '@google-cloud/vertexai'],
  [{type: 'bedrock', region: 'eu-west-1', modelId: 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0', maxTokens: 16}, '@aws-sdk/client-bedrock-runtime'],
]) {
  // Construction only. Nothing here holds cloud credentials, so a call would fail for reasons that
  // say nothing about the package; what is under test is that the SDK loads and the adapter builds.
  const provider = createProvider(config);

  assert.equal(typeof provider.sendMessage, 'function', `${peer}: no sendMessage`);
  assert.equal(typeof provider.generateStructured, 'function', `${peer}: no generateStructured`);
}

console.log('smoke: full OK — both optional peers load and both providers construct');
