import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ImagePlus, Loader2, Trash2, X, AlertTriangle } from 'lucide-react';
import type { GeneratedItem, Lead } from '../lib/types';
import { fileUrl } from '../lib/types';

interface Props {
  leadId: number;
  pdfSlug: string;
  pdfTitle: string;
  /** pairs already uploaded by hand for this report, so they can be undone here */
  existing: GeneratedItem[];
  onUploaded: (lead: Lead) => void;
  onClose: () => void;
}

/** Same order the designer sees in the finder: 2 before 10, accents ignored. */
const byName = (a: File, b: File) =>
  a.name.localeCompare(b.name, 'es', { numeric: true, sensitivity: 'base' });

interface Row {
  before: File | null;
  after: File | null;
  page: number;
}

/**
 * Pairs made outside the pipeline: the designer redesigns the pages by hand and
 * drops them here. They land as ordinary redesigns, so the comparison PDF, the
 * comparator and the e-mail keep working without knowing the difference.
 *
 * Pairing is by name order, not by the order the file dialog handed them over,
 * and the pairing is shown before anything is sent — getting a before matched
 * to somebody else's after is the one mistake that must not be quiet.
 */
export default function ManualPairs({ leadId, pdfSlug, pdfTitle, existing, onUploaded, onClose }: Props) {
  const [befores, setBefores] = useState<File[]>([]);
  const [afters, setAfters] = useState<File[]>([]);
  const [label, setLabel] = useState('Manual');
  const [pages, setPages] = useState<Record<number, number>>({});
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const urls = useRef(new Map<File, string>());

  // object URLs are a leak if nobody frees them, and a preview grid makes many
  const preview = (f: File | null) => {
    if (!f) return '';
    if (!urls.current.has(f)) urls.current.set(f, URL.createObjectURL(f));
    return urls.current.get(f)!;
  };
  useEffect(() => () => { urls.current.forEach((u) => URL.revokeObjectURL(u)); }, []);

  const rows = useMemo<Row[]>(() => {
    const n = Math.max(befores.length, afters.length);
    return Array.from({ length: n }, (_, i) => ({
      before: befores[i] ?? null,
      after: afters[i] ?? null,
      page: pages[i] ?? i + 1,
    }));
  }, [befores, afters, pages]);

  const complete = rows.filter((r) => r.before && r.after);
  const mismatch = befores.length !== afters.length;

  const pick = (which: 'before' | 'after') => (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []).sort(byName);
    (which === 'before' ? setBefores : setAfters)(files);
    setMsg(null);
  };

  const dropRow = (idx: number) => {
    setBefores((b) => b.filter((_, i) => i !== idx));
    setAfters((a) => a.filter((_, i) => i !== idx));
    setPages((p) => {
      const next: Record<number, number> = {};
      Object.entries(p).forEach(([k, v]) => {
        const i = Number(k);
        if (i < idx) next[i] = v;
        else if (i > idx) next[i - 1] = v;
      });
      return next;
    });
  };

  const upload = async () => {
    if (!complete.length || mismatch) return;
    setBusy(true);
    setMsg(null);
    try {
      const body = new FormData();
      body.set('lead_id', String(leadId));
      body.set('pdf_slug', pdfSlug);
      body.set('label', label.trim() || 'Manual');
      body.set('pages', rows.map((r) => r.page).join(','));
      rows.forEach((r) => {
        if (r.before && r.after) {
          body.append('originals', r.before);
          body.append('redesigns', r.after);
        }
      });
      const res = await fetch('/api/upload-pair', { method: 'POST', body });
      const data = await res.json();
      if (!data.ok) {
        setMsg(`✗ ${data.error}`);
        return;
      }
      onUploaded(data.lead);
      setBefores([]);
      setAfters([]);
      setPages({});
      setMsg(`✓ ${data.added} par(es) añadidos`);
    } catch (e) {
      setMsg(`✗ ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (img: string) => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/upload-pair', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: leadId, generated_img: img }),
      });
      const data = await res.json();
      if (!data.ok) { setMsg(`✗ ${data.error}`); return; }
      onUploaded(data.lead);
      setMsg('✓ par eliminado');
    } catch (e) {
      setMsg(`✗ ${String(e)}`);
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  };

  const fieldCls =
    'block w-full text-[10px] text-zinc-500 file:mr-2 file:rounded-md file:border file:border-zinc-300 dark:file:border-zinc-700 file:bg-transparent file:px-2 file:py-1 file:text-[10px] file:text-zinc-600 dark:file:text-zinc-300 file:cursor-pointer hover:file:border-emerald-500/60 hover:file:text-emerald-600 dark:hover:file:text-emerald-400';

  return (
    <div className="mt-3 rounded-lg border border-sky-500/50 bg-sky-50 dark:bg-sky-950/30 p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-600 dark:text-sky-400 truncate">
          Pares hechos a mano · {pdfTitle}
        </span>
        <button onClick={onClose} className="p-1 rounded text-zinc-500 transition-colors duration-200 hover:text-rose-500">
          <X size={13} />
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="space-y-1">
          <span className="block text-[10px] uppercase tracking-widest text-zinc-500">
            Imágenes originales {befores.length > 0 && `(${befores.length})`}
          </span>
          <input type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={pick('before')} className={fieldCls} />
        </label>
        <label className="space-y-1">
          <span className="block text-[10px] uppercase tracking-widest text-emerald-600 dark:text-emerald-400">
            Imágenes nuevas {afters.length > 0 && `(${afters.length})`}
          </span>
          <input type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={pick('after')} className={fieldCls} />
        </label>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="inline-flex items-center gap-1.5 text-[10px] text-zinc-500">
          Nombre del estilo
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Manual"
            className="w-40 rounded-md bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-[11px] text-zinc-700 dark:text-zinc-300 transition-colors duration-200 focus:border-sky-500 focus:outline-none"
          />
        </label>
        <span className="text-[10px] text-zinc-500">
          Es como se agrupan en Antes / Después, igual que un estilo generado.
        </span>
      </div>

      {mismatch && (
        <div className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-amber-500/50 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-700 dark:text-amber-400">
          <AlertTriangle size={11} />
          {befores.length} originales y {afters.length} nuevas: hacen falta las mismas de cada.
        </div>
      )}

      {rows.length > 0 && (
        <>
          <div className="mt-2 text-[10px] text-zinc-500">
            Se emparejan por orden de nombre de archivo. Comprueba que cada pareja es la que toca
            antes de subirlas — el número de página sale impreso en el PDF comparativo.
          </div>
          <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2">
            {rows.map((r, i) => (
              <div key={i} className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white/70 dark:bg-zinc-900/40 p-2">
                <div className="flex items-center justify-between gap-2 mb-1 text-[10px] text-zinc-500">
                  <label className="inline-flex items-center gap-1">
                    Página
                    <input
                      type="number"
                      min={1}
                      value={r.page}
                      onChange={(e) => setPages((p) => ({ ...p, [i]: Math.max(1, Number(e.target.value) || 1) }))}
                      className="w-14 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-1 py-0.5 text-[10px] text-zinc-700 dark:text-zinc-300 focus:border-sky-500 focus:outline-none"
                    />
                  </label>
                  <button
                    onClick={() => dropRow(i)}
                    title="Quitar esta pareja de la subida"
                    className="p-0.5 rounded text-zinc-400 transition-colors duration-200 hover:text-rose-500"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {([['Antes', r.before], ['Después', r.after]] as const).map(([cap, f]) => (
                    <div key={cap}>
                      <div className={`text-[9px] uppercase tracking-widest mb-1 ${cap === 'Antes' ? 'text-zinc-500' : 'text-emerald-500'}`}>{cap}</div>
                      {f ? (
                        <>
                          <img src={preview(f)} alt={f.name} className="w-full rounded-md border border-zinc-200 dark:border-zinc-800" />
                          <div className="mt-0.5 truncate text-[9px] text-zinc-400 dark:text-zinc-600" title={f.name}>{f.name}</div>
                        </>
                      ) : (
                        <div className="flex h-20 items-center justify-center rounded-md border border-dashed border-amber-500/50 text-[9px] text-amber-600 dark:text-amber-400">
                          falta
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {existing.length > 0 && (
        <div className="mt-3 border-t border-sky-500/20 pt-2">
          <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-1.5">
            Ya subidos ({existing.length})
          </div>
          <div className="flex flex-wrap gap-1.5">
            {existing.map((g) => (
              <span
                key={g.generated_img}
                className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white/70 dark:bg-zinc-900/40 pl-1 pr-1.5 py-1"
                title={`${g.styleName} · página ${g.page}`}
              >
                <img
                  src={fileUrl(g.thumb || g.generated_img)}
                  alt={`par p${g.page}`}
                  className="h-8 w-8 rounded object-cover object-top bg-white"
                />
                <span className="text-[10px] text-zinc-600 dark:text-zinc-400">
                  p{g.page} · {g.styleName}
                </span>
                {confirming === g.generated_img ? (
                  <button
                    onClick={() => remove(g.generated_img)}
                    disabled={busy}
                    className="rounded border border-rose-500 px-1 py-px text-[9px] text-rose-600 dark:text-rose-400 transition-colors duration-200 hover:bg-rose-500/10 disabled:opacity-50"
                  >
                    borrar
                  </button>
                ) : (
                  <button
                    onClick={() => setConfirming(g.generated_img)}
                    title="Eliminar este par y sus dos imágenes"
                    className="p-0.5 rounded text-zinc-400 transition-colors duration-200 hover:text-rose-500"
                  >
                    <Trash2 size={11} />
                  </button>
                )}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={upload}
          disabled={busy || mismatch || !complete.length}
          className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-sky-600 text-white px-2.5 py-1 text-[11px] transition-all duration-200 hover:bg-sky-500 active:scale-[0.97] disabled:opacity-50"
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <ImagePlus size={11} />}
          {busy ? 'Subiendo…' : `Subir ${complete.length || ''} par(es)`}
        </button>
        {busy && <span className="text-[10px] text-zinc-500">se comprueban las cifras de cada par, tarda unos segundos</span>}
        {msg && <span className="text-[10px] text-zinc-500">{msg}</span>}
      </div>
    </div>
  );
}
