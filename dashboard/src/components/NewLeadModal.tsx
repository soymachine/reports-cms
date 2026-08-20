import React, { useEffect, useRef, useState } from 'react';
import { X, Plus, Loader2, FileText, Upload, Search, Check } from 'lucide-react';
import type { Lead } from '../lib/types';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

interface Props {
  onClose: () => void;
  onCreated: (lead: Lead) => void;
  statuses: string[];
  priorities: string[];
  sectors: string[];
  countries: string[];
}

const inputCls =
  'w-full rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-800 px-2.5 py-1.5 text-xs text-zinc-700 dark:text-zinc-300 transition-all duration-200 hover:border-emerald-500/50 focus:border-emerald-500 focus:outline-none';
const btnPrimary =
  'inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 text-white px-3 py-1.5 text-xs transition-all duration-200 hover:bg-emerald-500 hover:scale-[1.02] active:scale-[0.97] shadow-sm hover:shadow-md disabled:opacity-50 disabled:hover:scale-100';
const btnGhost =
  'inline-flex items-center justify-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-xs text-zinc-600 dark:text-zinc-300 transition-all duration-200 hover:scale-[1.02] active:scale-[0.97] hover:border-emerald-500/60 hover:text-emerald-600 dark:hover:text-emerald-400 disabled:opacity-50';
const labelCls = 'block text-[10px] uppercase tracking-widest text-zinc-500 mb-1';

const EMPTY = {
  organisation: '', priority: '', status: '', sector: '', country: '', city: '',
  type: '', relationship: '', website: '', linkedin: '',
  contact1_name: '', contact1_title: '', contact1_email: '', general_email: '',
  rationale: '', next_action: '', notes: '',
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      {children}
    </div>
  );
}

export default function NewLeadModal({ onClose, onCreated, statuses, priorities, sectors, countries }: Props) {
  const [form, setForm] = useState({ ...EMPTY });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lead, setLead] = useState<Lead | null>(null); // set once created → step 2

  // step 2: PDFs
  const [uploading, setUploading] = useState(false);
  const [pdfMsg, setPdfMsg] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopPoll = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };

  useEffect(() => () => stopPoll(), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const set = (k: keyof typeof EMPTY, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.organisation.trim()) { setError('El nombre de la organización es obligatorio'); return; }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, source: 'manual' }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setLead(data.lead);
      onCreated(data.lead);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setSaving(false);
    }
  };

  const uploadPdfs = async (files: FileList | null) => {
    if (!lead || !files?.length) return;
    setUploading(true);
    setPdfMsg(null);
    try {
      const fd = new FormData();
      fd.append('lead_id', String(lead.id));
      for (const f of Array.from(files)) fd.append('files', f);
      const res = await fetch('/api/upload-pdf', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setLead(data.lead);
      onCreated(data.lead);
      setPdfMsg(`✓ ${data.added} PDF(s) añadidos`);
    } catch (err) {
      setPdfMsg(`✗ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const findPdfs = async () => {
    if (!lead) return;
    setSearching(true);
    setPdfMsg(null);
    try {
      await fetch('/api/find-pdfs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: lead.id }),
      });
      stopPoll();
      let attempts = 0;
      pollRef.current = setInterval(async () => {
        attempts += 1;
        try {
          const res = await fetch('/api/find-pdfs-status');
          const st = await res.json();
          if (st.lead_id !== lead.id) {
            if (attempts > 120) {
              stopPoll();
              setSearching(false);
              setPdfMsg('Tiempo de espera agotado; revisa el estado más tarde.');
            }
            return;
          }
          if (st.state === 'done') {
            stopPoll();
            setSearching(false);
            const n = st.result?.found ?? 0;
            setPdfMsg(n > 0 ? `✓ ${n} PDF(s) descargados` : 'Sin resultados esta vez');
            const fresh = await fetch(`/api/leads?q=${encodeURIComponent(lead.organisation)}`);
            if (fresh.ok) {
              const d = await fresh.json();
              const updated = (d.leads as Lead[]).find((l) => l.id === lead.id);
              if (updated) { setLead(updated); onCreated(updated); }
            }
          } else if (st.state === 'error') {
            stopPoll();
            setSearching(false);
            setPdfMsg(`✗ ${st.error ?? 'error'}`);
          }
        } catch (err) {
          stopPoll();
          setSearching(false);
          setPdfMsg(`✗ ${String(err)}`);
        }
      }, 2500);
    } catch (err) {
      setSearching(false);
      setPdfMsg(`✗ ${String(err)}`);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8">
      <div className="lead-modal-backdrop fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="lead-modal-panel relative w-full max-w-2xl rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#0d0d0f] shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 px-5 py-3">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Plus size={14} className="text-emerald-500" />
            {lead ? lead.organisation : 'Nuevo lead'}
          </h2>
          <button onClick={onClose} className="rounded-lg p-1 text-zinc-500 transition-all duration-200 hover:scale-110 hover:text-zinc-800 dark:hover:text-zinc-200">
            <X size={16} />
          </button>
        </div>

        {!lead ? (
          <form onSubmit={create} className="p-5 space-y-4">
            <Field label="Organización *">
              <input
                autoFocus
                className={inputCls}
                value={form.organisation}
                onChange={(e) => set('organisation', e.target.value)}
                placeholder="Nombre de la organización"
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Prioridad">
                <Select value={form.priority} onValueChange={(v) => set('priority', v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Sin prioridad" />
                  </SelectTrigger>
                  <SelectContent>
                    {priorities.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Estado">
                <Select value={form.status} onValueChange={(v) => set('status', v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Not contacted" />
                  </SelectTrigger>
                  <SelectContent>
                    {statuses.map((st) => <SelectItem key={st} value={st}>{st}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Sector">
                <input className={inputCls} list="nl-sectors" value={form.sector} onChange={(e) => set('sector', e.target.value)} />
                <datalist id="nl-sectors">{sectors.map((s) => <option key={s} value={s} />)}</datalist>
              </Field>
              <Field label="Tipo">
                <input className={inputCls} value={form.type} onChange={(e) => set('type', e.target.value)} />
              </Field>
              <Field label="País">
                <input className={inputCls} list="nl-countries" value={form.country} onChange={(e) => set('country', e.target.value)} />
                <datalist id="nl-countries">{countries.map((c) => <option key={c} value={c} />)}</datalist>
              </Field>
              <Field label="Ciudad">
                <input className={inputCls} value={form.city} onChange={(e) => set('city', e.target.value)} />
              </Field>
              <Field label="Web">
                <input className={inputCls} value={form.website} onChange={(e) => set('website', e.target.value)} placeholder="https://" />
              </Field>
              <Field label="LinkedIn">
                <input className={inputCls} value={form.linkedin} onChange={(e) => set('linkedin', e.target.value)} placeholder="https://linkedin.com/company/…" />
              </Field>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <Field label="Contacto">
                <input className={inputCls} value={form.contact1_name} onChange={(e) => set('contact1_name', e.target.value)} />
              </Field>
              <Field label="Cargo">
                <input className={inputCls} value={form.contact1_title} onChange={(e) => set('contact1_title', e.target.value)} />
              </Field>
              <Field label="Email">
                <input className={inputCls} type="email" value={form.contact1_email} onChange={(e) => set('contact1_email', e.target.value)} />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Email general">
                <input className={inputCls} type="email" value={form.general_email} onChange={(e) => set('general_email', e.target.value)} />
              </Field>
              <Field label="Relación con Think Things">
                <input className={inputCls} value={form.relationship} onChange={(e) => set('relationship', e.target.value)} />
              </Field>
            </div>

            <Field label="Rationale">
              <textarea className={`${inputCls} min-h-[60px] resize-y`} value={form.rationale} onChange={(e) => set('rationale', e.target.value)} />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Próxima acción">
                <input className={inputCls} value={form.next_action} onChange={(e) => set('next_action', e.target.value)} />
              </Field>
              <Field label="Notas">
                <input className={inputCls} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
              </Field>
            </div>

            {error && <p className="text-[11px] text-rose-500">{error}</p>}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button type="button" onClick={onClose} className={btnGhost}>Cancelar</button>
              <button type="submit" disabled={saving} className={btnPrimary}>
                {saving ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                Crear lead
              </button>
            </div>
          </form>
        ) : (
          <div className="p-5 space-y-4">
            <div className="flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-100 dark:bg-emerald-950/40 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
              <Check size={14} /> Lead creado. Ahora puedes añadirle PDFs.
            </div>

            <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 space-y-3">
              <p className={labelCls}>PDFs ({lead.pdfs.length})</p>

              {lead.pdfs.length > 0 && (
                <ul className="space-y-1">
                  {lead.pdfs.map((p) => (
                    <li key={p.file} className="flex items-center gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-300">
                      <FileText size={12} className="text-emerald-500 shrink-0" />
                      <span className="truncate">{p.title || p.file}</span>
                    </li>
                  ))}
                </ul>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/pdf"
                  multiple
                  className="hidden"
                  onChange={(e) => uploadPdfs(e.target.files)}
                />
                <button onClick={() => fileRef.current?.click()} disabled={uploading} className={btnPrimary}>
                  {uploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
                  Subir PDFs
                </button>
                <button onClick={findPdfs} disabled={searching} className={btnGhost}>
                  {searching ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
                  Buscar automáticamente
                </button>
              </div>

              {pdfMsg && <p className="text-[11px] text-zinc-500">{pdfMsg}</p>}
            </div>

            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => { setForm({ ...EMPTY }); setLead(null); setPdfMsg(null); }}
                className={btnGhost}
              >
                <Plus size={12} /> Crear otro
              </button>
              <button onClick={onClose} className={btnPrimary}>Listo</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
