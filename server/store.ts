import fs from 'fs';
import path from 'path';
import { PaperBet } from '../src/types/quant';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const STORE_FILE = path.resolve(DATA_DIR, 'omnipulse-store.json');

export interface PersistedStore {
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
}

const DEFAULT_STORE: PersistedStore = {
  bankroll: 10000,
  initialBankroll: 10000,
  bets: [],
  firestoreConfig: {
    enabled: false,
    collectionName: 'omnipulse_paper_bets',
  },
};

function ensureSafePath(targetPath: string): void {
  const resolved = path.resolve(targetPath);
  if (!resolved.startsWith(DATA_DIR + path.sep)) {
    throw new Error('Unsafe storage path');
  }
}

export function loadStore(): PersistedStore {
  ensureSafePath(STORE_FILE);
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(STORE_FILE)) {
      fs.writeFileSync(STORE_FILE, JSON.stringify(DEFAULT_STORE, null, 2), 'utf-8');
      return { ...DEFAULT_STORE, bets: [] };
    }
    const raw = fs.readFileSync(STORE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      bankroll: Number.isFinite(parsed?.bankroll) ? parsed.bankroll : 10000,
      initialBankroll: Number.isFinite(parsed?.initialBankroll)
        ? parsed.initialBankroll
        : 10000,
      bets: Array.isArray(parsed?.bets) ? parsed.bets : [],
      vapidKeys: parsed?.vapidKeys,
      firestoreConfig: parsed?.firestoreConfig ?? DEFAULT_STORE.firestoreConfig,
    };
  } catch {
    return { ...DEFAULT_STORE, bets: [] };
  }
}

export function saveStore(store: PersistedStore): void {
  ensureSafePath(STORE_FILE);
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), 'utf-8');
}
