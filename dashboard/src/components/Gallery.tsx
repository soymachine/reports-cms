import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Star, ShieldAlert, ShieldCheck, Search, Filter } from 'lucide-react';
import type { Lead } from '../lib/types';
import { fileUrl } from '../lib/types';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Badge, priorityVariant } from './ui/badge';

interface GalleryItem {
  lead_id: number;
  organisation: string;
  sector: string | null;
  country: string | null;
  status: string;
  priority: string | null;
  page: number;
  pdf: string;
  style: string;
  styleName: string;
  original_img: string;
  generated_img: string;
  thumb: string | null;
  original_thumb: string | null;
  hero: boolean;
  version: number;
  qc: { verdict?: string } | null;
  created_at: string | null;
}

const ALL = '__all__';

export default function Gallery({ sectors, statuses, onOpenLead }: {
  sectors: string[];
  statuses: string[];
  onOpenLead: (leadId: number, pdfSlug?: string, styleId?: string) => void;
}) {
  const [items, setItems] = useState<GalleryItem[] | null>(null);
  const [styles, setStyles] = useState<{ name: string; count: number }[]>([]);
  const [style, setStyle] = useState('');
  const [sector, setSector] = useState('');
  const [status, setStatus] = useState('');
  const [heroOnly, setHeroOnly] = useState(false);
  const [q, setQ] = useState('');
  const [zoom, setZoom] = useState<GalleryItem | null>(null);

  const load = useCallback(async () => {
    setItems(null);
    const params = new URLSearchParams();
    if (style) params.set('style', style);
    if (sector) params.set('sector', sector);
    if (status) params.set('status', status);
    if (heroOnly) params.set('hero', '1');
    const res = await fetch(`/api/gallery?${params}`);
    const data = await res.json();
    setItems(data.items ?? []);
    setStyles(data.styles ?? []);
  }, [style, sector, status, heroOnly]);

  useEffect(() => { load(); }, [load]);

  // the zoom overlay owns the whole viewport while it is open
  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoom(null); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [zoom]);

  const visible = useMemo(() => {
    if (!items) return null;
    const needle = q.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((i) =>
      i.organisation.toLowerCase().includes(needle) ||
      String(i.sector ?? '').toLowerCase().includes(needle) ||
      i.styleName.toLowerCase().includes(needle));
  }, [items, q]);

  return (
    <div className="space-y-4">
      {/* filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar organización, sector, estilo…"
            className="w-64 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-800 pl-7 pr-2 py-1.5 text-xs text-zinc-800 dark:text-zinc-200 transition-all duration-200 hover:border-emerald-500/50 focus:border-emerald-500 focus:outline-none"
          />
        </div>

        <div className="w-52">
          <Select value={style || ALL} onValueChange={(v) => setStyle(v === ALL ? '' : v)}>
            <SelectTrigger><SelectValue placeholder="Todos los estilos" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Todos los estilos</SelectItem>
              {styles.map((s) => <SelectItem key={s.name} value={s.name}>{s.name} ({s.count})</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <div className="w-52">
          <Select value={sector || ALL} onValueChange={(v) => setSector(v === ALL ? '' : v)}>
            <SelectTrigger><SelectValue placeholder="Todos los sectores" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Todos los sectores</SelectItem>
              {sectors.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <div className="w-44">
          <Select value={status || ALL} onValueChange={(v) => setStatus(v === ALL ? '' : v)}>
            <SelectTrigger><SelectValue placeholder="Todos los estados" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Todos los estados</SelectItem>
              {statuses.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <button
          onClick={() => setHeroOnly((v) => !v)}
          className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-all duration-200 active:scale-95 ${
            heroOnly
              ? 'border-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-400'
              : 'border-zinc-300 dark:border-zinc-700 text-zinc-500 hover:border-amber-500/50'
          }`}
        >
          <Star size={12} fill={heroOnly ? 'currentColor' : 'none'} /> solo ganadores
        </button>

        <span className="ml-auto text-[11px] text-zinc-500">
          {visible ? `${visible.length} pares` : ''}
        </span>
      </div>

      {/* grid */}
      {!visible ? (
        <div className="flex items-center justify-center gap-2 py-16 text-xs text-zinc-500">
          <Loader2 size={14} className="animate-spin" /> Cargando galería…
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-card border border-dashed border-zinc-300 dark:border-zinc-800 px-4 py-12 text-center text-[11px] text-zinc-500">
          <Filter size={16} className="mx-auto mb-2 opacity-40" />
          Ningún rediseño con estos filtros.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {visible.map((it) => (
            <div
              key={`${it.lead_id}-${it.pdf}-${it.page}-${it.style}-${it.version}`}
              className="group rounded-card border border-zinc-200 dark:border-zinc-800 overflow-hidden transition-all duration-200 hover:border-emerald-500/40 hover:shadow-md"
            >
              <button onClick={() => setZoom(it)} className="block w-full cursor-zoom-in">
                <div className="grid grid-cols-2 gap-px bg-zinc-200 dark:bg-zinc-800">
                  <img src={fileUrl(it.original_thumb || it.original_img)} alt={`antes p${it.page}`} loading="lazy" className="w-full h-36 object-cover object-top bg-white" />
                  <img src={fileUrl(it.thumb || it.generated_img)} alt={`después p${it.page}`} loading="lazy" className="w-full h-36 object-cover object-top bg-white" />
                </div>
              </button>
              <div className="p-2.5 space-y-1">
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => onOpenLead(it.lead_id, it.pdf, it.style)}
                    className="text-[11px] text-zinc-800 dark:text-zinc-200 truncate hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors duration-200"
                    title="Abrir el lead"
                  >
                    {it.organisation}
                  </button>
                  {it.hero && <Star size={10} className="text-amber-500 shrink-0" fill="currentColor" />}
                </div>
                <div className="flex items-center gap-1.5 flex-wrap text-[10px] text-zinc-500">
                  <span className="text-emerald-600 dark:text-emerald-400 truncate max-w-[130px]">{it.styleName}</span>
                  <span>p{it.page}</span>
                  {it.version > 1 && <span className="text-zinc-400 dark:text-zinc-600">v{it.version}</span>}
                  {it.qc?.verdict === 'clean' && <ShieldCheck size={10} className="text-emerald-500" />}
                  {(it.qc?.verdict === 'warning' || it.qc?.verdict === 'fail') && (
                    <ShieldAlert size={10} className={it.qc.verdict === 'fail' ? 'text-rose-500' : 'text-amber-500'} />
                  )}
                  {it.priority && <Badge variant={priorityVariant(it.priority)}>{it.priority.split(' ')[0]}</Badge>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {zoom && (
        <div className="fixed inset-0 h-[100dvh] w-screen z-[70] bg-black/85 backdrop-blur flex flex-col p-6 overflow-hidden" onClick={() => setZoom(null)}>
          <div className="flex items-center justify-between max-w-7xl w-full mx-auto mb-3">
            <span className="text-[11px] uppercase tracking-widest text-zinc-400 truncate">
              {zoom.organisation} — página {zoom.page} — {zoom.styleName}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); onOpenLead(zoom.lead_id, zoom.pdf, zoom.style); setZoom(null); }}
              className="rounded-lg border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-300 transition-all duration-200 hover:border-emerald-500/60 hover:text-emerald-400"
            >
              Abrir lead
            </button>
          </div>
          <div className="flex-1 flex items-stretch justify-center gap-4 max-w-7xl w-full mx-auto min-h-0">
            {[['Antes', zoom.original_img, 'border-zinc-700'], ['Después', zoom.generated_img, 'border-emerald-500/40']].map(([label, src, border]) => (
              <div key={label as string} className="flex flex-col flex-1 min-w-0">
                <span className="text-[10px] uppercase tracking-widest text-zinc-500 mb-1.5 text-center">{label}</span>
                <div className="flex-1 min-h-0 flex items-center justify-center">
                  <img src={fileUrl(src as string)} alt={label as string} className={`h-full w-full object-contain rounded-lg border shadow-2xl ${border}`} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
