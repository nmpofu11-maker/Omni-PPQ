import crypto from 'crypto';
import type { RequestHandler } from 'express';

export const SESSION_COOKIE = 'op_session';
export const CSRF_COOKIE = 'op_csrf';
export const CSRF_HEADER = 'x-csrf-token';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface SecurityConfig {
  /** HMAC key for session tokens. Never logged or sent to clients. */
  secret: string;
  secureCookies: boolean;
  sessionTtlMs: number;
  mutationRateLimit: {
    windowMs: number;
    max: number;
  };
}

export interface SessionState {
  nonce: string;
  csrf: string;
  expiresAt: number;
}

function hmac(secret: string, data: string): string {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * Production must supply SESSION_SECRET. Development falls back to an
 * ephemeral random key so no credential is ever hardcoded or committed.
 */
export function resolveSecurityConfig(
  env: NodeJS.ProcessEnv = process.env,
  warn?: (message: string) => void
): SecurityConfig {
  const isProduction = env.NODE_ENV === 'production';
  const provided = env.SESSION_SECRET?.trim();
  if (!provided && isProduction) {
    throw new Error('SESSION_SECRET must be set when NODE_ENV=production');
  }
  if (!provided) {
    warn?.(
      'SESSION_SECRET is not set; generated an ephemeral development secret. Sessions reset when the server restarts.'
    );
  }
  return {
    secret: provided || crypto.randomBytes(32).toString('hex'),
    secureCookies: isProduction,
    sessionTtlMs: SESSION_TTL_MS,
    mutationRateLimit: { windowMs: 60_000, max: 30 },
  };
}

export function issueSession(
  config: SecurityConfig,
  nowMs = Date.now()
): { token: string; session: SessionState } {
  const nonce = crypto.randomBytes(16).toString('hex');
  const csrf = crypto.randomBytes(32).toString('hex');
  const expiresAt = nowMs + config.sessionTtlMs;
  const payload = `${nonce}.${csrf}.${expiresAt}`;
  return {
    token: `v1.${payload}.${hmac(config.secret, payload)}`,
    session: { nonce, csrf, expiresAt },
  };
}

export function readSessionToken(
  config: SecurityConfig,
  token: string | undefined,
  nowMs = Date.now()
): SessionState | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== 'v1') return null;
  const [, nonce, csrf, expiresAtRaw, signature] = parts;
  const expiresAt = Number(expiresAtRaw);
  if (!nonce || !csrf || !Number.isFinite(expiresAt) || expiresAt <= nowMs) return null;
  const expected = hmac(config.secret, `${nonce}.${csrf}.${expiresAt}`);
  if (!safeEqual(signature, expected)) return null;
  return { nonce, csrf, expiresAt };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    if (!name) continue;
    out[name] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function serializeCookie(
  name: string,
  value: string,
  opts: { httpOnly: boolean; secure: boolean; maxAgeSec: number }
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${Math.floor(opts.maxAgeSec)}`,
  ];
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Issues a signed session on first contact and refreshes the readable CSRF
 * cookie. Authentication is proven by the signed HttpOnly cookie; the public
 * CSRF cookie only tells the same-origin SPA which token to echo back.
 */
export function sessionMiddleware(
  config: SecurityConfig,
  now: () => number = Date.now
): RequestHandler {
  return (req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    const existing = readSessionToken(config, cookies[SESSION_COOKIE], now());
    let session = existing;

    if (!existing) {
      const issued = issueSession(config, now());
      session = issued.session;
      res.append(
        'Set-Cookie',
        serializeCookie(SESSION_COOKIE, issued.token, {
          httpOnly: true,
          secure: config.secureCookies,
          maxAgeSec: config.sessionTtlMs / 1000,
        })
      );
      res.append(
        'Set-Cookie',
        serializeCookie(CSRF_COOKIE, issued.session.csrf, {
          httpOnly: false,
          secure: config.secureCookies,
          maxAgeSec: config.sessionTtlMs / 1000,
        })
      );
    } else if (cookies[CSRF_COOKIE] !== existing.csrf) {
      res.append(
        'Set-Cookie',
        serializeCookie(CSRF_COOKIE, existing.csrf, {
          httpOnly: false,
          secure: config.secureCookies,
          maxAgeSec: Math.max(1, Math.floor((existing.expiresAt - now()) / 1000)),
        })
      );
    }

    res.locals.session = session;
    res.locals.presentedSession = Boolean(existing);
    next();
  };
}

/** Mutations require a session that was actually presented, not freshly minted. */
export function requireSession(): RequestHandler {
  return (_req, res, next) => {
    if (!res.locals.presentedSession) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    next();
  };
}

export function requireCsrf(): RequestHandler {
  return (req, res, next) => {
    const session = res.locals.session as SessionState | undefined;
    const raw = req.headers[CSRF_HEADER];
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (
      !session ||
      typeof header !== 'string' ||
      header.length === 0 ||
      !safeEqual(header, session.csrf)
    ) {
      res.status(403).json({ error: 'Invalid CSRF token' });
      return;
    }
    next();
  };
}

export function mutationRateLimit(config: SecurityConfig): RequestHandler {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return (req, res, next) => {
    const nowMs = Date.now();
    const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= nowMs) {
      buckets.set(key, { count: 1, resetAt: nowMs + config.mutationRateLimit.windowMs });
      next();
      return;
    }
    if (bucket.count >= config.mutationRateLimit.max) {
      res.status(429).json({ error: 'Too many requests; slow down and retry later' });
      return;
    }
    bucket.count++;
    if (buckets.size > 10_000) {
      for (const [k, v] of buckets) {
        if (v.resetAt <= nowMs) buckets.delete(k);
      }
    }
    next();
  };
}

export interface AdminConfig {
  /** Shared secret for privileged (model-control) endpoints. */
  token?: string;
  production: boolean;
}

export function resolveAdminConfig(env: NodeJS.ProcessEnv = process.env): AdminConfig {
  return {
    token: env.ADMIN_TOKEN?.trim() || undefined,
    production: env.NODE_ENV === 'production',
  };
}

function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
  );
}

/**
 * Privileged endpoints (learning, promotion, rollback, push test). A browser
 * session is NOT authentication here: sessionMiddleware mints one for any
 * visitor, so a session cookie only proves the caller can make a request.
 *
 *  - ADMIN_TOKEN set: require `Authorization: Bearer <token>` (constant time).
 *  - unset + production: refuse (503) rather than leave the endpoint open.
 *  - unset + development: allow only a direct loopback connection. The check
 *    uses the socket address, which a forwarded header cannot spoof.
 */
export function requireAdmin(config: AdminConfig): RequestHandler {
  return (req, res, next) => {
    if (config.token) {
      const header = req.headers.authorization;
      const presented =
        typeof header === 'string' && header.startsWith('Bearer ')
          ? header.slice('Bearer '.length).trim()
          : '';
      if (presented.length > 0 && safeEqual(presented, config.token)) {
        next();
        return;
      }
      res.status(401).json({ error: 'Admin authorization required' });
      return;
    }
    if (config.production) {
      res.status(503).json({ error: 'Admin endpoints are disabled: ADMIN_TOKEN is not configured' });
      return;
    }
    if (isLoopback(req.socket.remoteAddress)) {
      next();
      return;
    }
    res.status(403).json({ error: 'Admin endpoints are limited to localhost without ADMIN_TOKEN' });
  };
}
