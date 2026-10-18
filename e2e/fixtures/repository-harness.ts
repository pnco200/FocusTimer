import { LocalRepository } from '../../src/web/repository';
import { pin, emptyActive } from '../../src/web/model';
import { rawSnapshot, seedLegacy } from './legacy';

const harness = { LocalRepository, pin, emptyActive, rawSnapshot, seedLegacy };
declare global {
  interface Window {
    storageHarness: typeof harness;
    storageRepository: LocalRepository;
    storagePhase?: string;
    storageFailure?: string;
    legacyConnection?: IDBDatabase;
  }
}
window.storageHarness = harness;
