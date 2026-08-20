import { defineMiddleware } from 'astro:middleware';
import { getSettings } from './lib/settings';

// Side-effect import: loading the queue closes jobs orphaned by the previous
// process and starts the worker loop. Middleware is part of the server manifest,
// so this happens when the dashboard boots instead of waiting for someone to
// open the jobs panel.
import './lib/queue';

/**
 * Optional gate. The dashboard holds the whole CRM and can spend real credits,
 * so the moment it listens on anything but localhost it needs a lock. Set
 * DASHBOARD_TOKEN (or security.token in settings.json) and every request must
 * carry it: HTTP Basic (any user, token as password), an `x-dashboard-token`
 * header, or a `tt_token` cookie set from ?token=… once.
 *
 * With no token configured nothing changes — the local setup keeps working.
 */
function expected(): string {
  return String(process.env.DASHBOARD_TOKEN || getSettings().security?.token || '').trim();
}

function provided(request: Request, url: URL): string {
  const header = request.headers.get('x-dashboard-token');
  if (header) return header.trim();

  const auth = request.headers.get('authorization') ?? '';
  if (auth.toLowerCase().startsWith('basic ')) {
    try {
      const decoded = atob(auth.slice(6).trim());
      return decoded.slice(decoded.indexOf(':') + 1).trim();
    } catch {
      /* malformed header */
    }
  }

  const cookie = request.headers.get('cookie') ?? '';
  const match = cookie.match(/(?:^|;\s*)tt_token=([^;]+)/);
  if (match) return decodeURIComponent(match[1]).trim();

  return (url.searchParams.get('token') ?? '').trim();
}

/** Constant-time-ish compare: no early exit on the first wrong character. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const onRequest = defineMiddleware(async (context, next) => {
  const token = expected();
  if (!token) return next();

  const url = new URL(context.request.url);
  const given = provided(context.request, url);
  if (!same(given, token)) {
    return new Response('No autorizado', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="ThinkThings", charset="UTF-8"' },
    });
  }

  const response = await next();
  // remember a token passed in the URL so the next request needs no query string
  if (url.searchParams.get('token')) {
    response.headers.append(
      'Set-Cookie',
      `tt_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
    );
  }
  return response;
});
