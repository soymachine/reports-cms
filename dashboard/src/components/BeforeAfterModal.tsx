import React, { useEffect, useMemo, useState } from 'react';
import {
  X, Star, Wand2, Loader2, Columns2, Grid2x2, ChevronLeft, ChevronRight,
  SlidersHorizontal, RefreshCw, Download, History, ShieldCheck, ShieldAlert, Shield,
} from 'lucide-react';
import type { GeneratedItem, StylePreset } from '../lib/types';
import { fileUrl } from '../lib/types';
import { pickForPage } from '../lib/runs';

interface Props {
  item: GeneratedItem;                 // the pair the user clicked
  all: GeneratedItem[];                // every redesign of this lead
  /** el conjunto desde el que se abrió: el pase que se está mirando, o lo vigente */
  scope?: GeneratedItem[];
  /** «Pase 2» cuando se mira uno anterior; null cuando es lo vigente */
  scopeLabel?: string | null;
  organisation: string;
  stylePresets: StylePreset[];
  generating: boolean;
  onClose: () => void;
  onSelect: (item: GeneratedItem) => void;
  onHero: (item: GeneratedItem) => void;
  onGenerateStyles: (styleIds: string[], page: number, pdfSlug: string) => void;
  onRegenerate: (item: GeneratedItem, feedback: string, base: 'original' | 'current') => void;
  leadId: number;
}

type Mode = 'pair' | 'grid' | 'slider';

export default function BeforeAfterModal({
  item, all, scope = [], scopeLabel = null, organisation, stylePresets, generating,
  onClose, onSelect, onHero, onGenerateStyles, onRegenerate, leadId,
}: Props) {
  const [mode, setMode] = useState<Mode>('pair');
  const [picker, setPicker] = useState(false);
  const [wanted, setWanted] = useState<string[]>([]);
  const [redo, setRedo] = useState(false);
  const [feedback, setFeedback] = useState('');
  // which image the redo starts from: the untouched PDF page or this redesign
  const [redoBase, setRedoBase] = useState<'original' | 'current'>('original');
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [showVersions, setShowVersions] = useState(false);
  const [split, setSplit] = useState(50);

  // every style generated for this exact page of this exact report
  const siblings = useMemo(
    () => all.filter((g) => g.pdf === item.pdf && g.page === item.page && !g.superseded)
             .sort((a, b) => String(a.styleName).localeCompare(String(b.styleName))),
    [all, item.pdf, item.page]
  );

  // earlier attempts at this exact style, newest first
  const versions = useMemo(
    () => all.filter((g) => g.pdf === item.pdf && g.page === item.page && g.style === item.style)
             .sort((a, b) => (b.version ?? 1) - (a.version ?? 1)),
    [all, item.pdf, item.page, item.style]
  );

  // A rerun used to overwrite the previous file, so two versions can point at the
  // same image: the older one's pixels are gone and picking it would show the newer
  // one. Flag those instead of offering a button that does nothing.
  const lostVersions = useMemo(() => {
    const seen = new Set<string>();
    const lost = new Set<string>();
    for (const v of versions) {            // newest first
      if (seen.has(v.generated_img)) lost.add(`${v.version ?? 1}-${v.generated_img}`);
      else seen.add(v.generated_img);
    }
    return lost;
  }, [versions]);

  // Las páginas por las que se puede pasar: las del conjunto abierto cuando lo
  // hay —así un pase anterior se recorre entero— y si no, las del informe.
  const pages = useMemo(
    () => Array.from(new Set(
      (scope.length ? scope : all.filter((g) => g.pdf === item.pdf)).map((g) => g.page)
    )).sort((a, b) => a - b),
    [all, scope, item.pdf]
  );
  const pageIdx = pages.indexOf(item.page);

  const missingStyles = useMemo(
    () => stylePresets.filter((p) => !siblings.some((g) => g.style === p.id)),
    [stylePresets, siblings]
  );

  useEffect(() => { setWanted([]); setPicker(false); setRedo(false); setRedoBase('original'); setExportMsg(null); }, [item.page, item.pdf]);

  const exportPair = async (format: 'slide' | 'square' | 'story' | 'raw') => {
    setExporting(true);
    setExportMsg(null);
    try {
      const res = await fetch('/api/export-pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lead_id: leadId, original: item.original_img, generated: item.generated_img,
          format, label: item.styleName, page: item.page,
        }),
      });
      const data = await res.json();
      setExportMsg(data.ok ? `✓ ${data.width}×${data.height}` : `✗ ${data.error}`);
      if (data.ok) window.open(`/api/file?path=${encodeURIComponent(data.file)}`, '_blank');
    } catch (e) {
      setExportMsg(`✗ ${String(e)}`);
    } finally {
      setExporting(false);
    }
  };

  const goPage = (dir: -1 | 1) => {
    const next = pages[pageIdx + dir];
    if (next == null) return;
    const target = pickForPage(scope, all, item.pdf, next, item.style);
    if (target) onSelect(target);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); goPage(1); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); goPage(-1); }
      if (e.key >= '1' && e.key <= '9') {
        const target = siblings[Number(e.key) - 1];
        if (target) onSelect(target);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [siblings, pages, pageIdx, item]);

  const launch = () => {
    if (!wanted.length) return;
    onGenerateStyles(wanted, item.page, item.pdf);
    setPicker(false);
    setWanted([]);
  };

  return (
    <div className="fixed inset-0 z-[70] bg-black/85 backdrop-blur flex flex-col p-5" onClick={onClose}>
      {/* header */}
      <div className="flex items-center justify-between gap-3 max-w-[100rem] w-full mx-auto mb-2" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[11px] uppercase tracking-widest text-zinc-400 truncate">
            {organisation} — página {item.page}
          </span>
          {scopeLabel && (
            <span
              className="shrink-0 rounded border border-amber-500/60 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-400"
              title="Estás comparando un pase anterior; las flechas recorren ese pase"
            >
              {scopeLabel}
            </span>
          )}
          {pages.length > 1 && (
            <span className="inline-flex items-center gap-1">
              <button
                onClick={() => goPage(-1)}
                disabled={pageIdx <= 0}
                title="Página anterior (←)"
                className="p-1 rounded text-zinc-500 transition-all duration-200 hover:text-emerald-400 disabled:opacity-30"
              >
                <ChevronLeft size={13} />
              </button>
              <span className="text-[10px] text-zinc-500 tabular-nums">{pageIdx + 1}/{pages.length}</span>
              <button
                onClick={() => goPage(1)}
                disabled={pageIdx >= pages.length - 1}
                title="Página siguiente (→)"
                className="p-1 rounded text-zinc-500 transition-all duration-200 hover:text-emerald-400 disabled:opacity-30"
              >
                <ChevronRight size={13} />
              </button>
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <QcBadge qc={item.qc} />

          <button
            onClick={() => setMode(mode === 'slider' ? 'pair' : 'slider')}
            title="Comparar con deslizador"
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] transition-all duration-200 active:scale-95 ${
              mode === 'slider' ? 'border-emerald-500 text-emerald-400' : 'border-zinc-700 text-zinc-300 hover:border-emerald-500/60 hover:text-emerald-400'
            }`}
          >
            <SlidersHorizontal size={12} /> Deslizador
          </button>

          {siblings.length > 1 && (
            <button
              onClick={() => setMode(mode === 'grid' ? 'pair' : 'grid')}
              title={mode === 'grid' ? 'Ver antes / después' : 'Ver todos los estilos a la vez'}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] transition-all duration-200 active:scale-95 ${
                mode === 'grid' ? 'border-emerald-500 text-emerald-400' : 'border-zinc-700 text-zinc-300 hover:border-emerald-500/60 hover:text-emerald-400'
              }`}
            >
              {mode === 'grid' ? <Columns2 size={12} /> : <Grid2x2 size={12} />}
              {mode === 'grid' ? 'Antes / después' : `Comparar ${siblings.length}`}
            </button>
          )}

          {versions.length > 1 && (
            <button
              onClick={() => setShowVersions((v) => !v)}
              title="Versiones anteriores de este estilo"
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] transition-all duration-200 active:scale-95 ${
                showVersions ? 'border-emerald-500 text-emerald-400' : 'border-zinc-700 text-zinc-300 hover:border-emerald-500/60 hover:text-emerald-400'
              }`}
            >
              <History size={12} /> v{item.version ?? 1}/{versions.length}
            </button>
          )}

          <button
            onClick={() => { setRedo((v) => !v); setPicker(false); }}
            disabled={generating}
            title="Rehacer esta imagen indicando qué falló"
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] transition-all duration-200 active:scale-95 disabled:opacity-40 ${
              redo
                ? 'border-amber-500 bg-amber-500/15 text-amber-400'
                : 'border-zinc-700 text-zinc-300 hover:border-amber-500/60 hover:text-amber-400'
            }`}
          >
            {generating ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Rehacer
          </button>
          <button
            onClick={() => setPicker((v) => !v)}
            disabled={generating || missingStyles.length === 0}
            title={missingStyles.length ? 'Generar esta página en otros estilos' : 'Ya están generados todos los estilos'}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-2.5 py-1 text-[11px] text-white transition-all duration-200 hover:bg-emerald-500 active:scale-95 disabled:opacity-40"
          >
            {generating ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
            Más estilos
          </button>
          <span className="inline-flex items-center rounded-lg border border-zinc-700 overflow-hidden">
            <span className="px-1.5 text-[10px] text-zinc-500 inline-flex items-center gap-1">
              {exporting ? <Loader2 size={10} className="animate-spin" /> : <Download size={10} />}
            </span>
            {(['slide', 'square', 'story'] as const).map((f) => (
              <button
                key={f}
                onClick={() => exportPair(f)}
                disabled={exporting}
                title={`Exportar como imagen ${f === 'slide' ? '16:9' : f === 'square' ? '1:1' : '9:16'}`}
                className="px-1.5 py-1 text-[10px] text-zinc-300 transition-colors duration-200 hover:text-emerald-400 disabled:opacity-40"
              >
                {f === 'slide' ? '16:9' : f === 'square' ? '1:1' : '9:16'}
              </button>
            ))}
          </span>

          <button onClick={onClose} title="Cerrar (ESC)" className="p-2 rounded-lg text-zinc-400 transition-all duration-200 hover:scale-110 hover:text-rose-400 hover:bg-rose-500/10 active:scale-95">
            <X size={16} />
          </button>
        </div>
      </div>

      {/* style tabs */}
      {siblings.length > 1 && mode === 'pair' && (
        <div className="flex items-center gap-1.5 flex-wrap max-w-[100rem] w-full mx-auto mb-2" onClick={(e) => e.stopPropagation()}>
          {siblings.map((g, i) => {
            const on = g.style === item.style;
            return (
              <button
                key={g.style}
                onClick={() => onSelect(g)}
                title={g.extra_prompt ? `Indicaciones: ${g.extra_prompt}` : g.style_prompt}
                className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] transition-all duration-200 active:scale-95 ${
                  on
                    ? 'border-emerald-500 bg-emerald-500/15 text-emerald-400'
                    : 'border-zinc-700 text-zinc-400 hover:border-emerald-500/50 hover:text-emerald-400'
                }`}
              >
                <span className="text-zinc-600">{i + 1}</span>
                {g.styleName}
                {g.hero && <Star size={9} fill="currentColor" className="text-amber-400" />}
              </button>
            );
          })}
        </div>
      )}

      {/* regenerate with feedback */}
      {redo && (
        <div className="max-w-[100rem] w-full mx-auto mb-2 rounded-lg border border-amber-500/40 bg-zinc-900/90 p-3" onClick={(e) => e.stopPropagation()}>
          <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
            <span className="text-[10px] uppercase tracking-widest text-amber-400">
              Rehacer página {item.page} — {item.styleName}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="text-[10px] text-zinc-500">Partir de</span>
              <span className="inline-flex items-center rounded-md border border-zinc-700 overflow-hidden">
                {([
                  ['original', 'Original', 'Rediseñar otra vez la página del PDF'],
                  ['current', 'Este rediseño', 'Retocar la imagen actual conservando su diseño'],
                ] as const).map(([id, label, hint]) => (
                  <button
                    key={id}
                    onClick={() => setRedoBase(id)}
                    title={hint}
                    className={`px-2 py-0.5 text-[10px] transition-colors duration-200 ${
                      redoBase === id ? 'bg-amber-500/15 text-amber-400' : 'text-zinc-400 hover:text-amber-400'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </span>
            </span>
          </div>
          <textarea
            autoFocus
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={2}
            placeholder={redoBase === 'current'
              ? 'Qué cambiar de este rediseño: el titular más grande, cambia el azul por verde…'
              : 'Qué falló: los números no se leen, respeta el logo, menos saturación…'}
            className="w-full rounded-lg bg-zinc-950 border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-200 transition-all duration-200 focus:border-amber-500 focus:outline-none resize-y"
          />
          <div className="flex items-center justify-between gap-2 mt-2">
            <span className="text-[10px] text-zinc-500">
              {redoBase === 'current'
                ? 'Se parte de esta imagen ya rediseñada y solo se aplican tus cambios. La versión actual se guarda en el historial.'
                : 'Se parte de la página original del PDF. Se conserva el prompt y se añade tu corrección. La versión actual se guarda en el historial.'}
            </span>
            <button
              onClick={() => { onRegenerate(item, feedback.trim(), redoBase); setRedo(false); setFeedback(''); }}
              disabled={generating || !feedback.trim()}
              className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-2.5 py-1 text-[11px] text-white transition-all duration-200 hover:bg-amber-500 active:scale-95 disabled:opacity-40"
            >
              {generating ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />} Rehacer
            </button>
          </div>
        </div>
      )}

      {/* version history */}
      {showVersions && versions.length > 1 && (
        <div className="max-w-[100rem] w-full mx-auto mb-2 flex items-center gap-2 flex-wrap" onClick={(e) => e.stopPropagation()}>
          <span className="text-[10px] uppercase tracking-widest text-zinc-500">Versiones</span>
          {versions.map((v) => {
            const key = `${v.version ?? 1}-${v.generated_img}`;
            const lost = lostVersions.has(key);
            const on = !lost && v.generated_img === item.generated_img;
            return (
              <button
                key={key}
                onClick={() => !lost && onSelect(v)}
                disabled={lost}
                title={lost
                  ? 'La imagen de esta versión se perdió: una regeneración posterior sobrescribió el archivo'
                  : v.feedback ? `Corrección: ${v.feedback}` : 'versión inicial'}
                className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] transition-all duration-200 ${
                  lost
                    ? 'border-zinc-800 text-zinc-600 line-through cursor-not-allowed'
                    : on
                      ? 'border-emerald-500 bg-emerald-500/15 text-emerald-400 active:scale-95'
                      : 'border-zinc-700 text-zinc-400 hover:border-emerald-500/50 hover:text-emerald-400 active:scale-95'
                }`}
              >
                v{v.version ?? 1}
                {lost
                  ? <span className="text-zinc-600">sin imagen</span>
                  : v.superseded ? <span className="text-zinc-600">antigua</span> : <span className="text-emerald-500">actual</span>}
              </button>
            );
          })}
        </div>
      )}

      {/* style picker */}
      {picker && (
        <div
          className="max-w-[100rem] w-full mx-auto mb-2 rounded-lg border border-emerald-500/40 bg-zinc-900/90 p-3"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between gap-2 mb-2">
            <span className="text-[10px] uppercase tracking-widest text-emerald-400">
              Generar la página {item.page} en otros estilos
            </span>
            <button onClick={launch} disabled={!wanted.length || generating} className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-2.5 py-1 text-[11px] text-white transition-all duration-200 hover:bg-emerald-500 active:scale-95 disabled:opacity-40">
              {generating ? <Loader2 size={11} className="animate-spin" /> : <Wand2 size={11} />}
              Generar {wanted.length || ''}
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {missingStyles.map((p) => {
              const on = wanted.includes(p.id);
              return (
                <button
                  key={p.id}
                  onClick={() => setWanted((w) => (on ? w.filter((x) => x !== p.id) : [...w, p.id]))}
                  className={`rounded-md border px-2 py-0.5 text-[10px] transition-all duration-200 active:scale-95 ${
                    on ? 'border-emerald-500 bg-emerald-500/15 text-emerald-400' : 'border-zinc-700 text-zinc-400 hover:border-emerald-500/50 hover:text-emerald-400'
                  }`}
                >
                  {p.name}
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-[10px] text-zinc-500">
            Se lanza un trabajo por estilo. Aparecerán aquí en cuanto terminen.
          </p>
        </div>
      )}

      {/* body */}
      <div className="flex-1 flex items-stretch justify-center gap-3 max-w-[100rem] w-full mx-auto min-h-0" onClick={(e) => e.stopPropagation()}>
        {mode === 'slider' ? (
          <SliderCompare before={item.original_img} after={item.generated_img} split={split} onSplit={setSplit} />
        ) : mode === 'pair' ? (
          <>
            <Pane label="Antes" tone="text-zinc-500" src={item.original_img} alt={`antes p${item.page}`} border="border-zinc-700" />
            <Pane
              label={item.styleName}
              tone="text-emerald-400"
              src={item.generated_img}
              alt={`después p${item.page}`}
              border="border-emerald-500/40"
              hero={item.hero}
              onHero={() => onHero(item)}
            />
          </>
        ) : (
          <>
            <Pane label="Antes" tone="text-zinc-500" src={item.original_img} alt={`antes p${item.page}`} border="border-zinc-700" />
            {siblings.map((g) => (
              <Pane
                key={g.style}
                label={g.styleName}
                tone={g.style === item.style ? 'text-emerald-400' : 'text-zinc-400'}
                src={g.generated_img}
                alt={`${g.styleName} p${g.page}`}
                border={g.style === item.style ? 'border-emerald-500/60' : 'border-zinc-700'}
                hero={g.hero}
                onHero={() => onHero(g)}
                onClick={() => { setMode('pair'); onSelect(g); }}
              />
            ))}
          </>
        )}
      </div>

      <div className="text-center text-[10px] text-zinc-500 mt-2">
        {exportMsg ? <span className="mr-3 text-zinc-400">{exportMsg}</span> : null}
        ESC cierra · ←/→ cambia de página · 1-9 cambia de estilo · ★ marca el ganador
      </div>
    </div>
  );
}

function QcBadge({ qc }: { qc: GeneratedItem['qc'] }) {
  if (!qc) return null;
  if (!qc.ok) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-zinc-700 px-1.5 py-0.5 text-[9px] text-zinc-500" title={qc.error ?? 'sin comprobación'}>
        <Shield size={9} /> sin QC
      </span>
    );
  }
  const map = {
    clean: { cls: 'border-emerald-500/50 text-emerald-400', icon: <ShieldCheck size={9} />, label: 'datos OK' },
    warning: { cls: 'border-amber-500/50 text-amber-400', icon: <ShieldAlert size={9} />, label: 'revisar cifras' },
    fail: { cls: 'border-rose-500/50 text-rose-400', icon: <ShieldAlert size={9} />, label: 'cifras perdidas' },
    unknown: { cls: 'border-zinc-700 text-zinc-500', icon: <Shield size={9} />, label: 'sin cifras' },
  } as const;
  const v = map[qc.verdict ?? 'unknown'];
  const detail = [
    qc.total_original != null ? `${qc.kept}/${qc.total_original} cifras conservadas` : '',
    qc.missing?.length ? `faltan: ${qc.missing.slice(0, 8).join(', ')}` : '',
    qc.invented?.length ? `aparecen nuevas: ${qc.invented.slice(0, 8).join(', ')}` : '',
  ].filter(Boolean).join('\n');

  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[9px] ${v.cls}`} title={detail}>
      {v.icon} {v.label}
    </span>
  );
}

function SliderCompare({ before, after, split, onSplit }: {
  before: string; after: string; split: number; onSplit: (n: number) => void;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  // The redesign rarely has the exact aspect of the original render. For the
  // wipe to mean anything both images must occupy the same rectangle, so the
  // frame takes the redesign's ratio and both fill it.
  const [ratio, setRatio] = React.useState<number | null>(null);

  const drag = (clientX: number) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    onSplit(Math.min(100, Math.max(0, ((clientX - box.left) / box.width) * 100)));
  };

  return (
    <div className="flex-1 min-h-0 flex items-center justify-center">
      <div
        ref={ref}
        className="relative select-none overflow-hidden rounded-lg border border-zinc-700 shadow-2xl"
        style={{ aspectRatio: ratio ?? 0.75, maxHeight: '100%', maxWidth: '100%', height: '100%' }}
        onMouseMove={(e) => e.buttons === 1 && drag(e.clientX)}
        onMouseDown={(e) => drag(e.clientX)}
        onTouchMove={(e) => drag(e.touches[0].clientX)}
      >
        <img
          src={fileUrl(after)}
          alt="después"
          onLoad={(e) => {
            const img = e.currentTarget;
            if (img.naturalWidth && img.naturalHeight) setRatio(img.naturalWidth / img.naturalHeight);
          }}
          className="absolute inset-0 w-full h-full object-cover"
        />
        {/* clip-path keeps the before image at full frame size and simply hides
            the right-hand part: no width maths, so the two always line up */}
        <img
          src={fileUrl(before)}
          alt="antes"
          className="absolute inset-0 w-full h-full object-cover"
          style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}
        />
        <div className="absolute top-0 bottom-0 w-0.5 bg-emerald-400 cursor-col-resize" style={{ left: `${split}%` }}>
          <span className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 left-0 flex h-7 w-7 items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg">
            <SlidersHorizontal size={12} />
          </span>
        </div>
        <span className="absolute top-2 left-2 rounded bg-black/70 px-1.5 py-0.5 text-[9px] uppercase tracking-widest text-zinc-300">Antes</span>
        <span className="absolute top-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-[9px] uppercase tracking-widest text-emerald-400">Después</span>
      </div>
    </div>
  );
}

function Pane({
  label, tone, src, alt, border, hero, onHero, onClick,
}: {
  label: string;
  tone: string;
  src: string;
  alt: string;
  border: string;
  hero?: boolean;
  onHero?: () => void;
  onClick?: () => void;
}) {
  return (
    <div className="flex flex-col flex-1 min-w-0">
      <div className="flex items-center justify-center gap-1.5 mb-1.5">
        <span className={`text-[10px] uppercase tracking-widest truncate ${tone}`}>{label}</span>
        {onHero && (
          <button
            onClick={onHero}
            title={hero ? 'Quitar como ganador' : 'Marcar como ganador'}
            className={`p-0.5 rounded transition-all duration-200 hover:scale-110 active:scale-95 ${hero ? 'text-amber-400' : 'text-zinc-600 hover:text-amber-400'}`}
          >
            <Star size={11} fill={hero ? 'currentColor' : 'none'} />
          </button>
        )}
      </div>
      <div className={`flex-1 min-h-0 flex items-center justify-center ${onClick ? 'cursor-pointer' : ''}`} onClick={onClick}>
        <img
          src={fileUrl(src)}
          alt={alt}
          className={`max-h-full max-w-full object-contain rounded-lg border shadow-2xl transition-all duration-200 ${border} ${onClick ? 'hover:scale-[1.01]' : ''}`}
        />
      </div>
    </div>
  );
}
