// The smallest engine that runs: a provider, an identity, and a WebSocket authenticator.

// #region minimal
import {createHalEngine} from '../src/index.js';

const engine = createHalEngine({
  provider: {type: 'mock'},
  prompt: {identity: 'You are a helpful assistant.'},
  auth: {
    ws: async req => {
      const token = req.headers.authorization;
      if (!token) return null;
      return {id: 'user-1'};
    },
  },
  transport: {port: 8086, basePath: '/api'},
});

await engine.start();
// #endregion
