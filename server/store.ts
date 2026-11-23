import fs from 'fs';
import path from 'path';
import { PaperBet } from '../src/types/quant';
import { writeFileAtomic } from './atomicFile';

export const CURRENT_SCHEMA_VERSION = 2;

export interface PersistedStore {
  schemaVersion?: number;
  bankroll: number;
  initialBankroll: number;
  bets: PaperBet[];
  vapidKeys?: {
    publicKey: string;
    privateKey: string;
  };
  firestoreConfig?: {
    enabled: boolean;
    collectionName: string;
  };
  /** Unknown keys from older or newer versions are preserved verbatim. */
  [key: string]: unknown;
}

export interface StorePaths {
  dataDir: string;
  storeFile: string;
  backupFile: string;
}

export interface StoreOptions {
  dataDir?: string;
}

const DEFAULT_STORE: PersistedStore = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  bankroll: 10000,
  initialBankroll: 10000,
  bets: [],
  firestoreConfig: {
    enabled: false,
    collectionName: 'omnipulse_paper_bets',
  },
};

export function getStorePaths(options: StoreOptions = {}): StorePaths {
  const dataDir = path.resolve(options.dataDir ?? path.resolve(process.cwd(), 'data'));
  return {
    dataDir,
    storeFile: path.join(dataDir, 'omnipulse-store.json'),
    backupFile: path.join(dataDir, 'omnipulse-store.bak.json'),
  };
}

function ensureSafePath(targetPath: string, dataDir: string): void {
  const resolved = path.resolve(targetPath);
  if (!resolved.startsWith(dataDir + path.sep)) {
    throw new Error('Unsafe storage path');
  }
}

function cloneDefault(): PersistedStore {
  return JSON.parse(JSON.stringify(DEFAULT_STORE)) as PersistedStore;
}

function migrateStore(parsed: unknown): PersistedStore {
  const base: Record<string, unknown> =
    parsed && typeof parsed === 'object' ? { ...(parsed as Record<string, unknown>) } : {};
  const bankroll = Number(base.bankroll);
  const initialBankroll = Number(base.initialBankroll);
  const bets = Array.isArray(base.bets)
    ? (base.bets as unknown[]).filter(
        (b): b is PaperBet =>
          Boolean(b) && typeof b === 'object' && typeof (b as PaperBet).id === 'string'
      )
    : [];
  return {
    ...base,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    bankroll: Number.isFinite(bankroll) ? bankroll : DEFAULT_STORE.bankroll,
    initialBankroll: Number.isFinite(initialBankroll)
      ? initialBankroll
      : DEFAULT_STORE.initialBankroll,
    bets,
    firestoreConfig:
      (base.firestoreConfig as PersistedStore['firestoreConfig']) ??
      DEFAULT_STORE.firestoreConfig,
  };
}

function quarantineCorruptFile(paths: StorePaths): string {
  const quarantine = path.join(
    paths.dataDir,
    `omnipulse-store.corrupt-${Date.now()}.json`
  );
  fs.copyFileSync(paths.storeFile, quarantine);
  return quarantine;
}

function readFileIfPresent(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf-8');
}

/**
 * Never replaces unreadable data with an empty store: the corrupt bytes are
 * copied to a quarantine file, then the last known-good backup is restored.
 * If no backup exists the default is written but the original bytes remain in
 * quarantine for explicit recovery.
 */
export function loadStore(options: StoreOptions = {}): PersistedStore {
  const paths = getStorePaths(options);
  ensureSafePath(paths.storeFile, paths.dataDir);
  fs.mkdirSync(paths.dataDir, { recursive: true });

  const raw = readFileIfPresent(paths.storeFile);
  if (raw === null) {
    const store = cloneDefault();
    writeFileAtomic(paths.storeFile, JSON.stringify(store, null, 2));
    return store;
  }

  try {
    return migrateStore(JSON.parse(raw));
  } catch (err) {
    const quarantine = quarantineCorruptFile(paths);
    console.error(
      `[store] Corrupt store data quarantined at ${quarantine}; attempting backup recovery.`,
      err
    );

    const backupRaw = readFileIfPresent(paths.backupFile);
    if (backupRaw !== null) {
      try {
        const recovered = migrateStore(JSON.parse(backupRaw));
        writeFileAtomic(paths.storeFile, JSON.stringify(recovered, null, 2));
        console.error('[store] Store recovered from backup.');
        return recovered;
      } catch (backupErr) {
        console.error('[store] Backup is unreadable; refusing to reuse it.', backupErr);
      }
    }

    const store = cloneDefault();
    writeFileAtomic(paths.storeFile, JSON.stringify(store, null, 2));
    console.error(
      '[store] No usable backup found; started from defaults. Original data is preserved in quarantine.'
    );
    return store;
  }
}

export function saveStore(store: PersistedStore, options: StoreOptions = {}): void {
  const paths = getStorePaths(options);
  ensureSafePath(paths.storeFile, paths.dataDir);
  fs.mkdirSync(paths.dataDir, { recursive: true });

  const current = readFileIfPresent(paths.storeFile);
  if (current !== null) {
    try {
      JSON.parse(current);
      writeFileAtomic(paths.backupFile, current);
    } catch {
      // A corrupt file is not promoted to backup; loadStore quarantines it.
    }
  }

  writeFileAtomic(paths.storeFile, JSON.stringify(store, null, 2));
}
