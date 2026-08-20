import type { APIRoute } from 'astro';
import { getModelCatalog } from '../../lib/models';
import { getSettings } from '../../lib/settings';

export const prerender = false;

export const GET: APIRoute = async () => {
  const catalog = getModelCatalog();
  const r = getSettings().redesign ?? {};
  return Response.json({
    ok: true,
    updated_at: catalog.updated_at ?? null,
    source: catalog.source ?? null,
    fallback_credits: catalog.fallback_credits ?? 75,
    models: catalog.models,
    defaults: {
      model: r.model ?? 'auto',
      resolution: r.resolution ?? '',
      quality: r.quality ?? '',
    },
  });
};
