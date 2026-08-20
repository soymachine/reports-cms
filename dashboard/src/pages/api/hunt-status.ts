import type { APIRoute } from 'astro';
import fs from 'node:fs';
import path from 'node:path';
import db, { PROJECT_ROOT } from '../../lib/db';
import { getSettings } from '../../lib/settings';
import { runningPid } from './hunt-now';

export const prerender = false;

const STATE = path.join(PROJECT_ROOT, '.hunt_status.json');

export const GET: APIRoute = async () => {
  const settings = getSettings();
  const pid = runningPid();

  let last: unknown = null;
  try {
    last = db
      .prepare("SELECT ran_at, summary FROM cron_history WHERE job = 'lead_hunter' ORDER BY ran_at DESC, id DESC LIMIT 1")
      .get() ?? null;
  } catch {
    last = null;                     // la tabla llega con scripts/db_schema.py
  }

  let state: Record<string, unknown> = {};
  try {
    state = JSON.parse(fs.readFileSync(STATE, 'utf-8'));
  } catch {
    state = {};
  }

  return Response.json({
    ok: true,
    running: Boolean(pid),
    pid,
    enabled: settings.hunter?.enabled ?? true,
    max_new_leads: settings.hunter?.max_new_leads ?? 5,
    schedule: settings.hunter?.schedule ?? settings.cron?.schedule ?? null,
    last_run: last,
    state,
  });
};
