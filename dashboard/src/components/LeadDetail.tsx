import React, { useEffect, useRef, useState } from 'react';
import {
  X, Globe, Linkedin, Mail, FileText, Loader2, Download, Images, Wand2,
  Copy, Save, ExternalLink, Check, ChevronLeft, ChevronRight, Trash2, FolderOpen,
  Star, Gauge, Sparkles, ArrowUp, ArrowDown, ArrowUpDown, FileDown, Palette, Coins, Eye, ListChecks,
  ShieldAlert, History,
} from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import BeforeAfterModal from './BeforeAfterModal';
import type { Lead, PageThumb, StylePreset, GeneratedItem, PdfItem, PaletteColor, MagnificModel, ModelCatalogResponse } from '../lib/types';
import { fileUrl, fmtDate, decodeHtml, creditsPerImage } from '../lib/types';
import { composeCurrent, composeRun, itemKey, overwritten, runIsLost, runLabel, runsOf } from '../lib/runs';
import { Badge, priorityVariant } from './ui/badge';

interface Props {
  lead: Lead;
  onClose: () => void;
  onPatch: (id: number, patch: Record<string, unknown>) => Promise<Lead | null>;
  onDelete: (ids: number[]) => Promise<void>;
  statuses: string[];
  stylePresets: StylePreset[];
  maxPages: number;
  /** set when the lead is opened from the gallery: report (and style) to unfold */
  focusPdf?: { pdf: string; style?: string; key: number } | null;
}

const inputCls =
  'w-full rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-800 px-2.5 py-1.5 text-xs text-zinc-700 dark:text-zinc-300 transition-all duration-200 hover:border-emerald-500/50 focus:border-emerald-500 focus:outline-none';
const btnPrimary =
  'inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 text-white px-3 py-1.5 text-xs transition-all duration-200 hover:bg-emerald-500 hover:scale-[1.02] active:scale-[0.97] shadow-sm hover:shadow-md disabled:opacity-50 disabled:hover:scale-100';
const btnGhost =
  'inline-flex items-center justify-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-xs text-zinc-600 dark:text-zinc-300 transition-all duration-200 hover:scale-[1.02] active:scale-[0.97] hover:border-emerald-500/60 hover:text-emerald-600 dark:hover:text-emerald-400 disabled:opacity-50';

/** Model + resolution + quality for Magnific, with the credit cost of the run. */
function ModelPicker({
  catalog, fallbackCredits, model, resolution, quality, onModel, onResolution, onQuality, images,
  consistent, onConsistent,
}: {
  catalog: MagnificModel[];
  fallbackCredits: number;
  model: string;
  resolution: string;
  quality: string;
  onModel: (v: string) => void;
  onResolution: (v: string) => void;
  onQuality: (v: string) => void;
  images: number;
  consistent: boolean;
  onConsistent: (v: boolean) => void;
}) {
  if (!catalog.length) return null;
  const spec = catalog.find((m) => m.slug === model);
  const perImage = creditsPerImage(spec, resolution, quality, fallbackCredits);
  const total = perImage * Math.max(images, 0);

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-2 space-y-1.5">
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <Select
            value={model}
            onValueChange={(v) => {
              onModel(v);
              const next = catalog.find((m) => m.slug === v);
              // the previous resolution/quality rarely exist on another model
              onResolution(next?.resolutions?.[0] ?? '');
              onQuality(next?.qualities?.includes('medium') ? 'medium' : '');
            }}
          >
            <SelectTrigger><SelectValue placeholder="Modelo" /></SelectTrigger>
            <SelectContent>
              {catalog.map((m) => (
                <SelectItem key={m.slug} value={m.slug}>{m.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {spec?.resolutions?.length ? (
          <span className="inline-flex items-center rounded-md border border-zinc-300 dark:border-zinc-700 overflow-hidden shrink-0">
            {spec.resolutions.map((r) => (
              <button
                key={r}
                onClick={() => onResolution(r)}
                className={`px-1.5 py-1 text-[10px] uppercase transition-colors duration-200 ${
                  resolution === r ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'text-zinc-500 hover:text-emerald-600 dark:hover:text-emerald-400'
                }`}
              >
                {r}
              </button>
            ))}
          </span>
        ) : null}
        {spec?.qualities?.length ? (
          <span className="inline-flex items-center rounded-md border border-zinc-300 dark:border-zinc-700 overflow-hidden shrink-0">
            {spec.qualities.map((q) => (
              <button
                key={q}
                onClick={() => onQuality(q)}
                title={`Calidad ${q}`}
                className={`px-1.5 py-1 text-[10px] transition-colors duration-200 ${
                  quality === q ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'text-zinc-500 hover:text-emerald-600 dark:hover:text-emerald-400'
                }`}
              >
                {q}
              </button>
            ))}
          </span>
        ) : null}
      </div>
      <button
        onClick={() => onConsistent(!consistent)}
        title="La primera página generada sirve de referencia de estilo para el resto: misma paleta, tipografía y retícula en todo el informe"
        className={`w-full flex items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-all duration-200 active:scale-[0.99] ${
          consistent
            ? 'border-emerald-500/60 bg-emerald-500/10'
            : 'border-zinc-300 dark:border-zinc-700 hover:border-emerald-500/40'
        }`}
      >
        <span className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${
          consistent ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-zinc-400 dark:border-zinc-600'
        }`}>
          {consistent && <Check size={9} />}
        </span>
        <span className="min-w-0">
          <span className={`block text-[11px] ${consistent ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-600 dark:text-zinc-300'}`}>
            Mismo diseño en todas las páginas
          </span>
          <span className="block text-[10px] text-zinc-500 truncate">
            {consistent
              ? 'La primera página marca paleta, tipografía y retícula para el resto'
              : 'Cada página se diseña por su cuenta: el informe saldrá descoordinado'}
          </span>
        </span>
      </button>

      <div className="flex items-center justify-between gap-2 text-[10px] text-zinc-500">
        <span className="truncate" title={spec?.summary}>{spec?.summary}</span>
        <span className="shrink-0 tabular-nums" title="Coste estimado según simulate_cost de Magnific">
          {perImage} cr./imagen{images > 0 ? ` · ${images} img ≈ ` : ''}
          {images > 0 ? <span className={total > 300 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}>{total} cr.</span> : null}
        </span>
      </div>
    </div>
  );
}

function PdfGallery({
  pdfSlug,
  pdfTitle,
  leadId,
  generated,
  onPreview,
  onHero,
  onReveal,
  focus,
}: {
  pdfSlug: string;
  pdfTitle: string;
  leadId: number;
  generated: GeneratedItem[];
  onPreview: (g: GeneratedItem, scope: GeneratedItem[], scopeLabel: string | null) => void;
  onHero: (g: GeneratedItem) => void;
  onReveal: (path: string) => void;
  /** when this report is the one the user came from, unfold it as if “Mostrar” had been pressed */
  focus?: { style?: string; key: number } | null;
}) {
  // older versions stay in the history, they do not belong in the gallery
  const items = generated.filter((g) => g.pdf === pdfSlug && !g.superseded);
  const styles = Array.from(new Map(items.map((g) => [g.style, g.styleName || g.style])).entries());
  const [active, setActive] = React.useState(focus?.style ?? styles[0]?.[0] ?? '');
  const [open, setOpen] = React.useState(!!focus);
  const boxRef = React.useRef<HTMLDivElement>(null);

  // coming from the gallery: open this report and scroll it into view
  React.useEffect(() => {
    if (!focus) return;
    setOpen(true);
    if (focus.style && styles.some(([id]) => id === focus.style)) setActive(focus.style);
    const t = window.setTimeout(() => boxRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
    return () => window.clearTimeout(t);
  }, [focus?.key]);

  React.useEffect(() => {
    if (!styles.some(([id]) => id === active)) setActive(styles[0]?.[0] ?? '');
  }, [items, active, styles.map(([id]) => id).join(',')]);

  // Qué pase se está mirando. 'current' es lo vigente: la cabeza de cada página.
  const [run, setRun] = React.useState<string>('current');
  const runs = React.useMemo(() => runsOf(generated, pdfSlug, active),
                             [generated, pdfSlug, active]);

  // cambiar de estilo vuelve a lo vigente: un pase pertenece a un estilo
  React.useEffect(() => { setRun('current'); }, [active]);

  const composed = React.useMemo(
    () => (run === 'current'
      ? composeCurrent(generated, pdfSlug, active)
      : composeRun(generated, pdfSlug, active, run)),
    [generated, pdfSlug, active, run]);

  // un pase que desaparece (borrado, recarga) no puede dejar la vista vacía
  React.useEffect(() => {
    if (run !== 'current' && !runs.some((r) => r.key === run)) setRun('current');
  }, [runs, run]);

  // Los rediseños anteriores al archivado de versiones comparten fichero con el
  // que los sustituyó: sus píxeles ya no existen y conmutar a ese pase no puede
  // cambiar nada. Hay que decirlo, no dejar que parezca que el botón no funciona.
  const lost = React.useMemo(() => overwritten(generated, pdfSlug, active),
                             [generated, pdfSlug, active]);

  const viewingOld = run !== 'current';
  const currentRun = runs.find((r) => r.key === run);
  const runTitle = currentRun ? `Pase ${runs.length - currentRun.ordinal + 1}` : null;  // ordinal 1 = el más nuevo
  const pairs = composed.map((c) => c.item);
  const inherited = new Set(composed.filter((c) => !c.fromRun).map((c) => c.item.generated_img));

  // comparison PDF for THIS report only
  const [building, setBuilding] = React.useState(false);
  const [blocked, setBlocked] = React.useState<{ page: number; style: string; missing: string[] }[]>([]);
  const [file, setFile] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [onlyActive, setOnlyActive] = React.useState(false);
  const [heroOnly, setHeroOnly] = React.useState(false);
  const [lang, setLang] = React.useState<'es' | 'en'>('es');
  // hand-picked images for the deck: which redesign of each page, version included
  const [picking, setPicking] = React.useState(false);
  const [chosen, setChosen] = React.useState<string[]>([]);
  // the data check blocks the deck by default; overriding is a deliberate act
  const [allowFailedQc, setAllowFailedQc] = React.useState(false);

  // every redesign of this report, older versions too, grouped by page
  const candidates = React.useMemo(() => {
    const all = generated.filter((g) => g.pdf === pdfSlug && g.original_img && g.generated_img);
    const byPage = new Map<number, GeneratedItem[]>();
    for (const g of all) {
      const list = byPage.get(g.page) ?? [];
      list.push(g);
      byPage.set(g.page, list);
    }
    return [...byPage.entries()]
      .sort(([a], [b]) => a - b)
      .map(([page, list]) => [page, list.sort((x, y) =>
        String(x.styleName).localeCompare(String(y.styleName)) || (y.version ?? 1) - (x.version ?? 1)
      )] as const);
  }, [generated, pdfSlug]);

  /** Opening the picker starts from what the plain build would have produced. */
  const startPicking = () => {
    if (!chosen.length) {
      const base = items.filter((g) => (onlyActive ? g.style === active : true) && (heroOnly ? g.hero : true));
      setChosen((base.length ? base : items).map((g) => g.generated_img));
    }
    setPicking(true);
  };

  const toggleChosen = (img: string) =>
    setChosen((c) => (c.includes(img) ? c.filter((x) => x !== img) : [...c, img]));

  // the deck reads better page by page, whatever order they were ticked in
  const orderedChosen = candidates
    .flatMap(([, list]) => list)
    .filter((g) => chosen.includes(g.generated_img))
    .map((g) => g.generated_img);

  const build = async () => {
    setBuilding(true);
    setMsg(null);
    setFile(null);
    try {
      const res = await fetch('/api/comparison-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lead_id: leadId,
          pdf_slug: pdfSlug,
          // una selección explícita manda sobre todo lo demás; si no, y se está
          // mirando un pase anterior, va exactamente lo que hay en pantalla
          select: picking && chosen.length
            ? orderedChosen
            : viewingOld
              ? pairs.map((g) => g.generated_img)
              : undefined,
          allow_failed_qc: allowFailedQc,
          styles: !picking && onlyActive && active ? [active] : undefined,
          hero_only: !picking && heroOnly,
          lang,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setMsg(`✗ ${data.error}`);
        setBlocked(data.blocked ?? []);
        return;
      }
      if (data.blocked?.length) {
        setBlocked(data.blocked);
      } else {
        setBlocked([]);
      }
      setFile(data.file);
      setMsg(
        `✓ ${data.spreads} spread(s) · ${data.styles.length} estilo(s) · ${data.size_kb} KB · ${String(data.lang ?? lang).toUpperCase()}` +
        (data.missing?.length ? ` · ⚠ ${data.missing.length} imagen(es) elegida(s) ya no existen` : '')
      );
    } catch (e) {
      setMsg(`✗ ${String(e)}`);
    } finally {
      setBuilding(false);
    }
  };

  if (!items.length) return null;

  return (
    <div ref={boxRef} className="mt-3 rounded-lg border border-emerald-500/50 bg-emerald-100 dark:bg-emerald-950/50 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] uppercase tracking-widest text-emerald-600 dark:text-emerald-400 truncate">
            Antes / Después ({items.length})
          </span>
          {open && styles.length > 1 && (
            <span className="text-[10px] text-zinc-500 truncate hidden sm:inline">{styles.find(([id]) => id === active)?.[1]}</span>
          )}
        </div>
        <button
          onClick={() => setOpen((v) => !v)}
          className="text-[10px] rounded-md border border-emerald-500/50 px-2 py-1 text-emerald-600 dark:text-emerald-400 transition-all duration-200 hover:scale-[1.03] active:scale-95 hover:bg-emerald-500/10 shrink-0"
        >
          {open ? 'Ocultar' : 'Mostrar'}
        </button>
      </div>

      {open && (
        <>
          {styles.length > 1 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {styles.map(([id, name]) => (
                <button
                  key={id}
                  onClick={() => setActive(id)}
                  className={`text-[10px] rounded-md border px-2 py-1 transition-all duration-200 hover:scale-[1.03] active:scale-95 ${
                    active === id
                      ? 'border-emerald-500 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                      : 'border-zinc-300 dark:border-zinc-700 text-zinc-500 hover:border-emerald-500/50 hover:text-emerald-500'
                  }`}
                  title={name}
                >
                  {name}
                </button>
              ))}
            </div>
          )}
          {/* La fila se dibuja siempre, también con un único pase: si solo apareciera
              al haber dos, un estilo generado una vez no enseñaría nada y no habría
              forma de saber que esto existe. */}
          {runs.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              <span className="text-[10px] uppercase tracking-widest text-muted mr-0.5">Pases</span>
              {runs.length > 1 && (
                <button
                  onClick={() => setRun('current')}
                  title="Lo vigente: la versión más reciente de cada página"
                  className={`text-[10px] rounded-md border px-2 py-1 transition-all duration-200 hover:scale-[1.03] active:scale-95 cursor-pointer ${
                    !viewingOld
                      ? 'border-emerald-500 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                      : 'border-zinc-300 dark:border-zinc-700 text-zinc-500 hover:border-emerald-500/50 hover:text-emerald-500'
                  }`}
                >
                  Actual
                </button>
              )}
              {/* de izquierda a derecha en el orden en que se generaron: «pase 1,
                  pase 2» es como se habla de ellos */}
              {[...runs].reverse().map((r, i) => (
                <button
                  key={r.key}
                  onClick={() => setRun(r.key)}
                  title={runIsLost(r, lost)
                    ? `Las imágenes de este pase se sobrescribieron: se generaron antes de que se archivaran las versiones, así que en disco solo queda la más reciente · páginas ${r.pages.join(', ')}`
                    : `Cómo se veía tras esta generación · páginas ${r.pages.join(', ')}`}
                  className={`text-[10px] rounded-md border px-2 py-1 transition-all duration-200 hover:scale-[1.03] active:scale-95 cursor-pointer ${
                    run === r.key || (runs.length === 1 && !viewingOld)
                      ? 'border-emerald-500 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                      : 'border-zinc-300 dark:border-zinc-700 text-zinc-500 hover:border-emerald-500/50 hover:text-emerald-500'
                  }`}
                >
                  Pase {i + 1} <span className="text-zinc-400 dark:text-zinc-600">· {runLabel(r)}</span>
                  {runIsLost(r, lost) && (
                    <span className="ml-1 text-amber-600 dark:text-amber-500" title="imágenes sobrescritas">
                      ⚠
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          {viewingOld && (
            <div className="mt-2 flex items-center gap-1.5 rounded-lg border border-amber-500/50 bg-amber-500/5 px-2 py-1.5 text-[10px] text-amber-700 dark:text-amber-400">
              <History size={11} className="shrink-0" />
              <span>
                {currentRun && runIsLost(currentRun, lost)
                  ? 'Las imágenes de este pase se sobrescribieron: se generaron antes de que se archivaran las versiones, así que en disco solo queda la más reciente. Lo que ves debajo es la vigente, no la de entonces.'
                  : 'Estás viendo un pase anterior. El PDF comparativo y el ganador se aplican a lo que ves aquí, no a lo vigente.'}
              </span>
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-emerald-500/20 pt-2.5">
            <button
              onClick={build}
              disabled={building}
              title={`Comparativa en PDF de: ${pdfTitle}`}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 text-white px-2.5 py-1 text-[11px] transition-all duration-200 hover:bg-emerald-500 hover:scale-[1.02] active:scale-[0.97] disabled:opacity-50"
            >
              {building ? <Loader2 size={11} className="animate-spin" /> : <FileDown size={11} />}
              {building
                ? 'Componiendo…'
                : picking
                  ? `PDF comparativo (${orderedChosen.length})`
                  : 'PDF comparativo'}
            </button>

            <span className="inline-flex items-center rounded-md border border-zinc-300 dark:border-zinc-700 overflow-hidden">
              {(['es', 'en'] as const).map((code) => (
                <button
                  key={code}
                  onClick={() => { setLang(code); setFile(null); setMsg(null); }}
                  title={code === 'es' ? 'Generar el PDF en español' : 'Generate the PDF in English'}
                  className={`px-1.5 py-1 text-[10px] uppercase transition-colors duration-200 ${
                    lang === code
                      ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                      : 'text-zinc-500 hover:text-emerald-600 dark:hover:text-emerald-400'
                  }`}
                >
                  {code === 'es' ? 'ES' : 'EN'}
                </button>
              ))}
            </span>

            <button
              onClick={() => (picking ? setPicking(false) : startPicking())}
              title="Elegir una a una las imágenes que entran en el PDF"
              className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] transition-all duration-200 active:scale-95 ${
                picking
                  ? 'border-emerald-500 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                  : 'border-zinc-300 dark:border-zinc-700 text-zinc-500 hover:border-emerald-500/60 hover:text-emerald-600 dark:hover:text-emerald-400'
              }`}
            >
              <ListChecks size={10} /> {picking ? `Elegidas ${orderedChosen.length}/${candidates.reduce((n, [, l]) => n + l.length, 0)}` : 'Elegir imágenes'}
            </button>

            {!picking && styles.length > 1 && (
              <label className="inline-flex items-center gap-1.5 text-[10px] text-zinc-500 cursor-pointer">
                <input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} className="accent-emerald-500 cursor-pointer" />
                solo {styles.find(([id]) => id === active)?.[1] ?? 'este estilo'}
              </label>
            )}
            {!picking && items.some((g) => g.hero) && (
              <label className="inline-flex items-center gap-1.5 text-[10px] text-zinc-500 cursor-pointer">
                <input type="checkbox" checked={heroOnly} onChange={(e) => setHeroOnly(e.target.checked)} className="accent-emerald-500 cursor-pointer" />
                solo los ganadores
              </label>
            )}

            {file && (
              <>
                <a href={fileUrl(file)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-[10px] text-zinc-600 dark:text-zinc-300 transition-all duration-200 hover:border-emerald-500/60 hover:text-emerald-600 dark:hover:text-emerald-400">
                  <ExternalLink size={10} /> Abrir
                </a>
                <button onClick={() => onReveal(file)} title="Mostrar en el Finder" className="inline-flex items-center gap-1 rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-[10px] text-zinc-600 dark:text-zinc-300 transition-all duration-200 hover:border-emerald-500/60 hover:text-emerald-600 dark:hover:text-emerald-400">
                  <FolderOpen size={10} /> Carpeta
                </button>
              </>
            )}
            {msg && <span className="text-[10px] text-zinc-500">{msg}</span>}
          </div>

          {blocked.length > 0 && (
            <div className="mt-2 rounded-lg border border-rose-500/50 bg-rose-500/5 p-2 space-y-1.5">
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-rose-500">
                <ShieldAlert size={11} /> Fuera del PDF: el control de datos falló
              </div>
              {blocked.map((b, i) => (
                <div key={`${b.page}-${i}`} className="text-[10px] text-zinc-600 dark:text-zinc-400">
                  Página {b.page} · {b.style}
                  {b.missing?.length ? <span className="text-zinc-500"> — faltan cifras: {b.missing.join(', ')}</span> : null}
                </div>
              ))}
              <label className="inline-flex items-center gap-1.5 text-[10px] text-zinc-500 cursor-pointer">
                <input
                  type="checkbox"
                  checked={allowFailedQc}
                  onChange={(e) => setAllowFailedQc(e.target.checked)}
                  className="accent-rose-500 cursor-pointer"
                />
                incluirlas igualmente (la portada promete que las cifras son las suyas)
              </label>
            </div>
          )}

          {picking && (
            <div className="mt-2 rounded-lg border border-emerald-500/40 bg-white/60 dark:bg-zinc-950/40 p-2 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] uppercase tracking-widest text-emerald-600 dark:text-emerald-400">
                  Imágenes del PDF · una o varias por página
                </span>
                <span className="flex items-center gap-1.5">
                  <button
                    onClick={() => setChosen(candidates.flatMap(([, l]) => l).map((g) => g.generated_img))}
                    className="rounded-md border border-zinc-300 dark:border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-500 transition-colors duration-200 hover:text-emerald-600 dark:hover:text-emerald-400"
                  >
                    Todas
                  </button>
                  <button
                    onClick={() => setChosen([])}
                    className="rounded-md border border-zinc-300 dark:border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-500 transition-colors duration-200 hover:text-rose-500"
                  >
                    Ninguna
                  </button>
                </span>
              </div>

              {candidates.map(([page, list]) => (
                <div key={page} className="space-y-1">
                  <div className="text-[10px] text-zinc-500">Página {page}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {list.map((g) => {
                      const on = chosen.includes(g.generated_img);
                      return (
                        <button
                          key={g.generated_img + (g.version ?? 1)}
                          onClick={() => toggleChosen(g.generated_img)}
                          title={`${g.styleName} · v${g.version ?? 1}${g.superseded ? ' (versión antigua)' : ''}` +
                            (g.qc?.verdict === 'fail' ? ' · control de datos EN FALLO' : '')}
                          className={`relative w-24 rounded-md border overflow-hidden text-left transition-all duration-200 active:scale-95 ${
                            on ? 'border-emerald-500 ring-2 ring-emerald-500/40' : 'border-zinc-300 dark:border-zinc-700 opacity-60 hover:opacity-100'
                          }`}
                        >
                          <img src={fileUrl(g.thumb || g.generated_img)} alt={`${g.styleName} p${g.page}`} loading="lazy" className="w-full h-16 object-cover object-top bg-white" />
                          <span className="block truncate px-1 py-0.5 text-[9px] text-zinc-600 dark:text-zinc-400">
                            {g.styleName}
                          </span>
                          <span className="absolute top-0.5 left-0.5 rounded bg-black/70 px-1 text-[8px] text-zinc-200">
                            v{g.version ?? 1}{g.superseded ? ' ant.' : ''}
                          </span>
                          {g.qc?.verdict === 'fail' && (
                            <span className="absolute top-0.5 right-0.5 rounded bg-rose-600 text-white px-1 text-[8px]" title="cifras perdidas o inventadas">
                              QC
                            </span>
                          )}
                          {g.hero && g.qc?.verdict !== 'fail' && <Star size={9} className="absolute top-0.5 right-0.5 text-amber-400" fill="currentColor" />}
                          {on && (
                            <span className="absolute bottom-5 right-0.5 rounded-full bg-emerald-500 text-white p-0.5">
                              <Check size={8} />
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
              <p className="text-[10px] text-zinc-500">
                Entran en el PDF en orden de página. Con la selección activa se ignoran los filtros de estilo y ganadores.
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-2">
            {pairs.map((g) => (
              <div key={g.page} className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/30 p-2">
                <div className="text-[10px] text-zinc-500 mb-1 flex items-center justify-between gap-1">
                  <span className="inline-flex items-center gap-1">
                    Página {g.page}
                    <button
                      onClick={() => onHero(g)}
                      title={g.hero ? 'Quitar como ganador' : 'Marcar como ganador de esta página'}
                      className={`p-0.5 rounded transition-all duration-200 hover:scale-110 active:scale-95 ${
                        g.hero ? 'text-amber-500' : 'text-zinc-400 dark:text-zinc-600 hover:text-amber-500'
                      }`}
                    >
                      <Star size={11} fill={g.hero ? 'currentColor' : 'none'} />
                    </button>
                  </span>
                  <span className="inline-flex items-center gap-1.5 min-w-0">
                    {viewingOld && lost.has(itemKey(g)) && (
                      <span
                        className="shrink-0 rounded bg-amber-500/15 px-1 py-px text-[9px] text-amber-700 dark:text-amber-500"
                        title="El fichero de esta página se sobrescribió: estás viendo la versión actual"
                      >
                        sobrescrita
                      </span>
                    )}
                    {viewingOld && inherited.has(g.generated_img) && (
                      <span
                        className="shrink-0 rounded bg-zinc-200 dark:bg-zinc-800 px-1 py-px text-[9px] text-zinc-500"
                        title="Esta página no se generó en este pase: es la que estaba vigente entonces"
                      >
                        heredada
                      </span>
                    )}
                    <span className="text-emerald-500 truncate" title={g.extra_prompt ? `Indicaciones: ${g.extra_prompt}` : g.style_prompt}>
                      {g.styleName}
                    </span>
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => onPreview(g, pairs, viewingOld ? runTitle : null)} className="text-left cursor-zoom-in group/ba">
                    <div className="text-[9px] uppercase tracking-widest text-zinc-500 mb-1">Antes</div>
                    <img src={fileUrl(g.original_img)} alt={`antes p${g.page}`} className="w-full rounded-md border border-zinc-200 dark:border-zinc-800 transition-all duration-200 group-hover/ba:scale-[1.01] group-hover/ba:shadow-md group-hover/ba:border-zinc-400 dark:group-hover/ba:border-zinc-600" />
                  </button>
                  <button onClick={() => onPreview(g, pairs, viewingOld ? runTitle : null)} className="text-left cursor-zoom-in group/ba">
                    <div className="text-[9px] uppercase tracking-widest text-emerald-500 mb-1">Después</div>
                    <img src={fileUrl(g.thumb || g.generated_img)} alt={`después p${g.page}`} loading="lazy" className="w-full rounded-md border border-emerald-500/30 transition-all duration-200 group-hover/ba:scale-[1.01] group-hover/ba:shadow-md group-hover/ba:border-emerald-500/70" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

type PdfSortKey = 'title' | 'pages' | 'year' | 'designs' | 'source' | 'downloaded';

const PDF_SORTS: { key: PdfSortKey; label: string }[] = [
  { key: 'title', label: 'Título' },
  { key: 'pages', label: 'Páginas' },
  { key: 'year', label: 'Año' },
  { key: 'designs', label: 'Diseños' },
  { key: 'source', label: 'Fuente' },
  { key: 'downloaded', label: 'Descarga' },
];

const pdfYear = (p: PdfItem): number | null => {
  const y = Number(String(p.published_at ?? '').slice(0, 4));
  return Number.isFinite(y) && y > 1900 ? y : null;
};

function sortPdfs(pdfs: PdfItem[], generated: GeneratedItem[], key: PdfSortKey, dir: 'asc' | 'desc'): PdfItem[] {
  const designs = (p: PdfItem) => generated.filter((g) => g.pdf === p.slug).length;
  const value = (p: PdfItem): string | number => {
    switch (key) {
      case 'title': return (decodeHtml(p.title) || p.file).toLowerCase();
      case 'pages': return p.pages ?? -1;
      case 'year': return pdfYear(p) ?? -1;              // unknown year sorts last
      case 'designs': return designs(p);
      case 'source': return p.source === 'site' ? 1 : 0; // official site first when desc
      default: return String(p.downloaded_at ?? '');
    }
  };
  const sign = dir === 'asc' ? 1 : -1;
  return [...pdfs].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va < vb) return -1 * sign;
    if (va > vb) return 1 * sign;
    return 0;
  });
}

export default function LeadDetail({ lead, onClose, onPatch, onDelete, statuses, stylePresets, maxPages, focusPdf }: Props) {
  const [notes, setNotes] = useState(lead.notes ?? '');
  const [nextAction, setNextAction] = useState(lead.next_action ?? '');
  const [pdfSearching, setPdfSearching] = useState(false);
  const [pdfMsg, setPdfMsg] = useState<string | null>(null);

  const [activePdf, setActivePdf] = useState<string | null>(null);
  const [pdfSlug, setPdfSlug] = useState('');
  const [pages, setPages] = useState<PageThumb[]>([]);
  const [viewerPage, setViewerPage] = useState(1);
  const [rendering, setRendering] = useState(false);
  const [selectedPages, setSelectedPages] = useState<number[]>([]);
  const [preview, setPreview] = useState<PageThumb | null>(null);
  const [pairPreview, setPairPreview] = useState<GeneratedItem | null>(null);
  // Desde qué conjunto se abrió la comparación: al mirar un pase anterior, pasar
  // de página dentro del modal tiene que quedarse en ese pase y no saltar a lo
  // vigente, que es justo la comparación rápida que se quiere hacer.
  const [pairScope, setPairScope] = useState<{ items: GeneratedItem[]; label: string | null }>(
    { items: [], label: null });

  const openPair = (g: GeneratedItem, scope: GeneratedItem[], label: string | null) => {
    setPairScope({ items: scope, label });
    setPairPreview(g);
  };
  // Magnific model settings: they drive both the look and the credit bill
  const [catalog, setCatalog] = useState<MagnificModel[]>([]);
  const [fallbackCredits, setFallbackCredits] = useState(75);
  const [model, setModel] = useState('auto');
  // one look across the pages of a report instead of four unrelated designs
  const [consistent, setConsistent] = useState(true);
  const [resolution, setResolution] = useState('');
  const [quality, setQuality] = useState('');
  const [styleId, setStyleId] = useState(stylePresets[0]?.id ?? '');
  const [abStyles, setAbStyles] = useState<string[]>([]);   // extra styles for an A/B run
  const [showScore, setShowScore] = useState(false);
  const [recommended, setRecommended] = useState<number[]>([]);
  const [palette, setPalette] = useState<PaletteColor[]>([]);
  const [usePalette, setUsePalette] = useState(false);
  const [promptPreview, setPromptPreview] = useState<string | null>(null);
  const [loadingPrompt, setLoadingPrompt] = useState(false);
  const [presets, setPresets] = useState<StylePreset[]>(stylePresets);
  const [savingStyle, setSavingStyle] = useState(false);
  const [budgetAsk, setBudgetAsk] = useState<{ error: string; retry: () => void } | null>(null);
  const [pdfSort, setPdfSort] = useState<PdfSortKey>('downloaded');
  const [pdfDir, setPdfDir] = useState<'asc' | 'desc'>('desc');
  const [pdfToDelete, setPdfToDelete] = useState<PdfItem | null>(null);
  const [deletingPdf, setDeletingPdf] = useState(false);
  const [extraPrompt, setExtraPrompt] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [generating, setGenerating] = useState(false);
  const [genMsg, setGenMsg] = useState<string | null>(null);

  const [draft, setDraft] = useState(lead.email_draft ?? '');
  const [draftOpen, setDraftOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopPoll = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (pdfToDelete) { if (!deletingPdf) setPdfToDelete(null); return; }
      if (pairPreview) { setPairPreview(null); return; }
      if (preview) { setPreview(null); return; }
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, preview, pairPreview, pdfToDelete, deletingPdf]);

  useEffect(() => () => stopPoll(), []);

  const loadPresets = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/style-presets?lead_id=${lead.id}`);
      const data = await res.json();
      if (data.ok && data.presets?.length) setPresets(data.presets);
    } catch {
      setPresets(stylePresets);   // fall back to the built-ins
    }
  }, [lead.id, stylePresets]);

  useEffect(() => { loadPresets(); }, [loadPresets]);

  /* ---------- PDF search ---------- */
  const findPdfs = async () => {
    setPdfSearching(true);
    setPdfMsg(null);
    try {
      const res = await fetch('/api/find-pdfs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: lead.id }),
      });
      const started = await res.json();
      if (!started.ok) {
        setPdfSearching(false);
        setPdfMsg(`✗ ${started.error ?? 'no se pudo lanzar la búsqueda'}`);
        return;
      }
      if (started.joined) setPdfMsg('Ya había una búsqueda en curso para este lead…');

      stopPoll();
      pollRef.current = setInterval(async () => {
        try {
          const st = await (await fetch(`/api/jobs?id=${started.job_id}`)).json();
          const job = st.job;
          if (!job) return;
          if (job.state === 'done') {
            stopPoll();
            setPdfSearching(false);
            const n = job.result?.found ?? 0;
            const rejected = job.result?.rejected?.length ?? 0;
            setPdfMsg(
              n > 0
                ? `✓ ${n} PDF(s) descargados${rejected ? ` · ${rejected} descartados por calidad` : ''}`
                : `Sin resultados esta vez${rejected ? ` (${rejected} descartados por calidad)` : ''}`
            );
            if (n > 0) onPatch(lead.id, { status: lead.status === 'Not contacted' ? 'PDF Found' : lead.status });
          } else if (job.state === 'error') {
            stopPoll();
            setPdfSearching(false);
            setPdfMsg(`✗ ${job.error ?? 'error'}`);
          }
        } catch (e) {
          stopPoll();
          setPdfSearching(false);
          setPdfMsg(`✗ ${String(e)}`);
        }
      }, 2500);
    } catch (e) {
      setPdfSearching(false);
      setPdfMsg(`✗ ${String(e)}`);
    }
  };

  /* ---------- page rendering / selection ---------- */
  const renderPages = async (pdfFile: string) => {
    setRendering(true);
    setPages([]);
    setSelectedPages([]);
    setPreview(null);
    setActivePdf(pdfFile);
    try {
      const res = await fetch('/api/render-pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: lead.id, pdf: pdfFile }),
      });
      const data = await res.json();
      if (data.ok) {
        setPages(data.pages);
        setViewerPage(1);
        setPdfSlug(data.slug);
        // the scorer already knows which pages are worth redesigning
        const rec: number[] = (data.recommended ?? []).slice(0, maxPages);
        setRecommended(rec);
        setSelectedPages(rec);
        setPalette(data.palette ?? []);
      } else {
        setPages([]);
        setPdfMsg(`✗ render: ${data.error}`);
      }
    } catch (e) {
      setPdfMsg(`✗ render: ${String(e)}`);
    } finally {
      setRendering(false);
    }
  };

  const togglePage = (n: number) => {
    setSelectedPages((sel) => {
      if (sel.includes(n)) return sel.filter((p) => p !== n);
      if (sel.length >= maxPages) return sel;
      return [...sel, n].sort((a, b) => a - b);
    });
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = (await (await fetch('/api/magnific-models')).json()) as ModelCatalogResponse;
        if (!alive || !data.ok) return;
        setCatalog(data.models ?? []);
        setFallbackCredits(data.fallback_credits ?? 75);
        setModel(data.defaults?.model || 'auto');
        setResolution(data.defaults?.resolution || '');
        setQuality(data.defaults?.quality || '');
      } catch { /* the picker just stays hidden */ }
    })();
    return () => { alive = false; };
  }, []);

  /** Model settings sent with every generation call. */
  const modelArgs = (over?: Partial<{ model: string; resolution: string; quality: string }>) => ({
    model: over?.model ?? model,
    resolution: over?.resolution ?? resolution,
    quality: over?.quality ?? quality,
    consistent,
  });

  /**
   * A redesign of this report and style that new pages should match. Without it
   * a second run invents its own look and the deck stops being one document.
   */
  const styleAnchorFor = (pdfSlug: string, styleId: string): string | undefined => {
    const family = lead.generated.filter(
      (g) => g.pdf === pdfSlug && g.style === styleId && !g.superseded && g.generated_img);
    const pick = family.find((g) => g.hero) ?? family.sort((a, b) => a.page - b.page)[0];
    return pick?.generated_img;
  };

  /* ---------- generation ---------- */
  const generate = async () => {
    if (selectedPages.length < 2) {
      setGenMsg(`Selecciona entre 2 y ${maxPages} páginas`);
      return;
    }
    setGenerating(true);
    setGenMsg(null);

    const chosen = [styleId, ...abStyles];
    const styles = chosen
      .map((id) => presets.find((p) => p.id === id))
      .filter(Boolean)
      .map((p) => ({ id: p!.id, name: p!.name, prompt: p!.prompt }));

    try {
      await postGenerate(
        {
          lead_id: lead.id,
          pages: selectedPages,
          pdf_slug: pdfSlug,
          styles,
          extra_prompt: extraPrompt.trim(),
          palette: paletteArg(),
          ...modelArgs(),
          style_anchor: styleAnchorFor(pdfSlug, styleId),
        },
        (jobIds) => {
          setGenMsg(`Generando ${selectedPages.length} página(s) en ${jobIds.length} estilo(s)…`);
          pollGeneration(jobIds);
        }
      );
    } catch (e) {
      setGenerating(false);
      setGenMsg(`✗ ${String(e)}`);
    }
  };

  const paletteArg = () => (usePalette && palette.length ? palette.map((c) => c.hex).join(',') : '');

  /** POSTs to /api/generate and surfaces the budget prompt when the cap is hit. */
  const postGenerate = async (payload: Record<string, unknown>, onStarted: (ids: number[]) => void) => {
    const send = async (confirm: boolean) => {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, confirm_budget: confirm }),
      });
      const data = await res.json();
      if (res.status === 409 && data.needs_confirmation) {
        setGenerating(false);
        setBudgetAsk({ error: data.error, retry: () => { setBudgetAsk(null); setGenerating(true); send(true); } });
        return;
      }
      if (!data.ok) {
        setGenerating(false);
        setGenMsg(`✗ ${data.error ?? 'no se pudo lanzar la generación'}`);
        return;
      }
      onStarted(data.job_ids ?? []);
    };
    await send(false);
  };

  /* ---------- generate specific styles for one page (from the before/after view) ---------- */
  const generateStylesForPage = async (styleIds: string[], page: number, slug: string) => {
    const styles = styleIds
      .map((id) => presets.find((p) => p.id === id))
      .filter(Boolean)
      .map((p) => ({ id: p!.id, name: p!.name, prompt: p!.prompt }));
    if (!styles.length) return;

    setGenerating(true);
    setGenMsg(`Generando página ${page} en ${styles.length} estilo(s)…`);
    try {
      await postGenerate(
        {
          lead_id: lead.id, pages: [page], pdf_slug: slug, styles,
          extra_prompt: extraPrompt.trim(), palette: paletteArg(), ...modelArgs(),
        },
        (jobIds) => pollGeneration(jobIds)
      );
      return;
    } catch (e) {
      setGenerating(false);
      setGenMsg(`✗ ${String(e)}`);
    }
  };

  /** Shared poller for any generation launch. */
  const pollGeneration = (ids: number[], onDone?: (updated?: Lead) => void) => {
    {
      stopPoll();
      pollRef.current = setInterval(async () => {
        try {
          const jobs = await Promise.all(ids.map(async (id) => (await (await fetch(`/api/jobs?id=${id}`)).json()).job));
          if (jobs.some((j) => !j || j.state === 'running' || j.state === 'queued')) return;
          stopPoll();
          setGenerating(false);
          const done = jobs.filter((j) => j.state === 'done');
          const images = done.reduce((n, j) => n + (j.result?.generated?.length ?? 0), 0);
          const credits = done.reduce((n, j) => n + (j.credits ?? 0), 0);
          const failed = jobs.filter((j) => j.state === 'error');
          const auth = failed.some((j) => String(j.error).includes('MAGNIFIC_AUTH_REQUIRED'));
          // surplus variants mean Magnific ignored the one-image-per-page rule
          const extras = done.reduce((n, j) => n + (j.result?.extra_variants?.length ?? 0), 0);
          setGenMsg(
            auth
              ? '✗ Magnific requiere login: ejecuta `.venv/bin/python scripts/magnific_login.py` en terminal'
              : images
                ? `✓ ${images} rediseño(s)${credits ? ` · ${credits} créditos` : ''}` +
                  `${failed.length ? ` · ${failed.length} fallido(s)` : ''}` +
                  `${extras ? ` · ⚠ ${extras} variante(s) de más generadas` : ''}`
                : `✗ ${failed[0]?.error ?? 'sin resultado'}`
          );
          // pull the lead back so the new pairs show up in the open modal
          const fresh = await (await fetch(`/api/leads?q=${encodeURIComponent(lead.organisation)}`)).json();
          const updated = (fresh.leads as Lead[]).find((l) => l.id === lead.id);
          if (updated) await onPatch(lead.id, { generated: updated.generated });
          if (images) onPatch(lead.id, { status: 'Demo Ready' });
          onDone?.(updated);
        } catch (e) {
          stopPoll();
          setGenerating(false);
          setGenMsg(`✗ ${String(e)}`);
        }
      }, 5000);
    }
  };

  /* ---------- preview the exact prompt that goes to Magnific ---------- */
  const previewPrompt = async () => {
    if (promptPreview !== null) { setPromptPreview(null); return; }
    setLoadingPrompt(true);
    try {
      const preset = presets.find((p) => p.id === styleId);
      const res = await fetch('/api/prompt-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          style_prompt: preset?.prompt ?? '',
          extra_prompt: extraPrompt.trim(),
          palette: paletteArg(),
        }),
      });
      const data = await res.json();
      setPromptPreview(data.ok ? data.magnific_prompt : `✗ ${data.error}`);
    } catch (e) {
      setPromptPreview(`✗ ${String(e)}`);
    } finally {
      setLoadingPrompt(false);
    }
  };

  /* ---------- save the current style + instructions as a client preset ---------- */
  const saveStyleForLead = async () => {
    const base = presets.find((p) => p.id === styleId);
    if (!base) return;
    setSavingStyle(true);
    try {
      const parts = [base.prompt, extraPrompt.trim()];
      if (usePalette && palette.length) parts.push(`paleta: ${palette.map((c) => c.hex).join(', ')}`);
      const res = await fetch('/api/style-presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `${base.name} — ${lead.organisation}`.slice(0, 64),
          prompt: parts.filter(Boolean).join('. '),
          lead_id: lead.id,
          derived_from: base.id,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        await loadPresets();
        setStyleId(data.preset.id);
        setGenMsg(`✓ Estilo guardado para ${lead.organisation}`);
      } else {
        setGenMsg(`✗ ${data.error}`);
      }
    } catch (e) {
      setGenMsg(`✗ ${String(e)}`);
    } finally {
      setSavingStyle(false);
    }
  };

  /* ---------- redo one image with corrective feedback ---------- */
  const regenerate = async (item: GeneratedItem, feedback: string, base: 'original' | 'current' = 'original') => {
    const preset = presets.find((p) => p.id === item.style)
      ?? { id: item.style, name: item.styleName, prompt: item.style_prompt ?? '' };
    setGenerating(true);
    setGenMsg(
      base === 'current'
        ? `Retocando el rediseño de la página ${item.page} (${item.styleName})…`
        : `Rehaciendo página ${item.page} (${item.styleName})…`
    );
    try {
      await postGenerate(
        {
          lead_id: lead.id,
          pages: [item.page],
          pdf_slug: item.pdf,
          styles: [{ id: preset.id, name: preset.name, prompt: preset.prompt }],
          extra_prompt: item.extra_prompt ?? '',
          feedback,
          palette: item.palette || paletteArg(),
          // repeat the settings this image was made with, so a redo is comparable
          ...modelArgs({
            model: item.model || model,
            resolution: item.resolution ?? resolution,
            quality: item.quality ?? quality,
          }),
          // refine on top of this redesign instead of starting from the PDF page
          base_img: base === 'current' ? item.generated_img : undefined,
          // and keep it looking like the rest of the deck
          style_anchor: base === 'current' ? undefined : styleAnchorFor(item.pdf, item.style),
        },
        (jobIds) => pollGeneration(jobIds, (updated) => {
          if (!updated) return;
          const newest = updated.generated
            .filter((g) => g.pdf === item.pdf && g.page === item.page && g.style === item.style && !g.superseded)
            .sort((a, b) => (b.version ?? 1) - (a.version ?? 1))[0];
          if (newest) setPairPreview(newest);
        })
      );
    } catch (e) {
      setGenerating(false);
      setGenMsg(`✗ ${String(e)}`);
    }
  };

  /* ---------- mark the winning redesign ---------- */
  const setHero = async (item: GeneratedItem) => {
    // El ganador es una imagen concreta, no «esta página en este estilo»: al
    // poder mirar pases anteriores, la estrella tiene que marcar la que se ve.
    const on = !item.hero;
    const updated = (lead.generated ?? []).map((g) => ({
      ...g,
      hero: g.generated_img === item.generated_img && g.page === item.page
        ? on
        : g.pdf === item.pdf && g.page === item.page
          ? false          // one winner per page
          : g.hero,
    }));
    await onPatch(lead.id, { generated: updated });
  };

  /* ---------- delete one report ---------- */
  const deletePdf = async (pdf: PdfItem, keepGenerated: boolean) => {
    setDeletingPdf(true);
    try {
      const res = await fetch('/api/delete-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: lead.id, file: pdf.file, keep_generated: keepGenerated }),
      });
      const data = await res.json();
      if (!data.ok) {
        setPdfMsg(`✗ ${data.error}`);
        return;
      }
      if (activePdf === pdf.file) {
        setActivePdf(null);
        setPages([]);
        setSelectedPages([]);
      }
      // reflect the server's version of the lead without a full reload
      await onPatch(lead.id, { pdfs: data.lead.pdfs, generated: data.lead.generated });
      setPdfMsg(
        `✓ PDF eliminado${data.generated_removed ? ` · ${data.generated_removed} rediseño(s) borrados` : ''}`
      );
    } catch (e) {
      setPdfMsg(`✗ ${String(e)}`);
    } finally {
      setDeletingPdf(false);
      setPdfToDelete(null);
    }
  };

  /* ---------- reveal the downloaded file in Finder ---------- */
  const revealPdf = async (relPath: string) => {
    try {
      const res = await fetch('/api/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: relPath }),
      });
      const data = await res.json();
      if (!data.ok) setPdfMsg(`✗ ${data.error}`);
    } catch (e) {
      setPdfMsg(`✗ ${String(e)}`);
    }
  };

  /* ---------- delete ---------- */
  const remove = async () => {
    setDeleting(true);
    try {
      await onDelete([lead.id]);
      onClose();
    } finally {
      setDeleting(false);
    }
  };

  /* ---------- email draft ---------- */
  const buildDraft = async () => {
    const res = await fetch('/api/email-draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lead_id: lead.id }),
    });
    const data = await res.json();
    if (data.ok) {
      setDraft(data.html);
      setDraftOpen(true);
    }
  };

  const copyDraft = async () => {
    await navigator.clipboard.writeText(draft);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // The open before/after must follow the lead as it is patched (hero, new styles).
  // Match on the image itself: pdf+page+style is shared by every version, so
  // matching on that would always snap back to the current one.
  const livePair = pairPreview
    ? lead.generated.find((g) => g.generated_img === pairPreview.generated_img)
      ?? lead.generated.find((g) =>
          g.pdf === pairPreview.pdf && g.page === pairPreview.page && g.style === pairPreview.style && !g.superseded)
      ?? pairPreview
    : null;

  const website = lead.website ? (lead.website.startsWith('http') ? lead.website : `https://${lead.website}`) : null;
  const timeline = [...(lead.timeline ?? [])].sort((a, b) => String(b.date).localeCompare(String(a.date)));

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" onClick={onClose}>
        <div className="max-w-[95rem] mx-auto pt-6 pb-6 px-4" onClick={(e) => e.stopPropagation()}>
          <div className="rounded-card border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 max-h-[90vh] overflow-y-auto shadow-2xl">
            {/* header */}
            <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-zinc-200 dark:border-zinc-800 bg-white/95 dark:bg-zinc-950/95 backdrop-blur px-6 py-4">
              <div className="min-w-0">
                <h2 className="text-base font-medium text-zinc-900 dark:text-zinc-100 leading-snug">{lead.organisation}</h2>
                <div className="flex flex-wrap items-center gap-1.5 mt-2">
                  {lead.priority && <Badge variant={priorityVariant(lead.priority)}>{lead.priority}</Badge>}
                  <Badge variant="outline">{lead.status}</Badge>
                  {lead.source === 'agent' && <Badge variant="accent">agent</Badge>}
                  {lead.priority_score != null && (
                    <button
                      onClick={() => setShowScore((v) => !v)}
                      title="Ver por qué tiene esta prioridad"
                      className="inline-flex items-center gap-1 rounded-md border border-zinc-300 dark:border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-500 transition-all duration-200 hover:scale-[1.03] active:scale-95 hover:border-emerald-500/50 hover:text-emerald-600 dark:hover:text-emerald-400"
                    >
                      <Gauge size={10} /> score {lead.priority_score}
                    </button>
                  )}
                </div>
                {showScore && (
                  <div className="mt-2 rounded-lg border border-zinc-200 dark:border-zinc-800 p-2.5">
                    <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-1.5">
                      Desglose del score{lead.scored_at ? ` · ${fmtDate(lead.scored_at)}` : ''}
                    </div>
                    {(() => {
                      let parts: Record<string, { points: number; why: string }> = {};
                      try { parts = JSON.parse(lead.score_breakdown || '{}'); } catch { parts = {}; }
                      const entries = Object.entries(parts);
                      if (!entries.length) {
                        return <div className="text-[11px] text-zinc-500">Sin desglose: pulsa “Recalcular prioridades” en la barra lateral.</div>;
                      }
                      return (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
                          {entries.map(([k, v]) => (
                            <div key={k} className="flex items-center justify-between gap-2 text-[11px]">
                              <span className="text-zinc-600 dark:text-zinc-400 truncate">{v.why}</span>
                              <span className={`tabular-nums shrink-0 ${v.points > 0 ? 'text-emerald-600 dark:text-emerald-400' : v.points < 0 ? 'text-rose-500' : 'text-zinc-400'}`}>
                                {v.points > 0 ? '+' : ''}{v.points}
                              </span>
                            </div>
                          ))}
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {website && (
                  <a href={website} target="_blank" rel="noreferrer" className="p-2 rounded-lg text-zinc-500 transition-all duration-200 hover:scale-110 hover:text-emerald-500 hover:bg-emerald-500/10">
                    <Globe size={14} />
                  </a>
                )}
                {lead.linkedin && !lead.linkedin.includes('To find') && (
                  <a href={lead.linkedin} target="_blank" rel="noreferrer" className="p-2 rounded-lg text-zinc-500 transition-all duration-200 hover:scale-110 hover:text-emerald-500 hover:bg-emerald-500/10">
                    <Linkedin size={14} />
                  </a>
                )}
                {confirmDelete ? (
                  <span className="inline-flex items-center gap-1.5 rounded-lg border border-rose-300 dark:border-rose-900 bg-rose-500/5 px-2 py-1">
                    <span className="text-[10px] text-rose-600 dark:text-rose-400">¿Eliminar lead y archivos?</span>
                    <button
                      onClick={remove}
                      disabled={deleting}
                      className="inline-flex items-center gap-1 rounded-md bg-rose-600 px-2 py-1 text-[10px] text-white transition-all duration-200 hover:bg-rose-500 active:scale-95 disabled:opacity-50"
                    >
                      {deleting ? <Loader2 size={10} className="animate-spin" /> : <Trash2 size={10} />} Sí
                    </button>
                    <button
                      onClick={() => setConfirmDelete(false)}
                      className="rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-[10px] text-zinc-500 transition-all duration-200 hover:border-zinc-400"
                    >
                      No
                    </button>
                  </span>
                ) : (
                  <button
                    onClick={() => setConfirmDelete(true)}
                    title="Eliminar lead"
                    className="p-2 rounded-lg text-zinc-500 transition-all duration-200 hover:scale-110 hover:text-rose-500 hover:bg-rose-500/10 active:scale-95"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
                <button onClick={onClose} title="Cerrar" className="p-2 rounded-lg text-zinc-500 transition-all duration-200 hover:scale-110 hover:text-rose-500 hover:bg-rose-500/10 active:scale-95">
                  <X size={14} />
                </button>
              </div>
            </div>

            <div className="px-6 py-5 space-y-6">
              {/* TOP INFO PANEL (uses full width) */}
              <section className="space-y-5">
                {/* company data — as many columns as fit, full width */}
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-x-6 gap-y-3 text-xs">
                  {[
                    ['Sector', lead.sector],
                    ['País / Ciudad', [lead.country, lead.city].filter(Boolean).join(' / ')],
                    ['Tipo', lead.type],
                    ['Relación', lead.relationship],
                    ['Servicios potenciales', lead.services],
                    ['Confianza email', lead.email_confidence],
                  ].map(([k, v]) => (
                    <div key={k as string}>
                      <div className="text-[10px] uppercase tracking-widest text-zinc-500">{k}</div>
                      <div className="text-zinc-700 dark:text-zinc-300 mt-0.5">{v || '—'}</div>
                    </div>
                  ))}
                  {lead.rationale && (
                    <div className="col-span-full">
                      <div className="text-[10px] uppercase tracking-widest text-zinc-500">Rationale</div>
                      <div className="text-zinc-700 dark:text-zinc-300 mt-0.5">{lead.rationale}</div>
                    </div>
                  )}
                </div>

                {/* status + next action in the same row */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-1">Estado</div>
                    <Select value={lead.status} onValueChange={(v) => onPatch(lead.id, { status: v })}>
                      <SelectTrigger>
                        <SelectValue placeholder="Estado" />
                      </SelectTrigger>
                      <SelectContent>
                        {statuses.map((st) => <SelectItem key={st} value={st}>{st}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-1">Próxima acción</div>
                    <div className="flex gap-1.5">
                      <input value={nextAction} onChange={(e) => setNextAction(e.target.value)} className={inputCls} />
                      <button onClick={() => onPatch(lead.id, { next_action: nextAction })} className={btnGhost} title="Guardar">
                        <Save size={12} />
                      </button>
                    </div>
                  </div>
                </div>

                {/* contacts */}
                <div>
                  <h3 className="text-[10px] uppercase tracking-widest text-zinc-500 mb-2">Contactos</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {[
                      { name: lead.contact1_name, title: lead.contact1_title, email: lead.contact1_email },
                      { name: lead.contact2_name, title: lead.contact2_title, email: lead.contact2_email },
                    ].filter((c) => c.name || c.email).map((c, i) => (
                      <div key={i} className="flex items-center justify-between rounded-lg border border-zinc-200 dark:border-zinc-800 px-3 py-2 text-xs transition-all duration-200 hover:border-emerald-500/40 hover:shadow-sm">
                        <div>
                          <span className="text-zinc-800 dark:text-zinc-200">{c.name ?? '—'}</span>
                          {c.title && <span className="text-zinc-500 ml-2">{c.title}</span>}
                        </div>
                        {c.email && (
                          <a href={`mailto:${c.email}`} className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 transition-all duration-200 hover:scale-[1.03]">
                            <Mail size={11} /> {c.email}
                          </a>
                        )}
                      </div>
                    ))}
                    {lead.general_email && (
                      <div className="flex items-center justify-between rounded-lg border border-zinc-200 dark:border-zinc-800 px-3 py-2 text-xs transition-all duration-200 hover:border-emerald-500/40 hover:shadow-sm">
                        <span className="text-zinc-500">general</span>
                        <a href={`mailto:${lead.general_email}`} className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 transition-all duration-200 hover:scale-[1.03]">
                          <Mail size={11} /> {lead.general_email}
                        </a>
                      </div>
                    )}
                    {!lead.contact1_name && !lead.contact2_name && !lead.general_email && (
                      <div className="col-span-full text-[11px] text-zinc-500">Sin contactos registrados</div>
                    )}
                  </div>
                </div>
              </section>

              {/* REPORTS (full width) */}
              <section>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-[10px] uppercase tracking-widest text-zinc-500">Reports (PDFs)</h3>
                  <button onClick={findPdfs} disabled={pdfSearching} className={btnPrimary}>
                    {pdfSearching ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                    {pdfSearching ? 'Buscando…' : 'Buscar PDFs de reports'}
                  </button>
                </div>
                {pdfMsg && <div className="text-[11px] text-zinc-500 mb-2">{pdfMsg}</div>}

                {lead.pdfs.length > 1 && (
                  <div className="flex items-center gap-1.5 flex-wrap mb-2">
                    <span className="text-[10px] uppercase tracking-widest text-zinc-500 mr-0.5">Ordenar</span>
                    {PDF_SORTS.map((sortOpt) => {
                      const on = pdfSort === sortOpt.key;
                      return (
                        <button
                          key={sortOpt.key}
                          onClick={() => {
                            if (on) setPdfDir(pdfDir === 'asc' ? 'desc' : 'asc');
                            else { setPdfSort(sortOpt.key); setPdfDir(sortOpt.key === 'title' ? 'asc' : 'desc'); }
                          }}
                          className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] transition-all duration-200 active:scale-95 ${
                            on
                              ? 'border-emerald-500 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                              : 'border-zinc-300 dark:border-zinc-700 text-zinc-500 hover:border-emerald-500/50 hover:text-emerald-500'
                          }`}
                        >
                          {sortOpt.label}
                          {on
                            ? (pdfDir === 'asc' ? <ArrowUp size={9} /> : <ArrowDown size={9} />)
                            : <ArrowUpDown size={9} className="opacity-40" />}
                        </button>
                      );
                    })}
                  </div>
                )}

                {lead.pdfs.length === 0 && !pdfSearching && (
                  <div className="text-[11px] text-zinc-400 dark:text-zinc-600 border border-dashed border-zinc-300 dark:border-zinc-800 rounded-lg px-3 py-4 text-center">
                    Sin PDFs todavía — pulsa “Buscar PDFs de reports”
                  </div>
                )}

                <div className="space-y-3">
                  {sortPdfs(lead.pdfs, lead.generated, pdfSort, pdfDir).map((p) => (
                    <div key={p.file} className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <div className="flex items-center gap-2 min-w-0">
                          <FileText size={13} className="text-emerald-500 shrink-0" />
                          <span className="truncate text-zinc-700 dark:text-zinc-300">{decodeHtml(p.title) || p.file}</span>
                          {p.pages != null && (
                            <span className="shrink-0 text-[10px] text-zinc-400 dark:text-zinc-600">{p.pages} págs</span>
                          )}
                          {pdfYear(p) && (
                            <span className="shrink-0 text-[10px] text-zinc-400 dark:text-zinc-600" title={`Publicado: ${fmtDate(p.published_at)}`}>
                              {pdfYear(p)}
                            </span>
                          )}
                          {(() => {
                            const n = lead.generated.filter((g) => g.pdf === p.slug).length;
                            return n > 0 ? (
                              <span className="shrink-0 inline-flex items-center gap-0.5 text-[10px] text-amber-500 dark:text-amber-400" title={`${n} rediseño(s) generados a partir de este PDF`}>
                                <Sparkles size={9} /> {n}
                              </span>
                            ) : null;
                          })()}
                          {p.source === 'site' && (
                            <span className="shrink-0 text-[10px] text-emerald-600/70 dark:text-emerald-400/70" title="Encontrado en la web del propio lead">web oficial</span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <a
                            href={fileUrl(p.file)}
                            target="_blank"
                            rel="noreferrer"
                            title="Abrir el PDF descargado en el navegador"
                            className="p-1.5 rounded-md text-zinc-500 transition-all duration-200 hover:scale-110 hover:text-emerald-500"
                          >
                            <FileText size={12} />
                          </a>
                          <button
                            onClick={() => revealPdf(p.file)}
                            title="Mostrar en el Finder (carpeta local)"
                            className="p-1.5 rounded-md text-zinc-500 transition-all duration-200 hover:scale-110 hover:text-emerald-500 active:scale-95"
                          >
                            <FolderOpen size={12} />
                          </button>
                          <a href={p.url} target="_blank" rel="noreferrer" title="Fuente original online" className="p-1.5 rounded-md text-zinc-500 transition-all duration-200 hover:scale-110 hover:text-emerald-500">
                            <ExternalLink size={12} />
                          </a>
                          <button
                            onClick={() => setPdfToDelete(p)}
                            title="Eliminar este PDF"
                            className="p-1.5 rounded-md text-zinc-500 transition-all duration-200 hover:scale-110 hover:text-rose-500 hover:bg-rose-500/10 active:scale-95"
                          >
                            <Trash2 size={12} />
                          </button>
                          <button
                            onClick={() => activePdf === p.file ? (setActivePdf(null), setPages([])) : renderPages(p.file)}
                            disabled={rendering}
                            className={btnGhost}
                          >
                            {rendering && activePdf === p.file ? <Loader2 size={12} className="animate-spin" /> : <Images size={12} />}
                            {activePdf === p.file ? 'Cerrar páginas' : 'Ver páginas'}
                          </button>
                        </div>
                      </div>

                      {activePdf === p.file && (
                        <div className="mt-3 rounded-lg border border-emerald-500/40 bg-emerald-500/[0.04] p-3">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-[10px] uppercase tracking-widest text-emerald-600 dark:text-emerald-400 truncate pr-2">
                              Páginas originales
                            </span>
                            <span className="flex items-center gap-2 text-[11px] text-zinc-500 shrink-0">
                              {recommended.length > 0 && (
                                <button
                                  onClick={() => setSelectedPages(recommended)}
                                  title={`Preseleccionar las páginas más visuales: ${recommended.join(', ')}`}
                                  className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400 transition-all duration-200 hover:bg-amber-500/10 active:scale-95"
                                >
                                  <Sparkles size={10} /> recomendadas
                                </button>
                              )}
                              {selectedPages.length}/{maxPages} (mín. 2)
                            </span>
                          </div>

                          {rendering ? (
                            <div className="flex items-center justify-center gap-2 py-8 text-xs text-zinc-500">
                              <Loader2 size={14} className="animate-spin" /> Renderizando páginas…
                            </div>
                          ) : pages.length === 0 ? (
                            <div className="py-4 text-xs text-rose-500 bg-rose-500/10 rounded-md px-3">
                              No se pudieron renderizar las páginas. {pdfMsg ?? 'Comprueba que el PDF no esté corrupto.'}
                            </div>
                          ) : (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                              {/* PDF viewer */}
                              <div className="flex flex-col gap-2">
                                {(() => {
                                  const current = pages.find((pg) => pg.page === viewerPage) ?? pages[0];
                                  return (
                                    <>
                                      <div className="relative rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-100 dark:bg-zinc-900/40 overflow-hidden flex items-center justify-center min-h-[200px]">
                                        <img
                                          src={fileUrl(current.full)}
                                          alt={`página ${current.page}`}
                                          className="w-full h-auto max-h-[55vh] object-contain"
                                        />
                                      </div>
                                      <div className="flex items-center justify-between gap-2">
                                        <button
                                          onClick={() => setViewerPage((n) => Math.max(1, n - 1))}
                                          disabled={viewerPage <= 1}
                                          className={btnGhost}
                                        >
                                          <ChevronLeft size={14} /> Anterior
                                        </button>
                                        <span className="text-xs text-zinc-500">Página {viewerPage} / {pages.length}</span>
                                        <button
                                          onClick={() => setViewerPage((n) => Math.min(pages.length, n + 1))}
                                          disabled={viewerPage >= pages.length}
                                          className={btnGhost}
                                        >
                                          Siguiente <ChevronRight size={14} />
                                        </button>
                                      </div>
                                    </>
                                  );
                                })()}
                              </div>

                              {/* Thumbnails + generate */}
                              <div className="flex flex-col gap-3">
                                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 overflow-y-auto max-h-[50vh] pr-1">
                                  {pages.map((pg) => {
                                    const sel = selectedPages.includes(pg.page);
                                    const disabled = !sel && selectedPages.length >= maxPages;
                                    return (
                                      <button
                                        key={pg.page}
                                        onClick={() => togglePage(pg.page)}
                                        onDoubleClick={() => setPreview(pg)}
                                        disabled={disabled}
                                        title={`Página ${pg.page}${pg.reason ? ` — ${pg.reason}` : ''}` +
                                          (typeof pg.score === 'number' ? ` (${Math.round(pg.score)}/100)` : '') +
                                          ' — doble click para ampliar'}
                                        className={`relative rounded-md overflow-hidden border transition-all duration-200 min-h-[180px] flex ${
                                          pg.page === viewerPage
                                            ? 'ring-2 ring-emerald-500/60 border-emerald-500'
                                            : sel
                                              ? 'border-emerald-500 ring-2 ring-emerald-500/40 scale-[1.02]'
                                              : disabled
                                                ? 'border-zinc-200 dark:border-zinc-800 opacity-40 cursor-not-allowed'
                                                : 'border-zinc-200 dark:border-zinc-800 hover:border-emerald-500/50 cursor-pointer'
                                        }`}
                                      >
                                        <img src={fileUrl(pg.thumb)} alt={`p${pg.page}`} className="w-full h-full min-h-[180px] object-cover object-top block" loading="lazy" />
                                        <span className="absolute bottom-1 left-1 rounded bg-black/70 text-white text-[9px] px-1 py-0.5">p{pg.page}</span>
                                        {typeof pg.score === 'number' && pg.score > 0 && (
                                          <span
                                            className="absolute bottom-1 right-1 rounded bg-black/70 text-[9px] px-1 py-0.5 text-zinc-300"
                                            title={pg.reason
                                              ? `${pg.reason} — puntuación ${pg.score}/100`
                                              : `Riqueza visual ${pg.score}/100 · ${pg.drawings ?? 0} gráficos · ${pg.words ?? 0} palabras`}
                                          >
                                            {Math.round(pg.score)}
                                          </span>
                                        )}
                                        {pg.recommended && (
                                          <span
                                            className="absolute top-1 left-1 inline-flex items-center gap-0.5 rounded bg-amber-500/90 text-white text-[8px] px-1 py-0.5"
                                            title="Página recomendada por su riqueza visual"
                                          >
                                            <Sparkles size={8} /> top
                                          </span>
                                        )}
                                        {sel && (
                                          <span className="absolute top-1 right-1 rounded-full bg-emerald-500 text-white p-0.5">
                                            <Check size={10} />
                                          </span>
                                        )}
                                      </button>
                                    );
                                  })}
                                </div>

                                <div className="space-y-2">
                                  <ModelPicker
                                    catalog={catalog}
                                    fallbackCredits={fallbackCredits}
                                    model={model}
                                    resolution={resolution}
                                    quality={quality}
                                    onModel={setModel}
                                    onResolution={setResolution}
                                    onQuality={setQuality}
                                    images={selectedPages.length * (1 + abStyles.length)}
                                    consistent={consistent}
                                    onConsistent={setConsistent}
                                  />
                                  <div className="flex items-center gap-2">
                                    <div className="flex-1 min-w-0">
                                      <Select value={styleId} onValueChange={setStyleId}>
                                        <SelectTrigger>
                                          <SelectValue placeholder="Estilo" />
                                        </SelectTrigger>
                                        <SelectContent>
                                          {presets.map((pr) => (
                                            <SelectItem key={pr.id} value={pr.id}>{pr.name}</SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                    </div>
                                    <button onClick={generate} disabled={generating || selectedPages.length < 2} className={btnPrimary}>
                                      {generating ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                                      {generating ? 'Generando…' : abStyles.length ? `Generar en ${abStyles.length + 1} estilos` : 'Generar rediseños'}
                                    </button>
                                  </div>
                                  <div>
                                    <label className="block text-[10px] uppercase tracking-widest text-zinc-500 mb-1">
                                      Paleta del informe original
                                    </label>
                                    {palette.length > 0 ? (
                                      <div className="flex items-center gap-2 flex-wrap">
                                        <button
                                          onClick={() => setUsePalette((v) => !v)}
                                          title="Añade los colores del informe al prompt como paleta obligatoria"
                                          className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] transition-all duration-200 active:scale-95 ${
                                            usePalette
                                              ? 'border-emerald-500 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                                              : 'border-zinc-300 dark:border-zinc-700 text-zinc-500 hover:border-emerald-500/50'
                                          }`}
                                        >
                                          <Palette size={11} />
                                          {usePalette ? 'paleta activada' : 'mantener colores originales'}
                                        </button>
                                        <span className="inline-flex items-center gap-1">
                                          {palette.map((c) => (
                                            <span
                                              key={c.hex}
                                              title={`${c.hex} · ${Math.round(c.share * 100)}% del documento`}
                                              className={`inline-block w-4 h-4 rounded border transition-all duration-200 ${
                                                usePalette ? 'border-emerald-500 scale-110' : 'border-zinc-300 dark:border-zinc-700'
                                              }`}
                                              style={{ backgroundColor: c.hex }}
                                            />
                                          ))}
                                        </span>
                                      </div>
                                    ) : (
                                      <span className="text-[10px] text-zinc-400 dark:text-zinc-600">
                                        No se detectaron colores dominantes en este informe.
                                      </span>
                                    )}
                                  </div>
                                  <div>
                                    <label className="block text-[10px] uppercase tracking-widest text-zinc-500 mb-1">
                                      Comparar con <span className="normal-case tracking-normal text-zinc-400 dark:text-zinc-600">(A/B, hasta 3 más)</span>
                                    </label>
                                    <div className="flex flex-wrap gap-1">
                                      {presets
                                        .filter((pr) => pr.id !== styleId)
                                        .map((pr) => {
                                          const on = abStyles.includes(pr.id);
                                          const full = !on && abStyles.length >= 3;
                                          return (
                                            <button
                                              key={pr.id}
                                              disabled={full}
                                              onClick={() => setAbStyles((a) => (on ? a.filter((x) => x !== pr.id) : [...a, pr.id]))}
                                              className={`rounded-md border px-1.5 py-0.5 text-[10px] transition-all duration-200 active:scale-95 ${
                                                on
                                                  ? 'border-emerald-500 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                                                  : full
                                                    ? 'border-zinc-200 dark:border-zinc-800 text-zinc-400 dark:text-zinc-700 cursor-not-allowed'
                                                    : 'border-zinc-300 dark:border-zinc-700 text-zinc-500 hover:border-emerald-500/50 hover:text-emerald-500'
                                              }`}
                                            >
                                              {pr.name}
                                            </button>
                                          );
                                        })}
                                    </div>
                                  </div>
                                  <div>
                                    <label className="block text-[10px] uppercase tracking-widest text-zinc-500 mb-1">
                                      Indicaciones extra <span className="normal-case tracking-normal text-zinc-400 dark:text-zinc-600">(opcional)</span>
                                    </label>
                                    <textarea
                                      value={extraPrompt}
                                      onChange={(e) => setExtraPrompt(e.target.value)}
                                      rows={2}
                                      placeholder="Ej.: mantener los colores corporativos, dar más peso a los gráficos, portada sin foto…"
                                      className={inputCls + ' resize-y'}
                                    />
                                    {extraPrompt.trim() && (
                                      <button
                                        onClick={saveStyleForLead}
                                        disabled={savingStyle}
                                        title="Guarda estilo + indicaciones como un preset propio de este cliente"
                                        className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-zinc-300 dark:border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-500 transition-all duration-200 hover:border-emerald-500/50 hover:text-emerald-600 dark:hover:text-emerald-400 active:scale-95 disabled:opacity-50"
                                      >
                                        {savingStyle ? <Loader2 size={10} className="animate-spin" /> : <Save size={10} />}
                                        Guardar como estilo de {lead.organisation.slice(0, 22)}
                                      </button>
                                    )}
                                    <button
                                      onClick={previewPrompt}
                                      disabled={loadingPrompt}
                                      title="Muestra el texto exacto que recibirá Magnific"
                                      className="mt-1.5 ml-1.5 inline-flex items-center gap-1 rounded-md border border-zinc-300 dark:border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-500 transition-all duration-200 hover:border-emerald-500/50 hover:text-emerald-600 dark:hover:text-emerald-400 active:scale-95 disabled:opacity-50"
                                    >
                                      {loadingPrompt ? <Loader2 size={10} className="animate-spin" /> : <Eye size={10} />}
                                      {promptPreview !== null ? 'Ocultar prompt' : 'Ver prompt que se enviará'}
                                    </button>
                                    {promptPreview !== null && (
                                      <pre className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-emerald-500/30 bg-zinc-100 dark:bg-zinc-900 p-2 text-[10px] leading-relaxed text-zinc-700 dark:text-zinc-300">
                                        {promptPreview}
                                      </pre>
                                    )}
                                  </div>
                                </div>
                                {genMsg && <div className="text-[11px] text-zinc-500">{genMsg}</div>}
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      <PdfGallery
                        pdfSlug={p.slug}
                        pdfTitle={decodeHtml(p.title) || p.file}
                        leadId={lead.id}
                        generated={lead.generated}
                        onPreview={openPair}
                        onHero={setHero}
                        onReveal={revealPdf}
                        focus={focusPdf && focusPdf.pdf === p.slug ? { style: focusPdf.style, key: focusPdf.key } : null}
                      />
                    </div>
                  ))}
                </div>

                {lead.generated.length > 0 && (
                  <div className="mt-4 flex items-center gap-2 flex-wrap">
                    <button onClick={buildDraft} className={btnPrimary}>
                      <Mail size={12} /> {draft ? 'Regenerar email' : 'Generar email'}
                    </button>
                    {draft && (
                      <button onClick={() => setDraftOpen(!draftOpen)} className={btnGhost}>
                        {draftOpen ? 'Ocultar draft' : 'Ver draft'}
                      </button>
                    )}
                    <span className="text-[10px] text-zinc-400 dark:text-zinc-600">
                      el PDF comparativo se genera en el panel Antes / Después de cada report
                    </span>
                  </div>
                )}
                {draft && draftOpen && (
                  <div className="mt-2">
                    <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={12} className={inputCls + ' font-mono text-[10px] leading-relaxed'} />
                    <div className="flex gap-2 mt-2">
                      <button onClick={copyDraft} className={btnGhost}>
                        {copied ? <Check size={12} /> : <Copy size={12} />}
                        {copied ? '¡Copiado!' : 'Copiar HTML'}
                      </button>
                      <button onClick={() => onPatch(lead.id, { email_draft: draft })} className={btnGhost}>
                        <Save size={12} /> Guardar draft
                      </button>
                    </div>
                  </div>
                )}
              </section>

              {/* NOTES (full width, at the end) */}
              <section>
                <h3 className="text-[10px] uppercase tracking-widest text-zinc-500 mb-2">Notas</h3>
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} className={inputCls} placeholder="Notas sobre este lead…" />
                <button onClick={() => onPatch(lead.id, { notes })} className={btnGhost + ' mt-2'}>
                  <Save size={12} /> Guardar notas
                </button>
              </section>

              {/* TIMELINE (full width, at the end) */}
              {timeline.length > 0 && (
                <section>
                  <h3 className="text-[10px] uppercase tracking-widest text-zinc-500 mb-2">Timeline</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {timeline.map((t, i) => (
                      <div key={i} className="flex gap-2 text-[11px] rounded-lg border border-zinc-200 dark:border-zinc-800 px-3 py-2 transition-all duration-200 hover:border-emerald-500/30">
                        <span className="text-zinc-400 dark:text-zinc-600 shrink-0 w-20">{fmtDate(t.date)}</span>
                        <span className="text-zinc-600 dark:text-zinc-400">
                          <span className="text-zinc-400 dark:text-zinc-500">[{t.type}]</span> {t.text}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* credit budget confirmation */}
      {budgetAsk && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-6" onClick={() => setBudgetAsk(null)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative w-full max-w-md rounded-2xl border border-amber-500/40 bg-white dark:bg-[#0d0d0f] shadow-2xl p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="flex items-center gap-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">
              <Coins size={14} className="text-amber-500" /> Tope de créditos
            </h3>
            <p className="mt-2 text-[11px] text-zinc-600 dark:text-zinc-400">{budgetAsk.error}</p>
            <p className="mt-2 text-[10px] text-zinc-500">
              Los topes se configuran en <code>settings.json</code> → <code>budget</code>.
            </p>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button onClick={() => setBudgetAsk(null)} className={btnGhost}>Cancelar</button>
              <button
                onClick={budgetAsk.retry}
                className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs text-white transition-all duration-200 hover:bg-amber-500 active:scale-[0.97]"
              >
                <Wand2 size={12} /> Generar igualmente
              </button>
            </div>
          </div>
        </div>
      )}

      {/* delete-report confirmation */}
      {pdfToDelete && (() => {
        const attached = lead.generated.filter((g) => g.pdf === pdfToDelete.slug);
        return (
          <div className="fixed inset-0 z-[75] flex items-center justify-center p-6" onClick={() => !deletingPdf && setPdfToDelete(null)}>
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <div
              className="relative w-full max-w-md rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#0d0d0f] shadow-2xl p-5"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="flex items-center gap-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">
                <Trash2 size={14} className="text-rose-500" /> Eliminar report
              </h3>
              <p className="mt-2 text-[11px] text-zinc-600 dark:text-zinc-400 break-words">
                {decodeHtml(pdfToDelete.title) || pdfToDelete.file}
              </p>

              {attached.length > 0 ? (
                <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2">
                  <p className="text-[11px] text-amber-700 dark:text-amber-400">
                    Este PDF tiene <strong>{attached.length} rediseño(s)</strong> generados
                    {attached.some((g) => g.hero) ? ', uno de ellos marcado como ganador' : ''}.
                    Consumieron créditos de Magnific: decide qué hacer con ellos.
                  </p>
                </div>
              ) : (
                <p className="mt-3 text-[11px] text-zinc-500">
                  Se borrarán el archivo y las páginas renderizadas. No hay rediseños asociados.
                </p>
              )}

              <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
                <button onClick={() => setPdfToDelete(null)} disabled={deletingPdf} className={btnGhost}>
                  Cancelar
                </button>
                {attached.length > 0 && (
                  <button
                    onClick={() => deletePdf(pdfToDelete, true)}
                    disabled={deletingPdf}
                    className={btnGhost}
                  >
                    {deletingPdf ? <Loader2 size={12} className="animate-spin" /> : <Star size={12} />}
                    Conservar rediseños
                  </button>
                )}
                <button
                  onClick={() => deletePdf(pdfToDelete, false)}
                  disabled={deletingPdf}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-rose-600 px-3 py-1.5 text-xs text-white transition-all duration-200 hover:bg-rose-500 hover:scale-[1.02] active:scale-[0.97] disabled:opacity-50"
                >
                  {deletingPdf ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                  {attached.length > 0 ? `Eliminar todo (${attached.length + 1})` : 'Eliminar'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* full page preview overlay */}
      {preview && (
        <div className="fixed inset-0 z-[60] bg-black/80 backdrop-blur flex items-center justify-center p-8" onClick={() => setPreview(null)}>
          <img src={fileUrl(preview.full)} alt={`página ${preview.page}`} className="max-h-full max-w-full rounded-lg shadow-2xl" />
        </div>
      )}

      {/* before/after fullscreen modal */}
      {livePair && (
        <BeforeAfterModal
          item={livePair}
          all={lead.generated}
          scope={pairScope.items}
          scopeLabel={pairScope.label}
          organisation={lead.organisation}
          stylePresets={stylePresets}
          generating={generating}
          onClose={() => setPairPreview(null)}
          onSelect={setPairPreview}
          onHero={setHero}
          onGenerateStyles={generateStylesForPage}
          onRegenerate={regenerate}
          leadId={lead.id}
        />
      )}

    </>
  );
}
