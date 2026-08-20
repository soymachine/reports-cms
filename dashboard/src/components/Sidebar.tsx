import React from 'react';
import { Search, Moon, Sun, Radar, FileText, Sparkles, Users, Loader2, CircleDot, ScrollText, Activity, Copy, BarChart3, Gauge, Coins } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import CronLogsModal from './CronLogsModal';
import type { StatsResponse } from '../lib/types';
import { fmtDate } from '../lib/types';

type MagnificStatus = 'loading' | 'connected' | 'auth_required' | 'error';

function MagnificDot() {
  const [status, setStatus] = React.useState<MagnificStatus>('loading');
  const [detail, setDetail] = React.useState('');

  const check = React.useCallback(async () => {
    try {
      const res = await fetch('/api/magnific-status');
      const data = await res.json();
      setStatus(data.status ?? (data.ok ? 'connected' : 'error'));
      setDetail(data.detail ?? '');
    } catch {
      setStatus('error');
    }
  }, []);

  React.useEffect(() => {
    check();
    const t = setInterval(check, 60_000);
    return () => clearInterval(t);
  }, [check]);

  const color =
    status === 'connected' ? 'bg-emerald-500' :
    status === 'loading' ? 'bg-zinc-400 animate-pulse' :
    status === 'auth_required' ? 'bg-rose-500' : 'bg-amber-500';

  const label =
    status === 'connected' ? 'Magnific MCP activo' :
    status === 'loading' ? 'Magnific: comprobando…' :
    status === 'auth_required' ? 'Magnific: login necesario (scripts/magnific_login.py)' :
    'Magnific: error de conexión';

  return (
    <div className="mt-2 flex justify-end">
      <button
        onClick={check}
        title={`${label}${detail ? `\n${detail}` : ''}`}
        className="inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[9px] text-zinc-400 dark:text-zinc-600 transition-colors duration-200 hover:text-zinc-600 dark:hover:text-zinc-400 cursor-pointer"
      >
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${color}`} />
        Magnific {status === 'connected' ? 'activo' : status === 'loading' ? '…' : status === 'auth_required' ? 'login necesario' : 'error'}
      </button>
    </div>
  );
}

export interface Filters {
  q: string;
  priority: string;
  sector: string;
  country: string;
  source: string;
}

interface Props {
  stats: StatsResponse | null;
  filters: Filters;
  onFilters: (f: Filters) => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onOpenInsights: (tab: 'jobs' | 'duplicates' | 'radar' | 'funnel') => void;
  onRescore: () => Promise<void>;
}

// Radix Select rejects "" as an item value, so the "all" option carries a sentinel.
const ALL = '__all__';

function FilterSelect({
  value, onChange, placeholder, options,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  options: string[];
}) {
  return (
    <Select value={value || ALL} onValueChange={(v) => onChange(v === ALL ? '' : v)}>
      <SelectTrigger>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{placeholder}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o} value={o}>{o}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function HealthRow({
  icon, label, value, onClick, highlight,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  onClick: () => void;
  highlight?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center justify-between rounded-md px-2 py-1 text-[11px] transition-all duration-200 hover:scale-[1.01] hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60 cursor-pointer text-muted"
    >
      <span className="inline-flex items-center gap-1.5">{icon} {label}</span>
      <span className={highlight ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted'}>{value}</span>
    </button>
  );
}

interface CreditsInfo {
  balance: {
    credits?: { available?: number; totalPlan?: number; spent?: number };
    plan?: { productName?: string };
    error?: string;
  } | null;
  spent_today: number;
  spent_total: number;
  by_lead: { id: number; organisation: string; credits: number }[];
}

export default function Sidebar({ stats, filters, onFilters, theme, onToggleTheme, onOpenInsights, onRescore }: Props) {
  const [scoring, setScoring] = React.useState(false);
  // real Magnific balance, not our own tally of what we think we spent
  const [credits, setCredits] = React.useState<CreditsInfo | null>(null);

  React.useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const data = await (await fetch('/api/credits')).json();
        if (alive && data.ok) setCredits(data);
      } catch { /* the sidebar shows a dash */ }
    };
    load();
    const t = setInterval(load, 120_000);   // the endpoint caches for a minute
    return () => { alive = false; clearInterval(t); };
  }, []);

  const available = credits?.balance?.credits?.available ?? null;
  // Magnific reports the plan's own tally: what it has charged us and the
  // annual allowance. The sidebar shows consumed / total, not our local sum.
  const totalPlan = credits?.balance?.credits?.totalPlan ?? null;
  const consumed = credits?.balance?.credits?.spent
    ?? (available != null && totalPlan != null ? totalPlan - available : null);
  const usedPct = consumed != null && totalPlan ? Math.min(100, (consumed / totalPlan) * 100) : null;
  const [scoreMsg, setScoreMsg] = React.useState<string | null>(null);

  const rescore = async () => {
    setScoring(true);
    setScoreMsg(null);
    try {
      await onRescore();
      setScoreMsg('✓ Scores recalculados');
    } catch (e) {
      setScoreMsg(`✗ ${String(e)}`);
    } finally {
      setScoring(false);
      setTimeout(() => setScoreMsg(null), 6000);
    }
  };

  const [hunting, setHunting] = React.useState(false);
  const [huntMsg, setHuntMsg] = React.useState<string | null>(null);
  const [logsOpen, setLogsOpen] = React.useState(false);

  const set = (patch: Partial<Filters>) => onFilters({ ...filters, ...patch });

  const huntNow = async () => {
    setHunting(true);
    setHuntMsg(null);
    try {
      const res = await fetch('/api/hunt-now', { method: 'POST' });
      const data = await res.json();
      setHuntMsg(data.ok ? `✓ ${data.message ?? 'Lanzado'}` : `✗ ${data.error ?? 'error'}`);
    } catch (e) {
      setHuntMsg(`✗ ${String(e)}`);
    } finally {
      setHunting(false);
      setTimeout(() => setHuntMsg(null), 6000);
    }
  };

  const prioEntries = stats ? Object.entries(stats.by_priority).sort() : [];

  return (
    <aside className="fixed inset-y-0 left-0 w-64 flex flex-col border-r border-subtle bg-zinc-50 dark:bg-[#0a0a0b] z-20">
      {/* Logo */}
      <div className="px-4 pt-5 pb-4 border-b border-subtle">
        <img
          src={theme === 'dark' ? '/Logo_TT2024_color_horitzontal.png' : '/Logo_TT2024_negro_horitzontal.png'}
          alt="ThinkThings"
          className="w-full h-auto object-contain px-2"
        />
        <MagnificDot />
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6 pb-20">
        {/* Stats */}
        <section>
          <h3 className="text-[10px] uppercase tracking-widest text-muted mb-2">Pipeline</h3>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-card border border-subtle bg-white dark:bg-zinc-900/60 p-2.5 transition-all duration-200 hover:scale-[1.02] hover:shadow-md">
              <div className="text-lg font-medium text-zinc-900 dark:text-zinc-100">{stats?.total ?? '—'}</div>
              <div className="text-[10px] text-muted flex items-center gap-1"><Users size={10} /> leads</div>
            </div>
            <div className="rounded-card border border-subtle bg-white dark:bg-zinc-900/60 p-2.5 transition-all duration-200 hover:scale-[1.02] hover:shadow-md">
              <div className="text-lg font-medium text-zinc-900 dark:text-zinc-100">{stats?.with_pdfs ?? '—'}</div>
              <div className="text-[10px] text-muted flex items-center gap-1"><FileText size={10} /> con PDFs</div>
            </div>
            <div className="rounded-card border border-subtle bg-white dark:bg-zinc-900/60 p-2.5 transition-all duration-200 hover:scale-[1.02] hover:shadow-md">
              <div className="text-lg font-medium text-zinc-900 dark:text-zinc-100">{stats?.with_generated ?? '—'}</div>
              <div className="text-[10px] text-muted flex items-center gap-1"><Sparkles size={10} /> rediseños</div>
            </div>
            <div className="rounded-card border border-subtle bg-white dark:bg-zinc-900/60 p-2.5 transition-all duration-200 hover:scale-[1.02] hover:shadow-md">
              <div className="text-lg font-medium text-emerald-600 dark:text-emerald-400">{stats?.by_status?.['Won'] ?? 0}</div>
              <div className="text-[10px] text-muted flex items-center gap-1"><CircleDot size={10} /> won</div>
            </div>
          </div>
          {prioEntries.length > 0 && (
            <div className="mt-2 space-y-1">
              {prioEntries.map(([p, c]) => (
                <button
                  key={p}
                  onClick={() => set({ priority: filters.priority === p ? '' : p })}
                  className={`w-full flex items-center justify-between rounded-md px-2 py-1 text-[11px] transition-all duration-200 hover:scale-[1.01] hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60 cursor-pointer ${
                    filters.priority === p ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'text-muted'
                  }`}
                >
                  <span>{p}</span>
                  <span className="text-muted">{c}</span>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* Pipeline health */}
        <section>
          <h3 className="text-[10px] uppercase tracking-widest text-muted mb-2">Control</h3>
          <div className="space-y-1">
            <div className="rounded-md px-2 py-1 text-[11px] text-muted space-y-0.5">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5"><Coins size={11} /> Créditos</span>
                <span
                  className={available == null ? 'text-zinc-500' : available < 5000 ? 'text-rose-500' : 'text-emerald-600 dark:text-emerald-400'}
                  title={
                    credits?.balance?.error
                      ? String(credits.balance.error)
                      : `Consumido / plan anual${credits?.balance?.plan?.productName ? ` (${credits.balance.plan.productName})` : ''} — disponibles ${available != null ? available.toLocaleString('es-ES') : '—'}`
                  }
                >
                  {consumed != null && totalPlan != null
                    ? `${consumed.toLocaleString('es-ES')} / ${totalPlan.toLocaleString('es-ES')}`
                    : available != null ? available.toLocaleString('es-ES') : '—'}
                </span>
              </div>
              {usedPct != null && (
                <div className="h-1 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${usedPct > 90 ? 'bg-rose-500' : usedPct > 70 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                    style={{ width: `${usedPct}%` }}
                  />
                </div>
              )}
              {credits && (
                <div className="flex items-center justify-between text-[10px] text-zinc-500">
                  <span>gastados hoy</span>
                  <span className="text-amber-600 dark:text-amber-400">{Math.round(credits.spent_today ?? 0)}</span>
                </div>
              )}
            </div>
            <HealthRow
              icon={<Activity size={11} />}
              label="Trabajos"
              value={stats?.active_jobs ? `${stats.active_jobs} en curso` : 'inactivo'}
              highlight={Boolean(stats?.active_jobs)}
              onClick={() => onOpenInsights('jobs')}
            />
            <HealthRow
              icon={<Copy size={11} />}
              label="Duplicados"
              value={stats?.duplicates ? `${stats.duplicates} marcados` : 'revisar'}
              highlight={Boolean(stats?.duplicates)}
              onClick={() => onOpenInsights('duplicates')}
            />
            <HealthRow
              icon={<Radar size={11} />}
              label="Radar"
              value={stats?.radar_due ? `${stats.radar_due} en ventana` : '—'}
              highlight={Boolean(stats?.radar_due)}
              onClick={() => onOpenInsights('radar')}
            />
            <HealthRow
              icon={<BarChart3 size={11} />}
              label="Métricas"
              value="embudo"
              onClick={() => onOpenInsights('funnel')}
            />
            <button
              onClick={rescore}
              disabled={scoring}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-md border border-subtle px-2 py-1 text-[10px] text-muted transition-all duration-200 hover:scale-[1.01] active:scale-[0.98] hover:border-emerald-500/50 hover:text-emerald-600 dark:hover:text-emerald-400 disabled:opacity-50"
            >
              {scoring ? <Loader2 size={10} className="animate-spin" /> : <Gauge size={10} />}
              Recalcular prioridades
            </button>
            {scoreMsg && <div className="text-[10px] text-muted text-center">{scoreMsg}</div>}
          </div>
        </section>

        {/* Filters */}
        <section>
          <h3 className="text-[10px] uppercase tracking-widest text-muted mb-2">Filtros</h3>
          <div className="space-y-2">
            <div className="relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
              <input
                value={filters.q}
                onChange={(e) => set({ q: e.target.value })}
                placeholder="Buscar…"
                className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-subtle pl-7 pr-2 py-1.5 text-xs text-zinc-800 dark:text-zinc-200 placeholder:text-muted transition-all duration-200 hover:border-emerald-500/50 focus:border-emerald-500 focus:outline-none"
              />
            </div>
            <FilterSelect
              value={filters.priority}
              onChange={(v) => set({ priority: v })}
              placeholder="Todas las prioridades"
              options={stats?.settings.priorities ?? []}
            />
            <FilterSelect
              value={filters.sector}
              onChange={(v) => set({ sector: v })}
              placeholder="Todos los sectores"
              options={stats?.sectors ?? []}
            />
            <FilterSelect
              value={filters.country}
              onChange={(v) => set({ country: v })}
              placeholder="Todos los países"
              options={stats?.countries ?? []}
            />
            <FilterSelect
              value={filters.source}
              onChange={(v) => set({ source: v })}
              placeholder="Todas las fuentes"
              options={['excel', 'agent', 'manual']}
            />
          </div>
        </section>

        {/* Night agent */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-[10px] uppercase tracking-widest text-muted">Agente nocturno</h3>
            <button
              onClick={() => setLogsOpen(true)}
              title="Ver logs de ejecuciones"
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-muted transition-all duration-200 hover:scale-[1.03] active:scale-[0.97] hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-500/10 cursor-pointer"
            >
              <ScrollText size={11} /> Logs
            </button>
          </div>
          <div className="rounded-card border border-subtle bg-white dark:bg-zinc-900/60 p-3 space-y-2 transition-all duration-200 hover:shadow-md">
            <div className="text-[11px] text-muted">
              {stats?.settings.cron_description ?? 'Búsqueda diaria de leads'}
            </div>
            <div className="text-[10px] text-muted">
              cron <span className="text-zinc-800 dark:text-zinc-200">{stats?.settings.cron_schedule ?? '—'}</span>
              {' · '}job <span className="text-zinc-800 dark:text-zinc-200">{stats?.settings.cron_job_id ?? '—'}</span>
            </div>
            {stats?.last_cron && (
              <div className="text-[10px] text-muted border-t border-subtle pt-2">
                última ejecución: <span className="text-zinc-800 dark:text-zinc-200">{fmtDate(stats.last_cron.ran_at)}</span>
                {stats.last_cron.summary && <div className="mt-0.5 line-clamp-2">{stats.last_cron.summary}</div>}
              </div>
            )}
            <button
              onClick={huntNow}
              disabled={hunting}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 text-white px-3 py-1.5 text-xs transition-all duration-200 hover:bg-emerald-500 hover:scale-[1.02] active:scale-[0.97] shadow-sm hover:shadow-md disabled:opacity-50"
            >
              {hunting ? <Loader2 size={12} className="animate-spin" /> : <Radar size={12} />}
              Buscar leads ahora
            </button>
            {huntMsg && <div className="text-[10px] text-muted">{huntMsg}</div>}
          </div>
        </section>
      </div>

      {logsOpen && <CronLogsModal onClose={() => setLogsOpen(false)} />}

      {/* Footer: theme toggle */}
      <div className="px-4 py-3 border-t border-subtle">
        <button
          onClick={onToggleTheme}
          className="w-full inline-flex items-center justify-center gap-2 rounded-lg border border-subtle px-3 py-1.5 text-xs text-muted transition-all duration-200 hover:scale-[1.02] active:scale-[0.97] hover:border-emerald-500/60 hover:text-emerald-600 dark:hover:text-emerald-400"
        >
          {theme === 'dark' ? <Sun size={12} /> : <Moon size={12} />}
          {theme === 'dark' ? 'Modo claro' : 'Modo oscuro'}
        </button>
      </div>
    </aside>
  );
}
