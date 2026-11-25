import fs from 'fs';
import path from 'path';
import { writeFileAtomic } from './atomicFile';
import { verifyLedger, type LedgerRecord } from '../src/engine/ledger';

export class LedgerCorruptionError extends Error {}

export interface LedgerStoreOptions {
  dataDir?: string;
  file?: string;
}

/**
 * Append-only JSONL ledger. Every read re-verifies the hash chain; a corrupt
 * or tampered file is reported and left untouched so it can be recovered
 * manually rather than being silently truncated.
 */
export class FileLedger {
  private readonly dataDir: string;
  private readonly file: string;
  /**
   * Parsed + hash-chain-verified records for the file as last seen. Every poll
   * reads the ledger; without this each request re-parsed and re-hashed the
   * entire history. Invalidated by any change to the file's size or mtime.
   */
  private cache: { mtimeMs: number; size: number; records: LedgerRecord[] } | null = null;

  constructor(options: LedgerStoreOptions = {}) {
    this.dataDir = path.resolve(options.dataDir ?? path.resolve(process.cwd(), 'data'));
    this.file = options.file ?? path.join(this.dataDir, 'prediction-ledger.jsonl');
  }

  paths(): { dataDir: string; file: string } {
    return { dataDir: this.dataDir, file: this.file };
  }

  read(): LedgerRecord[] {
    if (!fs.existsSync(this.file)) {
      this.cache = null;
      return [];
    }
    const stat = fs.statSync(this.file);
    if (
      this.cache &&
      this.cache.mtimeMs === stat.mtimeMs &&
      this.cache.size === stat.size
    ) {
      return this.cache.records;
    }
    this.cache = null;
    const lines = fs
      .readFileSync(this.file, 'utf-8')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);

    const records: LedgerRecord[] = [];
    for (let i = 0; i < lines.length; i++) {
      try {
        records.push(JSON.parse(lines[i]) as LedgerRecord);
      } catch {
        throw new LedgerCorruptionError(
          `ledger line ${i + 1} is not valid JSON; file left untouched at ${this.file}`
        );
      }
    }

    const verdict = verifyLedger(records);
    if (!verdict.valid) {
      throw new LedgerCorruptionError(
        `${verdict.reason}; file left untouched at ${this.file}`
      );
    }
    this.cache = { mtimeMs: stat.mtimeMs, size: stat.size, records };
    return records;
  }

  appendRecords(mutate: (existing: LedgerRecord[]) => LedgerRecord[]): number {
    const existing = this.read();
    const next = mutate(existing);
    if (!Array.isArray(next)) {
      throw new Error('ledger mutation must return an array of records');
    }
    if (next.length < existing.length) {
      throw new Error('ledger is append-only');
    }
    const delta = next.length - existing.length;
    if (delta === 0) return 0;

    const verdict = verifyLedger(next);
    if (!verdict.valid) {
      throw new LedgerCorruptionError(
        `refusing to persist an invalid ledger: ${verdict.reason}`
      );
    }
    writeFileAtomic(this.file, `${next.map((r) => JSON.stringify(r)).join('\n')}\n`);
    const written = fs.statSync(this.file);
    this.cache = { mtimeMs: written.mtimeMs, size: written.size, records: next };
    return delta;
  }
}
