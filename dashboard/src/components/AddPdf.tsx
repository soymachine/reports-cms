import React, { useRef, useState } from 'react';
import { FilePlus2, Link2, Loader2, Upload, X } from 'lucide-react';
import type { Lead } from '../lib/types';

interface Props {
  leadId: number;
  onAdded: (lead: Lead) => void;
  onClose: () => void;
}

/**
 * Reports the team found by hand, for when the automatic search comes back
 * empty or short. Two ways in, because both happen: the PDF is already in
 * Downloads, or it is a link somebody just found and the dashboard can fetch
 * it without a round trip through the file dialog.
 *
 * Nothing here goes through the quality gate that the automatic search uses:
 * a person already decided this document is worth keeping.
 */
export default function AddPdf({ leadId, onAdded, onClose }: Props) {
  const [busy, setBusy] = useState<'file' | 'url' | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const uploadFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy('file');
    setMsg(null);
    try {
      const fd = new FormData();
      fd.append('lead_id', String(leadId));
      for (const f of Array.from(files)) fd.append('files', f);
      const res = await fetch('/api/upload-pdf', { method: 'POST', body: fd });
      const data = await res.json();
      if (!data.ok) { setMsg(`✗ ${data.error}`); return; }
      onAdded(data.lead);
      setMsg(`✓ ${data.added} PDF(s) añadidos`);
    } catch (e) {
      setMsg(`✗ ${String(e)}`);
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const fetchUrl = async () => {
    if (!url.trim()) return;
    setBusy('url');
    setMsg(null);
    try {
      const res = await fetch('/api/upload-pdf', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: leadId, url: url.trim(), title: title.trim() }),
      });
      const data = await res.json();
      if (!data.ok) { setMsg(`✗ ${data.error}`); return; }
      onAdded(data.lead);
      setUrl('');
      setTitle('');
      setMsg(`✓ ${data.entry.title}${data.entry.pages ? ` · ${data.entry.pages} págs` : ''}`);
    } catch (e) {
      setMsg(`✗ ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const inputCls =
    'w-full rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-800 px-2.5 py-1.5 text-xs text-zinc-700 dark:text-zinc-300 transition-all duration-200 hover:border-emerald-500/50 focus:border-emerald-500 focus:outline-none';

  return (
    <div className="mb-2 rounded-lg border border-emerald-500/40 bg-emerald-500/[0.04] p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-[10px] uppercase tracking-widest text-emerald-600 dark:text-emerald-400">
          Añadir un report a mano
        </span>
        <button onClick={onClose} className="p-1 rounded text-zinc-500 transition-colors duration-200 hover:text-rose-500">
          <X size={13} />
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-1.5">Desde el ordenador</div>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,.pdf"
            multiple
            disabled={busy !== null}
            onChange={(e) => uploadFiles(e.target.files)}
            className="block w-full text-[10px] text-zinc-500 file:mr-2 file:rounded-md file:border file:border-zinc-300 dark:file:border-zinc-700 file:bg-transparent file:px-2 file:py-1 file:text-[10px] file:text-zinc-600 dark:file:text-zinc-300 file:cursor-pointer hover:file:border-emerald-500/60 hover:file:text-emerald-600 dark:hover:file:text-emerald-400"
          />
          {busy === 'file' && (
            <div className="mt-1.5 inline-flex items-center gap-1.5 text-[10px] text-zinc-500">
              <Loader2 size={10} className="animate-spin" /> subiendo…
            </div>
          )}
        </div>

        <div>
          <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-1.5">Desde una dirección web</div>
          <div className="flex gap-1.5">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') fetchUrl(); }}
              placeholder="https://…/informe-anual.pdf"
              className={inputCls}
            />
            <button
              onClick={fetchUrl}
              disabled={busy !== null || !url.trim()}
              title="Descargar ese PDF y añadirlo al lead"
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 text-white px-2.5 py-1 text-[11px] shrink-0 transition-all duration-200 hover:bg-emerald-500 active:scale-[0.97] disabled:opacity-50"
            >
              {busy === 'url' ? <Loader2 size={11} className="animate-spin" /> : <Link2 size={11} />}
              Descargar
            </button>
          </div>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Título (opcional, si no sale del nombre del archivo)"
            className={`${inputCls} mt-1.5`}
          />
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-zinc-500">
        <Upload size={10} className="shrink-0" />
        <span>
          No pasan el control de calidad de la búsqueda automática: si lo añades tú, entra.
        </span>
        {msg && <span className="text-zinc-600 dark:text-zinc-400">{msg}</span>}
      </div>
    </div>
  );
}
