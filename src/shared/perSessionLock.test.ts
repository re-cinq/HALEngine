import {PerSessionLock} from './perSessionLock.js';

// A callback's start is what the lock orders, so each test records starts and releases runs by hand.

const deferred = () => {
  let release = (): void => undefined;
  const until = new Promise<void>(resolve => {
    release = resolve;
  });
  return {until, release};
};

const afterPendingWork = () => new Promise(resolve => setImmediate(resolve));

describe('PerSessionLock', () => {
  it('runs two callbacks on one key in call order, the second only once the first has settled', async () => {
    const lock = new PerSessionLock();
    const gate = deferred();
    const started: string[] = [];
    const first = lock.run('session-a', async () => {
      started.push('first');
      await gate.until;
    });
    const second = lock.run('session-a', async () => void started.push('second'));
    await afterPendingWork();
    const whileFirstPending = [...started];

    gate.release();
    await Promise.all([first, second]);

    expect({whileFirstPending, started}).toEqual({whileFirstPending: ['first'], started: ['first', 'second']});
  });

  it('starts callbacks on different keys without either waiting for the other', async () => {
    const lock = new PerSessionLock();
    const gate = deferred();
    const started: string[] = [];
    const runs = ['session-a', 'session-b'].map(key =>
      lock.run(key, async () => {
        started.push(key);
        await gate.until;
      })
    );
    await afterPendingWork();
    const beforeEitherSettles = [...started];

    gate.release();
    await Promise.all(runs);

    expect(beforeEitherSettles).toEqual(['session-a', 'session-b']);
  });

  it('hands a rejection to its own caller and still runs the next callback on that key', async () => {
    const lock = new PerSessionLock();
    const failing = lock.run('session-a', async () => {
      throw new Error('run failed');
    });
    const next = lock.run('session-a', async () => 'ran');

    const failure = await failing.then(
      () => 'resolved',
      (error: Error) => error.message
    );

    expect({failure, next: await next}).toEqual({failure: 'run failed', next: 'ran'});
  });

  it('holds no key once every queued callback has settled', async () => {
    const lock = new PerSessionLock();
    const gate = deferred();
    const runs = [
      lock.run('session-a', () => gate.until),
      lock.run('session-a', async () => undefined),
      lock.run('session-b', async () => undefined),
    ];
    const whileQueued = lock.size;

    gate.release();
    await Promise.all(runs);
    await afterPendingWork();

    expect({whileQueued, afterwards: lock.size}).toEqual({whileQueued: 2, afterwards: 0});
  });
});
