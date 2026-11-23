import fs from 'fs';
import path from 'path';
import { writeFileAtomic } from './atomicFile';
import { createAdaptiveState, type AdaptiveState } from '../src/engine/adaptiveController';

export class AdaptiveCorruptionError extends Error {}

export class AdaptiveStore {
  private readonly dataDir: string;
  private readonly file: string;

  constructor(options: { dataDir?: string; file?: string } = {}) {
    this.dataDir = path.resolve(options.dataDir ?? path.resolve(process.cwd(), 'data'));
    this.file = options.file ?? path.join(this.dataDir, 'adaptive-controller.json');
  }

  paths(): { dataDir: string; file: string } {
    return { dataDir: this.dataDir, file: this.file };
  }

  load(): AdaptiveState {
    if (!fs.existsSync(this.file)) {
      const state = createAdaptiveState();
      this.save(state);
      return state;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
    } catch {
      throw new AdaptiveCorruptionError(
        `adaptive controller state is not valid JSON; file left untouched at ${this.file}`
      );
    }
    const state = parsed as AdaptiveState;
    if (
      !state ||
      state.schemaVersion !== 1 ||
      !Array.isArray(state.candidates) ||
      !Array.isArray(state.processedSampleKeys) ||
      !Array.isArray(state.history) ||
      typeof state.production?.parameterVersion !== 'string' ||
      typeof state.production?.calibration !== 'object'
    ) {
      throw new AdaptiveCorruptionError(
        `adaptive controller state failed validation; file left untouched at ${this.file}`
      );
    }
    return state;
  }

  save(state: AdaptiveState): void {
    writeFileAtomic(this.file, JSON.stringify(state, null, 2));
  }
}
