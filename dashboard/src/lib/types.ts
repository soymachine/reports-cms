export interface PdfItem {
  file: string;
  slug: string;
  url: string;
  title: string;
  downloaded_at?: string;
  source?: 'site' | 'search';
  pages?: number;
  visual_ratio?: number;
  published_at?: string | null;
}

export interface GeneratedItem {
  page: number;
  pdf: string;
  style: string;
  styleName: string;
  original_img: string;
  generated_img: string;
  /** small WebP preview written next to the image (scripts/thumbs.py) */
  thumb?: string | null;
  status?: string;
  created_at?: string;
  style_prompt?: string;
  extra_prompt?: string;
  feedback?: string;
  palette?: string;
  // Magnific settings the image was produced with (see magnific_models.json)
  model?: string;
  resolution?: string | null;
  quality?: string | null;
  base_img?: string | null;
  job_id?: number | null;
  hero?: boolean;
  /** "manual" when a designer uploaded the pair instead of generating it */
  source?: 'magnific' | 'manual' | string;
  version?: number;
  superseded?: boolean;
  qc?: QcResult | null;
}

export interface QcResult {
  ok: boolean;
  verdict?: 'clean' | 'warning' | 'fail' | 'unknown';
  coverage?: number;
  kept?: number;
  total_original?: number;
  missing?: string[];
  invented?: string[];
  error?: string;
  /** how far the redesign moved from the page it came from (scripts/qc_redesign.py) */
  similarity?: LayoutSimilarity | null;
}

/**
 * The other way a demo dies: Magnific hands back the same page with tidier
 * edges. `distance` is 0 for an identical layout and above ~0.2 for a page
 * genuinely laid out again.
 */
export interface LayoutSimilarity {
  distance: number;
  verdict: 'ok' | 'weak' | 'copy' | 'unknown';
  too_similar?: boolean;
  copy_threshold?: number;
  weak_threshold?: number;
}

export interface PaletteColor {
  hex: string;
  share: number;
}

export interface TimelineItem {
  type: string;
  text: string;
  date: string;
}

export interface Lead {
  id: number;
  duplicate_of?: number | null;
  score_breakdown?: string | null;
  scored_at?: string | null;
  report_published_at?: string | null;
  website_domain?: string | null;
  rank: number | null;
  priority_score: number | null;
  priority: string | null;
  organisation: string;
  country: string | null;
  city: string | null;
  sector: string | null;
  type: string | null;
  relationship: string | null;
  rationale: string | null;
  services: string | null;
  website: string | null;
  linkedin: string | null;
  contact1_name: string | null;
  contact1_title: string | null;
  contact1_email: string | null;
  contact2_name: string | null;
  contact2_title: string | null;
  contact2_email: string | null;
  general_email: string | null;
  email_confidence: string | null;
  contact_source_url: string | null;
  source_urls: string | null;
  status: string;
  last_contacted: string | null;
  next_action: string | null;
  notes: string | null;
  source: string;
  pdfs: PdfItem[];
  generated: GeneratedItem[];
  email_draft: string | null;
  timeline: TimelineItem[];
  created_at: string;
  updated_at: string;
}

export interface MagnificModel {
  slug: string;
  name: string;
  resolutions: string[];
  qualities: string[];
  summary?: string;
  prices?: { resolution?: string | null; quality?: string | null; credits: number | null }[];
}

export interface ModelCatalogResponse {
  ok: boolean;
  updated_at: string | null;
  source: string | null;
  fallback_credits: number;
  models: MagnificModel[];
  defaults: { model: string; resolution: string; quality: string };
}

/** Same lookup as the server's creditsPerImage, for the live estimate in the UI. */
export function creditsPerImage(m: MagnificModel | undefined, resolution: string, quality: string, fallback: number): number {
  const prices = (m?.prices ?? []).filter((p) => typeof p.credits === 'number');
  if (!prices.length) return fallback;
  const norm = (v?: string | null) => (v ?? '') || '';
  const exact = prices.find((p) => norm(p.resolution) === resolution && norm(p.quality) === quality);
  if (exact) return exact.credits as number;
  const sameRes = prices.find((p) => norm(p.resolution) === resolution);
  if (sameRes) return sameRes.credits as number;
  return Math.max(...prices.map((p) => p.credits as number));
}

export interface StylePreset {
  id: string;
  name: string;
  prompt: string;
  source?: 'builtin' | 'custom' | 'lead';
  lead_id?: number | null;
  derived_from?: string | null;
}

export interface StatsResponse {
  total: number;
  by_status: Record<string, number>;
  by_priority: Record<string, number>;
  with_pdfs: number;
  with_generated: number;
  last_cron: { job: string; ran_at: string; summary: string } | null;
  duplicates: number;
  active_jobs: number;
  credits_spent: number;
  scored: number;
  radar_due: number;
  sectors: string[];
  countries: string[];
  settings: {
    statuses: string[];
    priorities: string[];
    style_presets: StylePreset[];
    cron_job_id: string | null;
    cron_schedule: string | null;
    cron_description: string | null;
    max_pages: number;
    radar_cycle_months: number;
  };
}

export interface PageThumb {
  page: number;
  thumb: string;
  full: string;
  score?: number;
  images?: number;
  drawings?: number;
  words?: number;
  figures?: number;
  table_rows?: number;
  /** short explanation of the score, from scripts/pdf_utils.py */
  reason?: string;
  recommended?: boolean;
}

export interface Job {
  id: number;
  type: 'find_pdfs' | 'render_pages' | 'generate' | 'score' | 'dedupe';
  lead_id: number | null;
  state: 'queued' | 'running' | 'done' | 'error';
  payload: any;
  result: any;
  error: string | null;
  credits: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export function decodeHtml(input: string | null | undefined): string {
  if (!input) return '';
  const txt = typeof document !== 'undefined' ? document.createElement('textarea') : null;
  if (txt) {
    txt.innerHTML = input;
    return txt.value;
  }
  return input
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/**
 * Page renders are always written next to a small sibling by render_pages.py:
 * `.../full-3.png` has `.../thumb-3.png`. Used as the instant placeholder.
 */
export function pageThumb(relativePath: string | null | undefined): string | null {
  const m = String(relativePath ?? '').match(/^(.*)\/full-(\d+)\.png$/);
  return m ? `${m[1]}/thumb-${m[2]}.png` : null;
}

export function fileUrl(relativePath: string): string {
  return `/api/file?path=${encodeURIComponent(relativePath)}`;
}

export function normDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(String(s).replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d;
}

export function fmtDate(s: string | null | undefined): string {
  const d = normDate(s);
  if (!d) return s ? String(s) : '';
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
}
