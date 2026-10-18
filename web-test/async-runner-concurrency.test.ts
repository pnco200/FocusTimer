import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalRepository } from '../src/web/repository';
import { SyncRunner } from '../src/web/sync-runner';
import { TransportError, type SyncTransport } from '../src/web/sync-transport';
import { encodeUtf8 } from '../src/protocol/index.js';

const repositories: LocalRepository[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const repository of repositories.splice(0)) repository.close();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function open(name: string = crypto.randomUUID()) {
  const repository = await LocalRepository.open(name);
  repositories.push(repository);
  await repository.initialize();
  return repository;
}

// Independent production connections enter the same discovery pass. Hold the
// first runner immediately before completion while the other finishes its page.
async function concurrentPass(secondFailure?: TransportError) {
  const firstRepository = await open();
  const descriptor = (await firstRepository.view()).collection.descriptor;
  const firstRemote = firstRepository.remote();
  const binding = await firstRemote.bind({ account: 'test-account', locator: 'test-root', descriptor });
  const secondRepository = await open(firstRepository.db.name);
  const secondRemote = secondRepository.remote();
  const entered = [deferred(), deferred()];
  const release = [deferred(), deferred()];
  const completing = deferred();
  const finish = deferred();
  let enumerations = 0;
  const transport: SyncTransport = {
    readDescriptor: async () => encodeUtf8(JSON.stringify(descriptor)),
    enumerate: async () => {
      const index = enumerations++;
      entered[index].resolve();
      await release[index].promise;
      if (index === 1 && secondFailure) throw secondFailure;
      return { references: [], continuation: null, complete: true };
    },
    read: async () => { throw new Error('No object reads expected'); },
    preparePublication: async () => { throw new Error('No publications expected'); },
    publish: async () => { throw new Error('No publications expected'); },
  };
  const complete = firstRemote.completePass.bind(firstRemote);
  vi.spyOn(firstRemote, 'completePass').mockImplementation(async pin => {
    completing.resolve();
    await finish.promise;
    return complete(pin);
  });
  const secondRunFailure = vi.spyOn(secondRemote, 'runFailure');
  const first = new SyncRunner(firstRemote, transport).run();
  await entered[0].promise;
  const second = new SyncRunner(secondRemote, transport).run();
  await entered[1].promise;
  release[0].resolve();
  await completing.promise;
  release[1].resolve();
  const secondStatus = await second;
  finish.resolve();
  const firstStatus = await first;
  const snapshot = await firstRemote.snapshot();
  firstRepository.close();
  secondRepository.close();
  const reopened = await open(firstRepository.db.name);
  return { firstStatus, secondStatus, secondRunFailure, snapshot, reopened, binding };
}

it('a competing runner losing the discovery page race does not poison the completed pass or its reopen audit', async () => {
  const result = await concurrentPass();
  expect(result.secondRunFailure).not.toHaveBeenCalled();
  expect(result.firstStatus).toBe('Synced');
  const pass = result.snapshot.discoveries[result.binding.generation];
  expect(pass).toMatchObject({ passId: 1, enumerationComplete: true, reconciled: true, error: null });
  expect(await result.reopened.remote().status()).toBe('Synced');
  expect((await result.reopened.remote().snapshot()).operations).toEqual({});
});

it('a concurrent diagnosed failure prevents another runner completing an inconsistent healthy pass', async () => {
  const result = await concurrentPass(new TransportError('authorization'));
  expect(result.secondRunFailure).toHaveBeenCalledOnce();
  expect(result.firstStatus).toBe('Authorization required');
  const pass = result.snapshot.discoveries[result.binding.generation];
  expect(pass).toMatchObject({ enumerationComplete: true, reconciled: false, error: 'authorization' });
  expect(await result.reopened.remote().status()).toBe('Authorization required');
  const transport: SyncTransport = {
    readDescriptor: async () => encodeUtf8(JSON.stringify(result.snapshot.descriptor)),
    enumerate: async () => ({ references: [], continuation: null, complete: true }),
    read: async () => { throw new Error('No object reads expected'); },
    preparePublication: async () => { throw new Error('No publications expected'); },
    publish: async () => { throw new Error('No publications expected'); },
  };
  expect(await new SyncRunner(result.reopened.remote(), transport).run()).toBe('Synced');
});
