// Imports the built package root with no optional peer installed, and uses the store that needs none.
import {InMemorySessionStore} from '../dist/index.js';

const store = new InMemorySessionStore();
store.create('s1', 'u1');
const session = store.get('s1');

if (session?.sessionId !== 's1') throw new Error('the in-memory store did not round-trip a session');
console.log('OK');
