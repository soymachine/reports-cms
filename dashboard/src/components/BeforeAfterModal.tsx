import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Star, Wand2, Loader2, Columns2, Grid2x2, ChevronLeft, ChevronRight,
  SlidersHorizontal, RefreshCw, Download, History, ShieldCheck, ShieldAlert, Shield,
  ZoomIn, ZoomOut, Info, Keyboard, Copy, Check, Rows3, Layers, Contrast,
} from 'lucide-react';
import type { GeneratedItem, StylePreset } from '../lib/types';
import { fileUrl, pageThumb } from '../lib/types';
import SmartImg from './SmartImg';

interface Props {
  item: GeneratedItem;                 // the pair the user clicked
  all: GeneratedItem[];                // every redesign of this lead
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
/** what the grid puts side by side: one card per style, or one card per version */
type Compare = 'styles' | 'versions';
/** the surround changes how a design reads, so it is the user's choice */
type Backdrop = 'dark' | 'grey' | 'light';

interface Lens { s: number; x: number; y: number }

const NO_LENS: Lens = { s: 1, x: 0, y: 0 };

const GRID_IMG = 'h-full w-auto max-w-none object-contain rounded bg-white';

// a grid card is its images side by side, plus the label and the frame around them
const CARD_CHROME = 30;   // px: header line + padding + border
const CARD_PAD = 10;      // px: inner padding
const CARD_INNER_GAP = 6; // px: between the "antes" and the "después"
const CARD_GAP = 12;      // px: between cards

const BACKDROP: Record<Backdrop, string> = {
  dark: 'bg-black/85',
  grey: 'bg-zinc-500/90',
  light: 'bg-zinc-200/95',
};

/* ---------- remembered view preferences ---------- */

const PREFS_KEY = 'thinkthings.beforeafter.v1';

interface Prefs {
  mode: Mode;
  compare: Compare;
  scale: number;        // card height in the grid, as a share of the viewport
  backdrop: Backdrop;
  withBefore: boolean;  // each grid card carries its own "antes"
  hideFailed: boolean;  // drop the redesigns whose data check failed
}

const DEFAULT_PREFS: Prefs = {
  mode: 'pair', compare: 'styles', scale: 1, backdrop: 'dark', withBefore: true, hideFailed: false,
};

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

/* ---------- helpers ---------- */

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function clampLens(l: Lens): Lens {
  const m = (l.s - 1) / 2;
  return { s: l.s, x: clamp(l.x, -m, m), y: clamp(l.y, -m, m) };
}

/** Zoom keeping the point under the cursor (cx, cy, as a share off the centre) still. */
function zoomAt(l: Lens, cx: number, cy: number, factor: number): Lens {
  const s = clamp(l.s * factor, 1, 8);
  if (s === l.s) return l;
  const px = (cx - l.x) / l.s;
  const py = (cy - l.y) / l.s;
  return clampLens({ s, x: cx - s * px, y: cy - s * py });
}

/** Keys the comparator owns: swallowed so they never reach the page or a field. */
const HANDLED_KEYS = new Set([
  'ArrowRight', 'ArrowLeft', '[', ']', ' ', 'g', 's', 'v', 'b', 'f', 'h', 'i', 'r',
  '?', '/', '+', '=', '-', '_', '0',
]);

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
};

const baseName = (p: string) => p.split('/').pop() || 'rediseno.png';

export default function BeforeAfterModal({
  item, all, organisation, stylePresets, generating, onClose, onSelect, onHero,
  onGenerateStyles, onRegenerate, leadId,
}: Props) {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [prefsReady, setPrefsReady] = useState(false);
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
  const [flip, setFlip] = useState(false);       // A/B blink: show the "después" whole
  const [autoFlip, setAutoFlip] = useState(false);
  const [lens, setLens] = useState<Lens>(NO_LENS);
  const [info, setInfo] = useState(false);
  const [help, setHelp] = useState(false);
  const [copied, setCopied] = useState(false);
  // measured aspect ratios, so "una fila" can work out how much room the cards need
  const [ratios, setRatios] = useState<Record<string, number>>({});

  const bodyRef = useRef<HTMLDivElement>(null);
  // the cards are sized in pixels: an <img> reports its natural width as its
  // intrinsic size, so left to itself every card would claim a whole row
  const [box, setBox] = useState({ w: 1200, h: 700 });

  useEffect(() => {
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // localStorage is only there in the browser, and can throw in private windows
  useEffect(() => { setPrefs(loadPrefs()); setPrefsReady(true); }, []);
  useEffect(() => {
    if (!prefsReady) return;
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* not worth a warning */ }
  }, [prefs, prefsReady]);

  const patch = useCallback((p: Partial<Prefs>) => setPrefs((v) => ({ ...v, ...p })), []);
  const { mode, scale, backdrop, withBefore, hideFailed } = prefs;
  const setMode = (m: Mode) => patch({ mode: m });

  // every style generated for this exact page of this exact report
  const siblings = useMemo(
    () => all.filter((g) => g.pdf === item.pdf && g.page === item.page && !g.superseded)
             .sort((a, b) => Number(Boolean(b.hero)) - Number(Boolean(a.hero)) ||
                             String(a.styleName).localeCompare(String(b.styleName))),
    [all, item.pdf, item.page]
  );

  // earlier attempts at this exact style, newest first
  const versions = useMemo(
    () => all.filter((g) => g.pdf === item.pdf && g.page === item.page && g.style === item.style)
             .sort((a, b) => (b.version ?? 1) - (a.version ?? 1)),
    [all, item.pdf, item.page, item.style]
  );

  // A style tried only once has nothing to compare: fall back to the styles
  // rather than showing a grid of one card.
  const compare: Compare = prefs.compare === 'versions' && versions.length > 1 ? 'versions' : 'styles';

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

  // pages of this report that have at least one redesign, for prev/next
  const pages = useMemo(
    () => Array.from(new Set(all.filter((g) => g.pdf === item.pdf).map((g) => g.page))).sort((a, b) => a - b),
    [all, item.pdf]
  );
  const pageIdx = pages.indexOf(item.page);

  const missingStyles = useMemo(
    () => stylePresets.filter((p) => !siblings.some((g) => g.style === p.id)),
    [stylePresets, siblings]
  );

  // what the grid lays out: the styles of this page, or the versions of this style
  const gridItems = useMemo(() => {
    const list = compare === 'versions'
      ? versions.filter((v) => !lostVersions.has(`${v.version ?? 1}-${v.generated_img}`))
      : siblings;
    return hideFailed && compare === 'styles'
      ? list.filter((g) => g.qc?.verdict !== 'fail' || g.generated_img === item.generated_img)
      : list;
  }, [compare, versions, lostVersions, siblings, hideFailed, item.generated_img]);

  const failedCount = useMemo(() => siblings.filter((g) => g.qc?.verdict === 'fail').length, [siblings]);

  useEffect(() => {
    setWanted([]); setPicker(false); setRedo(false); setRedoBase('original'); setExportMsg(null);
    setLens(NO_LENS); setFlip(false); setAutoFlip(false);
  }, [item.page, item.pdf]);

  useEffect(() => { setLens(NO_LENS); }, [item.generated_img]);

  // the A/B blink runs on its own while it is on
  useEffect(() => {
    if (!autoFlip) return;
    const t = window.setInterval(() => setFlip((v) => !v), 750);
    return () => window.clearInterval(t);
  }, [autoFlip]);

  // neighbouring styles and pages are one keystroke away: have them in cache
  useEffect(() => {
    const near = [
      ...siblings.map((g) => g.generated_img),
      ...[pages[pageIdx - 1], pages[pageIdx + 1]]
        .filter((p) => p != null)
        .flatMap((p) => all.filter((g) => g.pdf === item.pdf && g.page === p && !g.superseded))
        .flatMap((g) => [g.original_img, g.generated_img]),
    ];
    const loaders = near.slice(0, 14).map((src) => {
      const img = new Image();
      img.src = fileUrl(src);
      return img;
    });
    return () => loaders.forEach((img) => { img.src = ''; });
  }, [all, siblings, pages, pageIdx, item.pdf]);

  const noteRatio = useCallback((src: string, r: number) => {
    setRatios((prev) => (prev[src] && Math.abs(prev[src] - r) < 0.01 ? prev : { ...prev, [src]: r }));
  }, []);
  const ratioOf = useCallback((src: string) => ratios[src] ?? 0.75, [ratios]);

  const cardHeight = useCallback((s: number) => Math.max(70, box.h * s), [box.h]);

  /** How wide a card ends up, given how tall it is drawn. */
  const cardWidth = useCallback((g: GeneratedItem, s: number, before: boolean) => {
    const imgH = Math.max(40, cardHeight(s) - CARD_CHROME);
    const after = ratioOf(g.generated_img) * imgH;
    return (before ? ratioOf(g.original_img) * imgH + CARD_INNER_GAP : 0) + after + CARD_PAD;
  }, [cardHeight, ratioOf]);

  /** Shrink the cards just enough for every one of them to sit on a single row. */
  const fitOneRow = useCallback(() => {
    if (!gridItems.length) return;
    const extra = withBefore ? 0 : cardWidth(item, 1, true) - cardWidth(item, 1, false) + CARD_GAP;
    let s = 1;
    for (let i = 0; i < 5; i++) {
      const total = gridItems.reduce((acc, g) => acc + cardWidth(g, s, withBefore), 0)
        + CARD_GAP * (gridItems.length - 1) + (withBefore ? 0 : extra);
      if (total <= box.w) break;
      s = clamp(s * (box.w / total), 0.08, 1);
    }
    patch({ scale: Math.round(s * 100) / 100 });
  }, [gridItems, withBefore, cardWidth, box.w, item, patch]);

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

  /** Straight to the clipboard, for pasting the winner into a deck or a chat. */
  const copyImage = async () => {
    setExportMsg(null);
    try {
      const res = await fetch(fileUrl(item.generated_img));
      const blob = await res.blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch (e) {
      setExportMsg('✗ el navegador no deja copiar la imagen; usa Descargar');
    }
  };

  const goPage = useCallback((dir: -1 | 1) => {
    const next = pages[pageIdx + dir];
    if (next == null) return;
    // keep the same style when the target page has it
    const sameStyle = all.find((g) => g.pdf === item.pdf && g.page === next && g.style === item.style);
    const fallback = all.find((g) => g.pdf === item.pdf && g.page === next);
    if (sameStyle || fallback) onSelect((sameStyle ?? fallback)!);
  }, [all, pages, pageIdx, item.pdf, item.style, onSelect]);

  const zoomBy = useCallback((factor: number) => {
    if (mode === 'grid') patch({ scale: clamp(Math.round(scale * factor * 100) / 100, 0.15, 1.5) });
    else setLens((l) => zoomAt(l, 0, 0, factor));
  }, [mode, scale, patch]);

  const resetZoom = useCallback(() => {
    if (mode === 'grid') patch({ scale: 1 });
    else setLens(NO_LENS);
  }, [mode, patch]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // ESC unwinds the panels one at a time before the parent closes the modal
      if (e.key === 'Escape' && (help || picker || redo || info)) {
        e.stopPropagation();
        setHelp(false); setPicker(false); setRedo(false); setInfo(false);
        return;
      }
      if (isTyping(e.target)) return;
      // otherwise "r" opens the redo box and then lands in its textarea
      if (HANDLED_KEYS.has(e.key) || (e.key >= '1' && e.key <= '9')) e.preventDefault();

      switch (e.key) {
        case 'ArrowRight': goPage(1); return;
        case 'ArrowLeft': goPage(-1); return;
        case '[': setFlip(false); setSplit((s) => clamp(s - 4, 0, 100)); return;
        case ']': setFlip(false); setSplit((s) => clamp(s + 4, 0, 100)); return;
        case ' ':
          if (mode !== 'slider') setMode('slider');
          setFlip(true);
          return;
        case 'g': setMode(mode === 'grid' ? 'pair' : 'grid'); return;
        case 's': setMode(mode === 'slider' ? 'pair' : 'slider'); return;
        case 'v':
          if (versions.length > 1) { patch({ mode: 'grid', compare: 'versions' }); }
          return;
        case 'b': patch({ withBefore: !withBefore }); return;
        case 'f': patch({ backdrop: backdrop === 'dark' ? 'grey' : backdrop === 'grey' ? 'light' : 'dark' }); return;
        case 'h': onHero(item); return;
        case 'i': setInfo((v) => !v); return;
        case 'r': setRedo((v) => !v); setPicker(false); return;
        case '?': case '/': setHelp((v) => !v); return;
        case '+': case '=': zoomBy(1.25); return;
        case '-': case '_': zoomBy(1 / 1.25); return;
        case '0': resetZoom(); return;
      }
      if (e.key >= '1' && e.key <= '9') {
        const target = siblings[Number(e.key) - 1];
        if (target) onSelect(target);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => { if (e.key === ' ') setFlip(false); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [siblings, versions, item, mode, backdrop, withBefore, help, picker, redo, info, goPage, zoomBy, resetZoom, onHero, onSelect, patch]);

  const launch = () => {
    if (!wanted.length) return;
    onGenerateStyles(wanted, item.page, item.pdf);
    setPicker(false);
    setWanted([]);
  };

  const chip = 'rounded-xl border border-zinc-800 bg-zinc-900/85 backdrop-blur px-2 py-1';
  const btn = 'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] transition-all duration-200 active:scale-95';
  const off = 'border-zinc-700 text-zinc-300 hover:border-emerald-500/60 hover:text-emerald-400';
  const on = 'border-emerald-500 bg-emerald-500/15 text-emerald-400';

  return (
    <div className={`fixed inset-0 z-[70] ${BACKDROP[backdrop]} backdrop-blur flex flex-col p-4 gap-1.5`} onClick={onClose}>
      {/* header */}
      <div className={`flex items-center justify-between gap-3 max-w-[100rem] w-full mx-auto ${chip}`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[11px] uppercase tracking-widest text-zinc-400 truncate">
            {organisation} — página {item.page}
          </span>
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
          <QcBadge qc={item.qc} />
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => { setRedo((v) => !v); setPicker(false); }}
            disabled={generating}
            title="Rehacer esta imagen indicando qué falló (R)"
            className={`${btn} disabled:opacity-40 ${
              redo ? 'border-amber-500 bg-amber-500/15 text-amber-400' : 'border-zinc-700 text-zinc-300 hover:border-amber-500/60 hover:text-amber-400'
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
                title={`Exportar el par como imagen ${f === 'slide' ? '16:9' : f === 'square' ? '1:1' : '9:16'}`}
                className="px-1.5 py-1 text-[10px] text-zinc-300 transition-colors duration-200 hover:text-emerald-400 disabled:opacity-40"
              >
                {f === 'slide' ? '16:9' : f === 'square' ? '1:1' : '9:16'}
              </button>
            ))}
            <a
              href={fileUrl(item.generated_img)}
              download={baseName(item.generated_img)}
              title="Descargar el rediseño a tamaño completo"
              className="px-1.5 py-1 text-[10px] text-zinc-300 transition-colors duration-200 hover:text-emerald-400 border-l border-zinc-800"
            >
              PNG
            </a>
            <button
              onClick={copyImage}
              title="Copiar el rediseño al portapapeles"
              className="px-1.5 py-1 text-zinc-300 transition-colors duration-200 hover:text-emerald-400 border-l border-zinc-800"
            >
              {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
            </button>
          </span>

          <button onClick={() => setInfo((v) => !v)} title="Ficha técnica de la imagen (I)" className={`p-1.5 rounded-lg transition-all duration-200 ${info ? 'text-emerald-400' : 'text-zinc-400 hover:text-emerald-400'}`}>
            <Info size={14} />
          </button>
          <button onClick={() => setHelp((v) => !v)} title="Atajos de teclado (?)" className={`p-1.5 rounded-lg transition-all duration-200 ${help ? 'text-emerald-400' : 'text-zinc-400 hover:text-emerald-400'}`}>
            <Keyboard size={14} />
          </button>
          <button onClick={onClose} title="Cerrar (ESC)" className="p-1.5 rounded-lg text-zinc-400 transition-all duration-200 hover:scale-110 hover:text-rose-400 hover:bg-rose-500/10 active:scale-95">
            <X size={16} />
          </button>
        </div>
      </div>

      {/* view controls */}
      <div className={`flex items-center justify-between gap-3 flex-wrap max-w-[100rem] w-full mx-auto ${chip}`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="inline-flex items-center rounded-lg border border-zinc-700 overflow-hidden">
            {([
              ['pair', <Columns2 key="i" size={12} />, 'Antes / después'],
              ['grid', <Grid2x2 key="i" size={12} />, compare === 'versions' ? `Versiones (${gridItems.length})` : `Comparar ${siblings.length}`],
              ['slider', <SlidersHorizontal key="i" size={12} />, 'Deslizador'],
            ] as const).map(([id, icon, label]) => (
              <button
                key={id}
                onClick={() => setMode(id as Mode)}
                title={id === 'pair' ? 'Ver el par a tamaño grande' : id === 'grid' ? 'Ver todos a la vez (G)' : 'Superponer con deslizador (S)'}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] transition-colors duration-200 ${
                  mode === id ? 'bg-emerald-500/15 text-emerald-400' : 'text-zinc-400 hover:text-emerald-400'
                }`}
              >
                {icon} {label}
              </button>
            ))}
          </span>

          {mode === 'grid' && (
            <>
              <span className="inline-flex items-center rounded-lg border border-zinc-700 overflow-hidden">
                {([
                  ['styles', `Estilos ${siblings.length}`, 'Un estilo por tarjeta'],
                  ['versions', `Versiones ${versions.length}`, 'Una versión por tarjeta: cuál quedó mejor'],
                ] as const).map(([id, label, hint]) => (
                  <button
                    key={id}
                    onClick={() => patch({ compare: id as Compare })}
                    disabled={id === 'versions' && versions.length < 2}
                    title={id === 'versions' && versions.length < 2 ? 'Este estilo solo se ha generado una vez' : hint}
                    className={`px-2 py-1 text-[10px] transition-colors duration-200 disabled:opacity-40 ${
                      compare === id ? 'bg-emerald-500/15 text-emerald-400' : 'text-zinc-400 hover:text-emerald-400'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </span>

              <button
                onClick={() => patch({ withBefore: !withBefore })}
                title="Cada tarjeta lleva su propio antes, o un solo antes de referencia (B)"
                className={`${btn} ${withBefore ? on : off}`}
              >
                <Layers size={12} /> {withBefore ? 'Pares' : 'Solo después'}
              </button>

              {failedCount > 0 && compare === 'styles' && (
                <button
                  onClick={() => patch({ hideFailed: !hideFailed })}
                  title={`${failedCount} rediseño(s) con el control de datos en fallo`}
                  className={`${btn} ${hideFailed ? 'border-rose-500 bg-rose-500/15 text-rose-400' : off}`}
                >
                  <ShieldAlert size={12} /> {hideFailed ? `${failedCount} ocultos` : 'Ocultar QC fallido'}
                </button>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {mode === 'slider' && (
            <button
              onClick={() => setAutoFlip((v) => !v)}
              title="Alternar antes / después automáticamente — o mantén ESPACIO"
              className={`${btn} ${autoFlip ? on : off}`}
            >
              <RefreshCw size={12} className={autoFlip ? 'animate-spin' : ''} /> Parpadeo A/B
            </button>
          )}

          <button
            onClick={() => patch({ backdrop: backdrop === 'dark' ? 'grey' : backdrop === 'grey' ? 'light' : 'dark' })}
            title="Fondo del lienzo: negro, gris neutro o claro (F)"
            className={`${btn} ${off}`}
          >
            <Contrast size={12} /> {backdrop === 'dark' ? 'Negro' : backdrop === 'grey' ? 'Gris' : 'Claro'}
          </button>

          {/* zoom: card size in the grid, magnifier everywhere else */}
          <span className="inline-flex items-center rounded-lg border border-zinc-700 overflow-hidden">
            <button onClick={() => zoomBy(1 / 1.25)} title="Reducir (−)" className="px-1.5 py-1 text-zinc-400 hover:text-emerald-400"><ZoomOut size={12} /></button>
            <button
              onClick={resetZoom}
              title={mode === 'grid' ? 'Volver al 100 % (0)' : 'Quitar la lupa (0)'}
              className="px-1.5 py-1 text-[10px] tabular-nums text-zinc-300 hover:text-emerald-400 min-w-[3rem]"
            >
              {Math.round((mode === 'grid' ? scale : lens.s) * 100)} %
            </button>
            <button onClick={() => zoomBy(1.25)} title="Ampliar (+)" className="px-1.5 py-1 text-zinc-400 hover:text-emerald-400"><ZoomIn size={12} /></button>
            {mode === 'grid' ? (
              <>
                <button onClick={() => patch({ scale: 0.5 })} title="Media altura: caben el doble" className="px-1.5 py-1 text-[10px] text-zinc-400 hover:text-emerald-400 border-l border-zinc-800">50 %</button>
                <button onClick={fitOneRow} title="Encoger hasta que quepan todos en una fila" className="px-1.5 py-1 text-zinc-400 hover:text-emerald-400 border-l border-zinc-800"><Rows3 size={12} /></button>
              </>
            ) : (
              <span className="px-1.5 py-1 text-[9px] text-zinc-600 border-l border-zinc-800 hidden sm:inline">rueda + arrastrar</span>
            )}
          </span>
        </div>
      </div>

      {/* style tabs */}
      {siblings.length > 1 && mode !== 'grid' && (
        <div className={`flex items-center gap-1.5 flex-wrap max-w-[100rem] w-full mx-auto ${chip}`} onClick={(e) => e.stopPropagation()}>
          {siblings.map((g, i) => {
            const active = g.style === item.style;
            return (
              <button
                key={g.style}
                onClick={() => onSelect(g)}
                title={g.extra_prompt ? `Indicaciones: ${g.extra_prompt}` : g.style_prompt}
                className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] transition-all duration-200 active:scale-95 ${
                  active ? on : 'border-zinc-700 text-zinc-400 hover:border-emerald-500/50 hover:text-emerald-400'
                }`}
              >
                <span className="text-zinc-600">{i + 1}</span>
                {g.styleName}
                {g.qc?.verdict === 'fail' && <ShieldAlert size={9} className="text-rose-400" />}
                {g.hero && <Star size={9} fill="currentColor" className="text-amber-400" />}
              </button>
            );
          })}
          {versions.length > 1 && (
            <button
              onClick={() => setShowVersions((v) => !v)}
              title="Versiones anteriores de este estilo (V para verlas en paralelo)"
              className={`ml-auto inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] transition-all duration-200 active:scale-95 ${
                showVersions ? on : 'border-zinc-700 text-zinc-400 hover:border-emerald-500/50 hover:text-emerald-400'
              }`}
            >
              <History size={10} /> v{item.version ?? 1}/{versions.length}
            </button>
          )}
        </div>
      )}

      {/* technical sheet */}
      {info && <InfoPanel item={item} />}

      {/* regenerate with feedback */}
      {redo && (
        <div className="max-w-[100rem] w-full mx-auto rounded-lg border border-amber-500/40 bg-zinc-900/90 p-3" onClick={(e) => e.stopPropagation()}>
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
      {showVersions && versions.length > 1 && mode !== 'grid' && (
        <div className={`max-w-[100rem] w-full mx-auto flex items-center gap-2 flex-wrap ${chip}`} onClick={(e) => e.stopPropagation()}>
          <span className="text-[10px] uppercase tracking-widest text-zinc-500">Versiones</span>
          {versions.map((v) => {
            const key = `${v.version ?? 1}-${v.generated_img}`;
            const lost = lostVersions.has(key);
            const active = !lost && v.generated_img === item.generated_img;
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
                    : active
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
          <button
            onClick={() => patch({ mode: 'grid', compare: 'versions' })}
            className="ml-auto inline-flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:border-emerald-500/50 hover:text-emerald-400"
          >
            <Grid2x2 size={10} /> Verlas en paralelo
          </button>
        </div>
      )}

      {/* style picker */}
      {picker && (
        <div
          className="max-w-[100rem] w-full mx-auto rounded-lg border border-emerald-500/40 bg-zinc-900/90 p-3"
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
              const picked = wanted.includes(p.id);
              return (
                <button
                  key={p.id}
                  onClick={() => setWanted((w) => (picked ? w.filter((x) => x !== p.id) : [...w, p.id]))}
                  className={`rounded-md border px-2 py-0.5 text-[10px] transition-all duration-200 active:scale-95 ${
                    picked ? on : 'border-zinc-700 text-zinc-400 hover:border-emerald-500/50 hover:text-emerald-400'
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
      <div
        ref={bodyRef}
        className="flex-1 flex items-stretch justify-center gap-3 max-w-[100rem] w-full mx-auto min-h-0"
        onClick={(e) => e.stopPropagation()}
      >
        {mode === 'slider' ? (
          <SliderCompare
            before={item.original_img}
            after={item.generated_img}
            split={flip ? 0 : split}
            onSplit={(n) => { setFlip(false); setAutoFlip(false); setSplit(n); }}
          />
        ) : mode === 'pair' ? (
          <>
            <Pane
              label="Antes" tone="text-zinc-300" src={item.original_img} thumb={pageThumb(item.original_img)}
              alt={`antes p${item.page}`} border="border-zinc-700" lens={lens} onLens={setLens} onRatio={noteRatio}
            />
            <Pane
              label={item.styleName} tone="text-emerald-400" src={item.generated_img} thumb={item.thumb}
              alt={`después p${item.page}`} border="border-emerald-500/40"
              hero={item.hero} onHero={() => onHero(item)} qc={item.qc}
              lens={lens} onLens={setLens} onRatio={noteRatio}
            />
          </>
        ) : (
          <div className="flex-1 min-h-0 overflow-auto">
            <div
              className="flex flex-wrap items-start justify-center content-start gap-3 h-full"
              style={{ alignContent: 'safe center' }}
            >
              {!withBefore && (
                <Card
                  height={cardHeight(scale)}
                  width={cardWidth(item, scale, false)}
                  title="Antes"
                  tone="text-zinc-300"
                  border="border-zinc-700"
                >
                  <SmartImg src={item.original_img} thumb={pageThumb(item.original_img)} alt={`antes p${item.page}`} onRatio={noteRatio} className={GRID_IMG} />
                </Card>
              )}
              {gridItems.map((g, i) => {
                const active = g.generated_img === item.generated_img;
                const label = compare === 'versions'
                  ? `v${g.version ?? 1}${g.superseded ? '' : ' · actual'}`
                  : g.styleName;
                return (
                  <Card
                    key={`${g.style}-${g.version ?? 1}-${g.generated_img}`}
                    height={cardHeight(scale)}
                    width={cardWidth(g, scale, withBefore)}
                    title={label}
                    index={compare === 'styles' ? i + 1 : undefined}
                    tone={active ? 'text-emerald-400' : 'text-zinc-300'}
                    border={active ? 'border-emerald-500/60' : 'border-zinc-700'}
                    hero={g.hero}
                    onHero={compare === 'styles' ? () => onHero(g) : undefined}
                    qc={g.qc}
                    hint={g.feedback ? `Corrección: ${g.feedback}` : g.extra_prompt ? `Indicaciones: ${g.extra_prompt}` : g.style_prompt}
                    onClick={() => onSelect(g)}
                    onDoubleClick={() => { onSelect(g); setMode('pair'); }}
                  >
                    {withBefore && (
                      <SmartImg src={g.original_img} thumb={pageThumb(g.original_img)} alt={`antes p${g.page}`} onRatio={noteRatio} className={`${GRID_IMG} opacity-90`} />
                    )}
                    <SmartImg src={g.generated_img} thumb={g.thumb} alt={`${label} p${g.page}`} onRatio={noteRatio} className={GRID_IMG} />
                  </Card>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div className="text-center text-[10px] text-zinc-400 mx-auto" onClick={(e) => e.stopPropagation()}>
        <span className={`${chip} inline-flex items-center gap-2 flex-wrap justify-center`}>
          {exportMsg ? <span className="text-zinc-300">{exportMsg}</span> : null}
          {mode === 'grid'
            ? 'clic elige · doble clic abre el par · ★ marca el ganador'
            : mode === 'slider'
              ? 'arrastra o [ ] mueve el corte · ESPACIO parpadea'
              : 'rueda amplía · arrastra mueve · ←/→ página · 1-9 estilo'}
          <button onClick={() => setHelp(true)} className="text-zinc-500 hover:text-emerald-400">? atajos</button>
        </span>
      </div>

      {help && <HelpOverlay onClose={() => setHelp(false)} />}
    </div>
  );
}

/* ---------- technical sheet ---------- */

function InfoPanel({ item }: { item: GeneratedItem }) {
  const rows: [string, string][] = [
    ['Estilo', item.styleName || item.style],
    ['Versión', `v${item.version ?? 1}${item.superseded ? ' (antigua)' : ''}`],
    ['Modelo', [item.model, item.resolution, item.quality].filter(Boolean).join(' · ') || '—'],
    ['Creada', item.created_at ?? '—'],
    ['Base', item.base_img ? 'un rediseño anterior' : 'la página del PDF'],
    ['Paleta', item.palette || '—'],
  ];
  const texts: [string, string | undefined][] = [
    ['Prompt de estilo', item.style_prompt],
    ['Indicaciones', item.extra_prompt],
    ['Corrección', item.feedback],
  ];
  const qc = item.qc;
  return (
    <div className="max-w-[100rem] w-full mx-auto rounded-xl border border-zinc-800 bg-zinc-900/90 backdrop-blur p-3 space-y-2" onClick={(e) => e.stopPropagation()}>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        {rows.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <div className="text-[9px] uppercase tracking-widest text-zinc-500">{k}</div>
            <div className="text-[11px] text-zinc-300 truncate" title={v}>{v}</div>
          </div>
        ))}
      </div>
      {texts.filter(([, v]) => v).map(([k, v]) => (
        <div key={k}>
          <div className="text-[9px] uppercase tracking-widest text-zinc-500">{k}</div>
          <div className="text-[11px] text-zinc-400 line-clamp-3">{v}</div>
        </div>
      ))}
      {qc?.ok && (
        <div className="text-[10px] text-zinc-400">
          <span className="uppercase tracking-widest text-zinc-500">Control de datos</span>{' '}
          {qc.total_original != null ? `${qc.kept}/${qc.total_original} cifras conservadas` : 'sin cifras que comprobar'}
          {qc.missing?.length ? <span className="text-rose-400"> · faltan: {qc.missing.slice(0, 12).join(', ')}</span> : null}
          {qc.invented?.length ? <span className="text-amber-400"> · nuevas: {qc.invented.slice(0, 12).join(', ')}</span> : null}
        </div>
      )}
    </div>
  );
}

/* ---------- keyboard help ---------- */

const SHORTCUTS: [string, string][] = [
  ['← →', 'página anterior / siguiente'],
  ['1 – 9', 'saltar a un estilo'],
  ['G', 'rejilla de todos a la vez'],
  ['S', 'deslizador'],
  ['V', 'comparar versiones en paralelo'],
  ['B', 'con su antes / solo el después'],
  ['ESPACIO', 'parpadeo antes ↔ después'],
  ['[ ]', 'mover el corte del deslizador'],
  ['+ − 0', 'ampliar, reducir, reiniciar'],
  ['rueda', 'lupa sincronizada en los dos'],
  ['arrastrar', 'mover la lupa en los dos'],
  ['H', 'marcar / quitar ganador'],
  ['I', 'ficha técnica'],
  ['R', 'rehacer con indicaciones'],
  ['F', 'fondo negro / gris / claro'],
  ['ESC', 'cerrar'],
];

function HelpOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl max-w-lg w-full mx-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <span className="text-[11px] uppercase tracking-widest text-emerald-400 inline-flex items-center gap-1.5">
            <Keyboard size={13} /> Atajos
          </span>
          <button onClick={onClose} className="text-zinc-500 hover:text-rose-400"><X size={14} /></button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
          {SHORTCUTS.map(([k, v]) => (
            <div key={k} className="flex items-center gap-2 text-[11px]">
              <kbd className="rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-[10px] text-zinc-300 min-w-[3.5rem] text-center">{k}</kbd>
              <span className="text-zinc-400">{v}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------- badges ---------- */

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

function QcDot({ qc }: { qc: GeneratedItem['qc'] }) {
  if (!qc?.ok) return null;
  const cls = qc.verdict === 'clean' ? 'text-emerald-500'
    : qc.verdict === 'warning' ? 'text-amber-500'
    : qc.verdict === 'fail' ? 'text-rose-500' : 'text-zinc-600';
  const Icon = qc.verdict === 'clean' ? ShieldCheck : ShieldAlert;
  return <Icon size={10} className={`${cls} shrink-0`} />;
}

/* ---------- images ---------- */

/** One column of the pair view, with the synchronised magnifier on top. */
function Pane({
  label, tone, src, thumb, alt, border, hero, onHero, qc, lens, onLens, onRatio,
}: {
  label: string;
  tone: string;
  src: string;
  thumb?: string | null;
  alt: string;
  border: string;
  hero?: boolean;
  onHero?: () => void;
  qc?: GeneratedItem['qc'];
  lens: Lens;
  onLens: React.Dispatch<React.SetStateAction<Lens>>;
  onRatio: (src: string, ratio: number) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const last = useRef<{ x: number; y: number } | null>(null);

  // React registers wheel handlers as passive, and this one has to stop the page
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const cx = (e.clientX - r.left) / r.width - 0.5;
      const cy = (e.clientY - r.top) / r.height - 0.5;
      onLens((l) => zoomAt(l, cx, cy, Math.exp(-e.deltaY * 0.0015)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onLens]);

  const move = (e: React.MouseEvent) => {
    if (!last.current || e.buttons !== 1) { last.current = null; return; }
    const r = boxRef.current?.getBoundingClientRect();
    if (!r) return;
    const dx = (e.clientX - last.current.x) / r.width;
    const dy = (e.clientY - last.current.y) / r.height;
    last.current = { x: e.clientX, y: e.clientY };
    onLens((l) => clampLens({ ...l, x: l.x + dx, y: l.y + dy }));
  };

  return (
    <div className="flex flex-col flex-1 min-w-0">
      <div className="flex items-center justify-center gap-1.5 mb-1.5">
        <span className={`inline-flex items-center gap-1.5 rounded bg-black/50 px-1.5 py-0.5 text-[10px] uppercase tracking-widest truncate ${tone}`}>
          {label}
          <QcDot qc={qc} />
          {onHero && (
            <button
              onClick={onHero}
              title={hero ? 'Quitar como ganador (H)' : 'Marcar como ganador (H)'}
              className={`p-0.5 rounded transition-all duration-200 hover:scale-110 active:scale-95 ${hero ? 'text-amber-400' : 'text-zinc-500 hover:text-amber-400'}`}
            >
              <Star size={11} fill={hero ? 'currentColor' : 'none'} />
            </button>
          )}
        </span>
      </div>
      <div
        ref={boxRef}
        className={`relative flex-1 min-h-0 overflow-hidden ${lens.s > 1 ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in'}`}
        onMouseDown={(e) => { last.current = { x: e.clientX, y: e.clientY }; e.preventDefault(); }}
        onMouseMove={move}
        onMouseUp={() => { last.current = null; }}
        onMouseLeave={() => { last.current = null; }}
        onDoubleClick={() => onLens(NO_LENS)}
      >
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{
            transform: `translate(${lens.x * 100}%, ${lens.y * 100}%) scale(${lens.s})`,
            transformOrigin: 'center',
          }}
        >
          <SmartImg
            src={src}
            thumb={thumb}
            alt={alt}
            onRatio={onRatio}
            className={`max-h-full max-w-full w-auto h-full object-contain rounded-lg border shadow-2xl ${border}`}
          />
        </div>
      </div>
    </div>
  );
}

/** One card of the grid: a whole before/after pair, or just the redesign. */
function Card({
  height, width, title, index, tone, border, hero, onHero, qc, hint, onClick, onDoubleClick, children,
}: {
  height: number;
  width: number;
  title: string;
  index?: number;
  tone: string;
  border: string;
  hero?: boolean;
  onHero?: () => void;
  qc?: GeneratedItem['qc'];
  hint?: string;
  onClick?: () => void;
  onDoubleClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex-none flex flex-col"
      style={{ height: `${Math.round(height)}px`, width: `${Math.round(width)}px` }}
      title={hint}
    >
      <div className="flex items-center justify-center gap-1 mb-1">
        <span className={`inline-flex items-center gap-1 rounded bg-black/50 px-1.5 py-0.5 text-[10px] uppercase tracking-widest truncate max-w-[16rem] ${tone}`}>
          {index != null && <span className="text-zinc-600">{index}</span>}
          {title}
          <QcDot qc={qc} />
          {onHero && (
            <button
              onClick={(e) => { e.stopPropagation(); onHero(); }}
              title={hero ? 'Quitar como ganador' : 'Marcar como ganador'}
              className={`p-0.5 rounded transition-all duration-200 hover:scale-110 active:scale-95 ${hero ? 'text-amber-400' : 'text-zinc-500 hover:text-amber-400'}`}
            >
              <Star size={10} fill={hero ? 'currentColor' : 'none'} />
            </button>
          )}
        </span>
      </div>
      <div
        className={`relative flex-1 min-h-0 flex items-stretch justify-center gap-1.5 rounded-lg border p-1 transition-all duration-200 ${border} ${onClick ? 'cursor-pointer hover:border-emerald-500/60' : ''}`}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
      >
        {children}
      </div>
    </div>
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
        onDoubleClick={() => onSplit(50)}
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
