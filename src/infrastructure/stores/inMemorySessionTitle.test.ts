import {jest} from '@jest/globals';
import {InMemorySessionStore} from './inMemorySessionStore.js';

// specs/hal-engine-conversation-list/spec.md#title

describe('InMemorySessionStore setTitle', () => {
  it('stores a title on the session and surfaces it in listFor', () => {
    const store = new InMemorySessionStore();
    const session = store.create('s1', 'u1');

    store.setTitle('s1', 'Cancel subscription');

    const summary = store.listFor('u1')[0];
    expect({sessionTitle: session.title, summaryTitle: summary?.title}).toMatchObject({
      sessionTitle: 'Cancel subscription',
      summaryTitle: 'Cancel subscription',
    });
  });

  it('is a no-op for a session id the store does not hold, without throwing', () => {
    const store = new InMemorySessionStore();
    expect(() => store.setTitle('missing', 'title')).not.toThrow();
  });

  describe('with an aged-out session', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    });

    afterEach(() => jest.useRealTimers());

    it('is a no-op for a session that has aged out, without touching its title', () => {
      const store = new InMemorySessionStore({maxAgeMs: 1000});
      const session = store.create('s1', 'u1');

      jest.setSystemTime(new Date('2026-01-01T00:00:01.001Z'));
      store.setTitle('s1', 'Expired Title');

      expect(session.title).toBeUndefined();
    });
  });
});
