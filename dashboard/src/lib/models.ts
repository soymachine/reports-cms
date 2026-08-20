import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './db';

export interface ModelPrice {
  resolution?: string | null;
  quality?: string | null;
  credits: number | null;
}

export interface MagnificModel {
  slug: string;
  name: string;
  resolutions: string[];
  qualities: string[];
  supportsReferences?: boolean;
  summary?: string;
  prices?: ModelPrice[];
}

export interface ModelCatalog {
  updated_at?: string;
  source?: string;
  fallback_credits?: number;
  models: MagnificModel[];
}

const EMPTY: ModelCatalog = { models: [], fallback_credits: 75 };

/** The catalog is a cached file: pricing it live means a multi-minute agent run. */
export function getModelCatalog(): ModelCatalog {
  try {
    const raw = fs.readFileSync(path.join(PROJECT_ROOT, 'magnific_models.json'), 'utf-8');
    const data = JSON.parse(raw) as ModelCatalog;
    return { fallback_credits: 75, ...data, models: data.models ?? [] };
  } catch {
    return EMPTY;
  }
}

export function findModel(slug: string): MagnificModel | null {
  return getModelCatalog().models.find((m) => m.slug === slug) ?? null;
}

/**
 * Credits one image costs with these settings, straight from the `simulate_cost`
 * figures cached in the catalog. Falls back, in order, to the same model at
 * another resolution and then to the catalog-wide default, so an unpriced model
 * never silently estimates as free.
 */
export function creditsPerImage(slug: string, resolution?: string, quality?: string): number {
  const catalog = getModelCatalog();
  const fallback = Number(catalog.fallback_credits ?? 75);
  const model = catalog.models.find((m) => m.slug === slug);
  const prices = (model?.prices ?? []).filter((p) => typeof p.credits === 'number');
  if (!prices.length) return fallback;

  const norm = (v?: string | null) => (v ?? '') || '';
  const exact = prices.find(
    (p) => norm(p.resolution) === norm(resolution) && norm(p.quality) === norm(quality)
  );
  if (exact) return exact.credits as number;

  const sameResolution = prices.find((p) => norm(p.resolution) === norm(resolution));
  if (sameResolution) return sameResolution.credits as number;

  // no match: the dearest known price for this model, never the cheapest
  return Math.max(...prices.map((p) => p.credits as number));
}
