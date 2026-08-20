import type { APIRoute } from 'astro';
import { execFileSync } from 'node:child_process';

export const prerender = false;

const HERMES = '/Users/danimoyalya2/.local/bin/hermes';

// cache: hermes mcp test spawns a CLI + network call — don't hammer it
let cache: { at: number; payload: Record<string, unknown> } | null = null;
const CACHE_MS = 60_000;

export const GET: APIRoute = async () => {
  if (cache && Date.now() - cache.at < CACHE_MS) {
    return Response.json(cache.payload);
  }
  let payload: Record<string, unknown>;
  try {
    const out = execFileSync(HERMES, ['mcp', 'test', 'magnific'], {
      timeout: 15_000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const ok = out.includes('✓') && !out.includes('✗');
    payload = out.includes('OAuth') || out.includes('authorization')
      ? { ok, status: ok ? 'connected' : 'auth_required', detail: out.trim().slice(-300) }
      : { ok, status: ok ? 'connected' : 'error', detail: out.trim().slice(-300) };
  } catch (err: any) {
    const out = String(err?.stdout ?? '') + String(err?.stderr ?? '');
    const auth = out.includes('OAuth') || out.includes('authorization') || out.includes('login');
    payload = {
      ok: false,
      status: auth ? 'auth_required' : 'error',
      detail: (out.trim() || String(err?.message ?? err)).slice(-300),
    };
  }
  cache = { at: Date.now(), payload };
  return Response.json(payload);
};
