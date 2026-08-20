import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './db';

export interface StylePreset {
  id: string;
  name: string;
  prompt: string;
}

export interface Settings {
  project?: string;
  cron?: { schedule?: string; description?: string };
  /** cazador nocturno: `enabled: false` lo pausa sin tocar el programador */
  hunter?: {
    enabled?: boolean;
    max_new_leads?: number;
    schedule?: string;
    queries?: string[];
  };
  pdf_finder?: { max_pdfs_per_search?: number; min_pages?: number; crawl_site?: boolean };
  redesign?: {
    max_pages?: number;
    style_presets?: StylePreset[];
    /** Magnific images_generate defaults; see magnific_models.json for the catalog */
    model?: string;
    resolution?: string;
    quality?: string;
  };
  scoring?: { target_sectors?: string[] };
  radar?: { cycle_months?: number; window_months?: number };
  branding?: { studio?: string; logo?: string; footer?: string; contact?: string; cover_title?: string };
  budget?: { credits_per_lead?: number; credits_per_day?: number };
  /** worker limits: how many long jobs may run at once */
  jobs?: { max_concurrent?: number };
  /** optional access token; DASHBOARD_TOKEN env wins over this */
  security?: { token?: string };
  statuses: string[];
  priorities: string[];
}

export function getSettings(): Settings {
  const p = path.join(PROJECT_ROOT, 'settings.json');
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as Settings;
  } catch {
    return { statuses: [], priorities: [] };
  }
}
