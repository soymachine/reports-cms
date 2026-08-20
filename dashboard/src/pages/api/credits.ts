import type { APIRoute } from 'astro';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import db, { PROJECT_ROOT } from '../../lib/db';

export const prerender = false;

// account_balance is a network call: a short cache keeps the sidebar from
// hammering it on every poll.
let cache: { at: number; data: any } | null = null;
const TTL_MS = 60_000;

function balance(): any {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  const python = path.join(PROJECT_ROOT, '.venv', 'bin', 'python');
  const script = path.join(PROJECT_ROOT, 'scripts', 'magnific_client.py');
  try {
    const out = execFileSync(python, [script], {
      cwd: PROJECT_ROOT, timeout: 30_000, encoding: 'utf-8',
    });
    const parsed = JSON.parse(out.trim().split('\n').filter(Boolean).pop() ?? '{}');
    cache = { at: Date.now(), data: parsed?.balance ?? null };
  } catch (err: any) {
    cache = { at: Date.now(), data: { error: String(err?.stderr || err?.message || err).slice(-300) } };
  }
  return cache.data;
}

export const GET: APIRoute = async () => {
  const spentToday = (db.prepare(
    "SELECT COALESCE(SUM(credits), 0) AS c FROM jobs WHERE type = 'generate' AND date(created_at) = date('now')"
  ).get() as any).c as number;
  const spentTotal = (db.prepare(
    "SELECT COALESCE(SUM(credits), 0) AS c FROM jobs WHERE type = 'generate'"
  ).get() as any).c as number;

  const top = db.prepare(
    `SELECT l.id, l.organisation, ROUND(SUM(COALESCE(j.credits, 0)), 1) AS credits
       FROM jobs j JOIN leads l ON l.id = j.lead_id
      WHERE j.type = 'generate' AND j.credits IS NOT NULL
      GROUP BY l.id ORDER BY credits DESC LIMIT 8`
  ).all() as any[];

  return Response.json({
    ok: true,
    balance: balance(),
    spent_today: spentToday,
    spent_total: spentTotal,
    by_lead: top,
  });
};
