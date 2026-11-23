/**
 * Plays a clean, subtle Web Audio API quant chime without external audio asset dependencies.
 */
export function playQuantChime(): void {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = 'sine';
    osc2.type = 'triangle';
    osc1.frequency.setValueAtTime(660, now);
    osc2.frequency.setValueAtTime(990, now + 0.08);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc1.start(now);
    osc1.stop(now + 0.18);
    osc2.start(now + 0.08);
    osc2.stop(now + 0.42);
  } catch {
    // Ignore autoplay restrictions
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export async function enableBrowserAndPushAlerts(): Promise<{
  permission: NotificationPermission | 'unsupported';
  pushSubscribed: boolean;
  message: string;
}> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return {
      permission: 'unsupported',
      pushSubscribed: false,
      message: 'Browser notifications are not supported in this environment.',
    };
  }

  let permission = Notification.permission;
  if (permission === 'default') {
    permission = await Notification.requestPermission();
  }

  if (permission !== 'granted') {
    return {
      permission,
      pushSubscribed: false,
      message: 'Notification permission declined; in-app toasts remain active.',
    };
  }

  let pushSubscribed = false;
  if ('serviceWorker' in navigator && 'PushManager' in window) {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      const keyRes = await fetch('/api/push/vapid-public-key');
      if (keyRes.ok) {
        const { publicKey } = await keyRes.json();
        if (publicKey) {
          let sub = await reg.pushManager.getSubscription();
          if (!sub) {
            sub = await reg.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: urlBase64ToUint8Array(publicKey) as unknown as BufferSource,
            });
          }
          await fetch('/api/push/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(sub.toJSON()),
          });
          pushSubscribed = true;
        }
      }
    } catch {
      // Service worker / push subscription unavailable in restricted contexts; OS Notification fallback still works
    }
  }

  playQuantChime();
  return {
    permission,
    pushSubscribed,
    message: pushSubscribed
      ? 'Web Push VAPID & OS alerts active.'
      : 'Browser OS notifications active.',
  };
}

export function triggerOsNotification(title: string, body: string): void {
  try {
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body });
    }
  } catch {
    // Ignore when Notification constructor is restricted
  }
}
