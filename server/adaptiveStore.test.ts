import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AdaptiveCorruptionError, AdaptiveStore } from './adaptiveStore';
import { createAdaptiveState, promoteCandidate } from '../src/engine/adaptiveController';

function tempStore(): AdaptiveStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnipulse-adaptive-'));
  return new AdaptiveStore({ dataDir: dir });
}

test('a missing adaptive state file is initialised with default production parameters', () => {
  const store = tempStore();
  const state = store.load();
  assert.equal(state.production.parameterVersion, '2026.11-default-v1');
  assert.deepEqual(state.production.calibration, {});
  assert.ok(fs.existsSync(store.paths().file));
  assert.deepEqual(store.load(), state);
});

test('adaptive state survives a restart including promoted production parameters', () => {
  const store = tempStore();
  let state = createAdaptiveState('2026-11-23T18:00:00.000Z');
  state = {
    ...state,
    candidates: [
      {
        candidateId: 'abc123',
        createdAt: '2026-11-23T18:00:00.000Z',
        trainedThrough: '2026-11-23T17:00:00.000Z',
        fingerprint: 'f'.repeat(64),
        perSportGammas: { basketball: 1.1 },
        holdoutSamples: 40,
        baselineBrier: 0.24,
        candidateBrier: 0.22,
        baselineLogLoss: 0.67,
        candidateLogLoss: 0.66,
        folds: [],
        accepted: true,
        rejectionReasons: [],
        status: 'eligible',
        parameterVersion: 'shadow-cal-basketball:1.1-ffffffff',
      },
    ],
  };
  const promoted = promoteCandidate(state, 'abc123', {
    enabled: true,
    actor: 'operator',
    now: '2026-11-23T19:00:00.000Z',
  });
  store.save(promoted.state);

  const reloaded = tempStoreFrom(store).load();
  assert.equal(reloaded.production.parameterVersion, 'shadow-cal-basketball:1.1-ffffffff');
  assert.deepEqual(reloaded.production.calibration, { basketball: { gamma: 1.1 } });
  assert.equal(reloaded.productionHistory.length, 1);
  assert.deepEqual(reloaded.candidates, promoted.state.candidates);
});

test('a corrupt adaptive state file raises an explicit error and is never rewritten', () => {
  const store = tempStore();
  store.load();
  const { file } = store.paths();
  const corrupt = '{"schemaVersion":1,"production":';
  fs.writeFileSync(file, corrupt);
  assert.throws(() => store.load(), AdaptiveCorruptionError);
  assert.equal(fs.readFileSync(file, 'utf-8'), corrupt);

  const invalid = JSON.stringify({ schemaVersion: 1, production: {} });
  fs.writeFileSync(file, invalid);
  assert.throws(() => store.load(), AdaptiveCorruptionError);
  assert.equal(fs.readFileSync(file, 'utf-8'), invalid);
});

function tempStoreFrom(store: AdaptiveStore): AdaptiveStore {
  return new AdaptiveStore({ file: store.paths().file });
}
