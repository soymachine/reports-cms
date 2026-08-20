import React, { useCallback, useEffect, useState } from 'react';
import {
  X, Loader2, Activity, Copy, Radar as RadarIcon, BarChart3, CheckCircle2,
  AlertCircle, Merge, ChevronRight, Coins,
} from 'lucide-react';
import type { Job, Lead } from '../lib/types';
import { fmtDate } from '../lib/types';
import { Badge, priorityVariant } from './ui/badge';

export type InsightsTab = 'jobs' | 'duplicates' | 'radar' | 'funnel';

interface Props {
  tab: InsightsTab;
  onClose: () => void;
  onOpenLead: (lead: Lead) => void;
  onChanged: () => void;
}

const btnGhost =
  'inline-flex items-center justify-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-600 dark:text-zinc-300 transition-all duration-200 hover:scale-[1.02] active:scale-[0.97] hover:border-emerald-500/60 hover:text-emerald-600 dark:hover:text-emerald-400 disabled:opacity-50';
const btnPrimary =
  'inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 text-white px-2.5 py-1 text-[11px] transition-all duration-200 hover:bg-emerald-500 hover:scale-[1.02] active:scale-[0.97] disabled:opacity-50';

const TABS: { id: InsightsTab; label: string; icon: React.ReactNode }[] = [
  { id: 'jobs', label: 'Trabajos', icon: <Activity size={12} /> },
  { id: 'duplicates', label: 'Duplicados', icon: <Copy size={12} /> },
  { id: 'radar', label: 'Radar', icon: <RadarIcon size={12} /> },
  { id: 'funnel', label: 'Métricas', icon: <BarChart3 size={12} /> },
];

const STATE_STYLE: Record<string, string> = {
  running: 'text-amber-600 dark:text-amber-400',
  queued: 'text-zinc-500',
  done: 'text-emerald-600 dark:text-emerald-400',
  error: 'text-rose-600 dark:text-rose-400',
};

const JOB_LABEL: Record<string, string> = {
  find_pdfs: 'Buscar PDFs',
  render_pages: 'Renderizar páginas',
  generate: 'Generar rediseños',
  score: 'Recalcular scores',
  dedupe: 'Detectar duplicados',
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-[10px] uppercase tracking-widest text-zinc-500 mb-2">{title}</h3>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ jobs */

function JobsPanel() {
  const [data, setData] = useState<{ active: Job[]; recent: Job[] } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/jobs?limit=40');
    if (res.ok) setData(await res.json());
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  if (!data) return <Loading />;

  const row = (j: Job) => (
    <div key={j.id} className="flex items-start gap-2 rounded-lg border border-zinc-200 dark:border-zinc-800 px-3 py-2">
      <span className={`mt-0.5 ${STATE_STYLE[j.state] ?? ''}`}>
        {j.state === 'running' || j.state === 'queued' ? <Loader2 size={12} className="animate-spin" />
          : j.state === 'done' ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap text-[11px]">
          <span className="text-zinc-800 dark:text-zinc-200">{JOB_LABEL[j.type] ?? j.type}</span>
          {j.lead_id && <span className="text-zinc-400 dark:text-zinc-600">lead #{j.lead_id}</span>}
          <span className={STATE_STYLE[j.state]}>{j.state}</span>
          {j.credits != null && (
            <span className="inline-flex items-center gap-0.5 text-amber-600 dark:text-amber-400">
              <Coins size={10} /> {j.credits}
            </span>
          )}
          <span className="text-zinc-400 dark:text-zinc-600 ml-auto">{String(j.created_at).slice(5, 16)}</span>
        </div>
        {j.payload?.style_name && (
          <div className="text-[10px] text-zinc-500 mt-0.5">
            {j.payload.style_name}
            {Array.isArray(j.payload.pages) ? ` · págs ${j.payload.pages.join(', ')}` : ''}
          </div>
        )}
        {j.error && <div className="text-[10px] text-rose-500 mt-0.5 line-clamp-2">{j.error}</div>}
        {j.state === 'done' && j.result?.found != null && (
          <div className="text-[10px] text-zinc-500 mt-0.5">{j.result.found} PDF(s) descargados</div>
        )}
        {j.state === 'done' && Array.isArray(j.result?.generated) && (
          <div className="text-[10px] text-zinc-500 mt-0.5">{j.result.generated.length} imagen(es) generadas</div>
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <Section title={`En curso (${data.active.length})`}>
        {data.active.length === 0
          ? <Empty>Nada ejecutándose ahora mismo.</Empty>
          : <div className="space-y-1.5">{data.active.map(row)}</div>}
      </Section>
      <Section title="Historial">
        {data.recent.length === 0 ? <Empty>Sin trabajos registrados.</Empty> : <div className="space-y-1.5">{data.recent.map(row)}</div>}
      </Section>
    </div>
  );
}

/* ------------------------------------------------------------ duplicates */

function DuplicatesPanel({ onChanged }: { onChanged: () => void }) {
  const [clusters, setClusters] = useState<any[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setClusters(null);
    const res = await fetch('/api/duplicates');
    const data = await res.json();
    setClusters(data.ok ? data.detail ?? [] : []);
    if (!data.ok) setMsg(`✗ ${data.error}`);
  }, []);

  useEffect(() => { load(); }, [load]);

  const merge = async (keep: number, drop: number[]) => {
    setBusy(keep);
    try {
      const res = await fetch('/api/duplicates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keep, drop }),
      });
      const data = await res.json();
      if (data.ok) {
        setMsg(`✓ Fusionados ${data.merged.length} en #${data.kept}`);
        setClusters((cs) => (cs ?? []).filter((c) => c.keep !== keep));
        onChanged();
      } else {
        setMsg(`✗ ${data.error}`);
      }
    } finally {
      setBusy(null);
    }
  };

  if (clusters === null) return <Loading text="Analizando duplicados…" />;

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-zinc-500">
        Candidatos detectados por dominio web o nombre similar. Nada se fusiona sin que lo confirmes: revisa
        cada grupo, porque dos organizaciones distintas pueden compartir dominio por un error de datos.
      </p>
      {msg && <p className="text-[11px] text-zinc-500">{msg}</p>}
      {clusters.length === 0 ? (
        <Empty>Sin duplicados detectados.</Empty>
      ) : (
        clusters.map((c) => (
          <div key={c.keep} className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-[10px] uppercase tracking-widest text-amber-600 dark:text-amber-400">
                {c.reasons.join(' · ')}
              </span>
              <button
                onClick={() => merge(c.keep, c.members.slice(1).map((m: any) => m.id))}
                disabled={busy === c.keep}
                className={btnPrimary}
              >
                {busy === c.keep ? <Loader2 size={11} className="animate-spin" /> : <Merge size={11} />}
                Fusionar en #{c.keep}
              </button>
            </div>
            <div className="space-y-1">
              {c.members.map((m: any, i: number) => (
                <div key={m.id} className="flex items-center justify-between gap-2 text-[11px] rounded-md border border-zinc-200 dark:border-zinc-800 px-2.5 py-1.5">
                  <div className="min-w-0 flex items-center gap-2">
                    <span className="text-zinc-400 dark:text-zinc-600 tabular-nums">#{m.id}</span>
                    <span className="truncate text-zinc-800 dark:text-zinc-200">{m.organisation}</span>
                    {i === 0 && <Badge variant="accent">se conserva</Badge>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0 text-zinc-500">
                    {m.domain && <span className="hidden sm:inline truncate max-w-[140px]">{m.domain}</span>}
                    <span>{m.pdfs} PDF</span>
                    <span className="text-zinc-400 dark:text-zinc-600">{m.source}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- radar */

function RadarPanel({ onOpenLead }: { onOpenLead: (l: Lead) => void }) {
  const [data, setData] = useState<any | null>(null);

  useEffect(() => {
    (async () => {
      const res = await fetch('/api/radar');
      if (res.ok) setData(await res.json());
    })();
  }, []);

  if (!data) return <Loading />;

  const list = (items: any[], tone: string) => (
    <div className="space-y-1">
      {items.map((l) => (
        <button
          key={l.id}
          onClick={() => onOpenLead(l)}
          className="w-full flex items-center justify-between gap-2 rounded-md border border-zinc-200 dark:border-zinc-800 px-2.5 py-1.5 text-[11px] text-left transition-all duration-200 hover:border-emerald-500/40 hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
        >
          <div className="min-w-0 flex items-center gap-2">
            <span className="text-zinc-400 dark:text-zinc-600 tabular-nums">#{l.id}</span>
            <span className="truncate text-zinc-800 dark:text-zinc-200">{l.organisation}</span>
            {l.priority && <Badge variant={priorityVariant(l.priority)}>{l.priority.split(' ')[0]}</Badge>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-zinc-500 hidden sm:inline">informe {fmtDate(l.report_published_at)}</span>
            <span className={tone}>{l.months_since_report} meses</span>
          </div>
        </button>
      ))}
    </div>
  );

  return (
    <div className="space-y-4">
      <p className="text-[11px] text-zinc-500">
        Ciclo de publicación estimado: {data.cycle_months} meses (±{data.window_months}).
        Seguimiento sobre {data.counts.tracked} leads con fecha de informe conocida.
      </p>
      <Section title={`Toca ahora (${data.counts.due})`}>
        {data.due.length === 0 ? <Empty>Ningún lead en ventana.</Empty> : list(data.due, 'text-emerald-600 dark:text-emerald-400')}
      </Section>
      <Section title={`Se acercan (${data.counts.upcoming})`}>
        {data.upcoming.length === 0 ? <Empty>Nada en el horizonte cercano.</Empty> : list(data.upcoming, 'text-zinc-500')}
      </Section>
    </div>
  );
}

/* ---------------------------------------------------------------- funnel */

function FunnelPanel() {
  const [data, setData] = useState<any | null>(null);

  useEffect(() => {
    (async () => {
      const res = await fetch('/api/funnel');
      if (res.ok) setData(await res.json());
    })();
  }, []);

  if (!data) return <Loading />;

  return (
    <div className="space-y-5">
      <Section title="Embudo">
        <div className="space-y-1.5">
          {data.stages.map((s: any) => (
            <div key={s.key} className="flex items-center gap-2 text-[11px]">
              <span className="w-28 shrink-0 text-zinc-600 dark:text-zinc-400">{s.label}</span>
              <div className="flex-1 h-4 rounded bg-zinc-100 dark:bg-zinc-900 overflow-hidden">
                <div
                  className="h-full bg-emerald-500/70 transition-all duration-500"
                  style={{ width: `${Math.max(s.pct_of_total, s.count ? 2 : 0)}%` }}
                />
              </div>
              <span className="w-10 text-right tabular-nums text-zinc-800 dark:text-zinc-200">{s.count}</span>
              <span
                className="w-24 text-right text-zinc-500 tabular-nums"
                title={s.pct_of_prev === null ? 'Esta etapa tiene más leads que la anterior: el pipeline no es estrictamente secuencial' : undefined}
              >
                {s.pct_of_prev === null ? 'fuera de orden' : `${s.pct_of_prev}% del previo`}
              </span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Créditos Magnific">
        <div className="grid grid-cols-3 gap-2 text-[11px]">
          <Stat label="gastados" value={data.credits.total} />
          <Stat label="leads con coste" value={data.credits.leads_with_cost} />
          <Stat label="media por lead" value={data.credits.avg_per_lead} />
        </div>
      </Section>

      <Section title="Por sector (mín. 3 leads)">
        <Table
          head={['Sector', 'Leads', 'PDF', 'Demo', 'Resp.', 'Won']}
          rows={data.by_sector.map((r: any) => [r.sector, r.total, r.with_pdfs, r.with_generated, r.replied, r.won])}
        />
      </Section>

      <Section title="Por estilo de rediseño">
        {data.by_style.length === 0 ? <Empty>Todavía no hay rediseños.</Empty> : (
          <Table
            head={['Estilo', 'Imágenes', 'Leads', 'Resp.', 'Won']}
            rows={data.by_style.map((r: any) => [r.style, r.images, r.leads, r.replied, r.won])}
          />
        )}
      </Section>

      <Section title="Trabajos">
        <Table
          head={['Tipo', 'Ejecuciones', 'Errores', 'Créditos']}
          rows={data.jobs.map((r: any) => [JOB_LABEL[r.type] ?? r.type, r.runs, r.errors, r.credits ?? 0])}
        />
      </Section>
    </div>
  );
}

/* ----------------------------------------------------------------- bits */

const Loading = ({ text = 'Cargando…' }: { text?: string }) => (
  <div className="flex items-center justify-center gap-2 py-10 text-xs text-zinc-500">
    <Loader2 size={14} className="animate-spin" /> {text}
  </div>
);

const Empty = ({ children }: { children: React.ReactNode }) => (
  <div className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-800 px-4 py-6 text-center text-[11px] text-zinc-500">
    {children}
  </div>
);

const Stat = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 px-3 py-2">
    <div className="text-sm text-zinc-900 dark:text-zinc-100 tabular-nums">{value}</div>
    <div className="text-[10px] text-zinc-500">{label}</div>
  </div>
);

const Table = ({ head, rows }: { head: string[]; rows: any[][] }) => (
  <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
    <table className="w-full text-[11px]">
      <thead>
        <tr className="bg-zinc-50 dark:bg-zinc-900/60 text-zinc-500">
          {head.map((h, i) => (
            <th key={h} className={`px-2.5 py-1.5 font-medium ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-t border-zinc-100 dark:border-zinc-800/60">
            {r.map((c, j) => (
              <td key={j} className={`px-2.5 py-1.5 ${j === 0 ? 'text-zinc-800 dark:text-zinc-200' : 'text-right tabular-nums text-zinc-600 dark:text-zinc-400'}`}>
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

/* ----------------------------------------------------------------- shell */

export default function InsightsModal({ tab, onClose, onOpenLead, onChanged }: Props) {
  const [active, setActive] = useState<InsightsTab>(tab);

  useEffect(() => setActive(tab), [tab]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[65] flex items-start justify-center overflow-y-auto p-4 sm:p-8">
      <div className="lead-modal-backdrop fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="lead-modal-panel relative w-full max-w-4xl rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#0d0d0f] shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 px-5 py-3">
          <div className="flex items-center gap-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setActive(t.id)}
                className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] transition-all duration-200 hover:scale-[1.03] active:scale-[0.97] ${
                  active === t.id
                    ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30'
                    : 'text-zinc-500 border border-transparent hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60'
                }`}
              >
                {t.icon} {t.label}
              </button>
            ))}
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-zinc-500 transition-all duration-200 hover:scale-110 hover:text-zinc-800 dark:hover:text-zinc-200">
            <X size={16} />
          </button>
        </div>

        <div className="max-h-[75vh] overflow-y-auto p-5">
          {active === 'jobs' && <JobsPanel />}
          {active === 'duplicates' && <DuplicatesPanel onChanged={onChanged} />}
          {active === 'radar' && <RadarPanel onOpenLead={onOpenLead} />}
          {active === 'funnel' && <FunnelPanel />}
        </div>
      </div>
    </div>
  );
}
