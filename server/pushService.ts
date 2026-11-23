import { createRequire } from 'module';
import type { PushSubscription } from 'web-push';
import { ValueAlert } from '../src/types/quant';
import { loadStore, saveStore } from './store';

const require = createRequire(import.meta.url);
const webpush = require('web-push') as typeof import('web-push');

const subscriptions = new Map<string, PushSubscription>();
const lastAlertSentAt = new Map<string, number>();

let vapidPublicKey = '';
let vapidPrivateKey = '';

export function initPushService(): { publicKey: string } {
  const envPublic = process.env.VAPID_PUBLIC_KEY?.trim();
  const envPrivate = process.env.VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.VAPID_SUBJECT?.trim() || 'mailto:alerts@omnipulse.local';

  if (envPublic && envPrivate) {
    vapidPublicKey = envPublic;
    vapidPrivateKey = envPrivate;
  } else {
    const store = loadStore();
    if (store.vapidKeys?.publicKey && store.vapidKeys?.privateKey) {
      vapidPublicKey = store.vapidKeys.publicKey;
      vapidPrivateKey = store.vapidKeys.privateKey;
    } else {
      const generated = webpush.generateVAPIDKeys();
      vapidPublicKey = generated.publicKey;
      vapidPrivateKey = generated.privateKey;
      store.vapidKeys = {
        publicKey: vapidPublicKey,
        privateKey: vapidPrivateKey,
      };
      saveStore(store);
    }
  }

  webpush.setVapidDetails(subject, vapidPublicKey, vapidPrivateKey);
  return { publicKey: vapidPublicKey };
}

export function getVapidPublicKey(): string {
  if (!vapidPublicKey) {
    initPushService();
  }
  return vapidPublicKey;
}

export function addPushSubscription(sub: PushSubscription): void {
  if (!sub || !sub.endpoint) return;
  subscriptions.set(sub.endpoint, sub);
}

export function getSubscriptionCount(): number {
  return subscriptions.size;
}

export async function dispatchBestBetPush(bestBet: ValueAlert | null): Promise<{
  sent: number;
  skipped: boolean;
}> {
  if (!bestBet || subscriptions.size === 0) {
    return { sent: 0, skipped: true };
  }

  // Only push high-conviction live edges, and dedupe for 10 minutes per selection
  if (bestBet.convictionScore < 55 || bestBet.evPct < 3.0) {
    return { sent: 0, skipped: true };
  }

  const dedupeKey = `${bestBet.matchId}:${bestBet.selection}`;
  const lastSent = lastAlertSentAt.get(dedupeKey) ?? 0;
  if (Date.now() - lastSent < 10 * 60 * 1000) {
    return { sent: 0, skipped: true };
  }

  const payload = JSON.stringify({
    title: `#1 Best Bet (${bestBet.convictionScore}/100) · +${bestBet.evPct.toFixed(1)}% EV`,
    body: `${bestBet.selection} @ ${bestBet.bookmakerOdds.toFixed(2)} (${bestBet.homeTeam} vs ${bestBet.awayTeam})`,
    url: `/?matchId=${encodeURIComponent(bestBet.matchId)}`,
    tag: `best-bet-${bestBet.matchId}`,
  });

  let sent = 0;
  for (const [endpoint, sub] of subscriptions.entries()) {
    try {
      await webpush.sendNotification(sub, payload);
      sent++;
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.statusCode === 410) {
        subscriptions.delete(endpoint);
      }
    }
  }

  if (sent > 0) {
    lastAlertSentAt.set(dedupeKey, Date.now());
  }
  return { sent, skipped: false };
}

export async function sendTestPush(): Promise<{ sent: number }> {
  if (subscriptions.size === 0) return { sent: 0 };
  const payload = JSON.stringify({
    title: 'OmniPulse Quant · Push Channel Active',
    body: 'Background Best-Bet conviction alerts are armed for live edges.',
    url: '/',
    tag: 'omnipulse-test',
  });

  let sent = 0;
  for (const [endpoint, sub] of subscriptions.entries()) {
    try {
      await webpush.sendNotification(sub, payload);
      sent++;
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.statusCode === 410) {
        subscriptions.delete(endpoint);
      }
    }
  }
  return { sent };
}
