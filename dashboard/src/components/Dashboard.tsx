import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import gsap from 'gsap';
import { LayoutGrid, Table2, Download, Plus, Images } from 'lucide-react';
import type { Lead, StatsResponse } from '../lib/types';
import Sidebar, { type Filters } from './Sidebar';
import Kanban from './Kanban';
import LeadTable from './LeadTable';
import LeadDetail from './LeadDetail';
import NewLeadModal from './NewLeadModal';
import InsightsModal, { type InsightsTab } from './InsightsModal';
import Gallery from './Gallery';

type Tab = 'board' | 'table' | 'gallery';
type Theme = 'dark' | 'light';

function reducedMotion(): boolean {
  if (typeof window === 'undefined') return true;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function Dashboard() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [filters, setFilters] = useState<Filters>({ q: '', priority: '', sector: '', country: '', source: '' });
  const [tab, setTab] = useState<Tab>('board');
  const [selected, setSelected] = useState<Lead | null>(null);
  // set when a lead is opened from the gallery: which report (and style) to unfold
  const [focusPdf, setFocusPdf] = useState<{ pdf: string; style?: string; key: number } | null>(null);
  const [sort, setSort] = useState('rank');
  const [dir, setDir] = useState<'asc' | 'desc'>('asc');
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === 'undefined') return 'dark';
    return (localStorage.getItem('tt-theme') as Theme) || 'dark';
  });
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [creating, setCreating] = useState(false);
  const [insights, setInsights] = useState<InsightsTab | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);

  // theme
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('tt-theme', theme);
  }, [theme]);

  const fetchStats = useCallback(async () => {
    const res = await fetch('/api/stats');
    if (res.ok) setStats(await res.json());
  }, []);

  const fetchLeads = useCallback(async () => {
    const params = new URLSearchParams();
    if (filters.q) params.set('q', filters.q);
    if (filters.priority) params.set('priority', filters.priority);
    if (filters.sector) params.set('sector', filters.sector);
    if (filters.country) params.set('country', filters.country);
    if (filters.source) params.set('source', filters.source);
    params.set('sort', sort);
    params.set('dir', dir);
    const res = await fetch(`/api/leads?${params}`);
    if (res.ok) {
      const data = await res.json();
      setLeads(data.leads);
    }
  }, [filters, sort, dir]);

  useEffect(() => { fetchStats(); }, [fetchStats]);
  useEffect(() => {
    const t = setTimeout(fetchLeads, 200); // debounce search
    return () => clearTimeout(t);
  }, [fetchLeads]);

  const patchLead = useCallback(async (id: number, patch: Record<string, unknown>) => {
    const res = await fetch('/api/leads', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...patch }),
    });
    if (res.ok) {
      const data = await res.json();
      setLeads((ls) => ls.map((l) => (l.id === id ? data.lead : l)));
      setSelected((s) => (s && s.id === id ? data.lead : s));
      fetchStats();
      return data.lead as Lead;
    }
    return null;
  }, [fetchStats]);

  const moveLead = useCallback((id: number, status: string) => {
    patchLead(id, { status });
  }, [patchLead]);

  const deleteLeads = useCallback(async (ids: number[]) => {
    if (!ids.length) return;
    const res = await fetch('/api/leads', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) return;
    const gone = new Set<number>(ids);
    setLeads((ls) => ls.filter((l) => !gone.has(l.id)));
    setSelected((s) => (s && gone.has(s.id) ? null : s));
    setSelectedIds((s) => {
      const n = new Set(s);
      for (const id of ids) n.delete(id);
      return n;
    });
    fetchStats();
  }, [fetchStats]);

  const rescore = useCallback(async () => {
    const res = await fetch('/api/rescore', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await Promise.all([fetchStats(), fetchLeads()]);
  }, [fetchStats, fetchLeads]);

  const onLeadCreated = useCallback((lead: Lead) => {
    setLeads((ls) => (ls.some((l) => l.id === lead.id) ? ls.map((l) => (l.id === lead.id ? lead : l)) : [lead, ...ls]));
    fetchStats();
  }, [fetchStats]);

  const openLead = useCallback((lead: Lead) => { setFocusPdf(null); setSelected(lead); }, []);
  const closeLead = useCallback(() => { setFocusPdf(null); setSelected(null); }, []);

  // keyboard: ESC closes (handled in modal too), ↑↓ navigate
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!selected) return;
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const idx = leads.findIndex((l) => l.id === selected.id);
      const next = e.key === 'ArrowDown' ? idx + 1 : idx - 1;
      if (next >= 0 && next < leads.length) setSelected(leads[next]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, leads]);

  // modal entrance animation
  useEffect(() => {
    if ((!selected && !creating && !insights) || reducedMotion()) return;
    gsap.fromTo('.lead-modal-panel', { opacity: 0, scale: 0.97, y: 10 }, { opacity: 1, scale: 1, y: 0, duration: 0.25, ease: 'power2.out' });
    gsap.fromTo('.lead-modal-backdrop', { opacity: 0 }, { opacity: 1, duration: 0.2 });
  }, [selected?.id, creating, insights]);

  const animKey = useMemo(
    () => `${tab}|${filters.q}|${filters.priority}|${filters.sector}|${filters.country}|${filters.source}`,
    [tab, filters]
  );

  const toggleSelect = (id: number) => {
    setSelectedIds((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };

  const bulkStatus = async (status: string) => {
    await Promise.all([...selectedIds].map((id) => patchLead(id, { status })));
    setSelectedIds(new Set());
  };

  const exportCsv = () => {
    const params = new URLSearchParams();
    if (filters.q) params.set('q', filters.q);
    if (filters.priority) params.set('priority', filters.priority);
    if (filters.sector) params.set('sector', filters.sector);
    if (filters.country) params.set('country', filters.country);
    if (filters.source) params.set('source', filters.source);
    window.location.href = `/api/export?${params}`;
  };

  const tabCls = (t: Tab) =>
    `inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-all duration-200 hover:scale-[1.03] active:scale-[0.97] cursor-pointer ${
      tab === t
        ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30'
        : 'text-zinc-500 dark:text-zinc-400 border border-transparent hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60'
    }`;

  return (
    <div className="min-h-screen bg-white dark:bg-[#0a0a0b] text-zinc-900 dark:text-zinc-100">
      <Sidebar
        stats={stats}
        filters={filters}
        onFilters={setFilters}
        theme={theme}
        onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        onOpenInsights={setInsights}
        onRescore={rescore}
      />

      <main ref={mainRef} className="ml-64 min-h-screen">
        {/* top bar */}
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 bg-white/80 dark:bg-[#0a0a0b]/80 backdrop-blur px-5 py-3">
          <div className="flex items-center gap-1">
            <button className={tabCls('board')} onClick={() => setTab('board')}>
              <LayoutGrid size={13} /> Tablero
            </button>
            <button className={tabCls('table')} onClick={() => setTab('table')}>
              <Table2 size={13} /> Tabla
            </button>
            <button className={tabCls('gallery')} onClick={() => setTab('gallery')}>
              <Images size={13} /> Galería
            </button>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-zinc-500">
              {tab === 'gallery' ? `${stats?.with_generated ?? 0} leads con rediseño` : `${leads.length} leads`}
            </span>
            <button
              onClick={() => setCreating(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs text-white shadow-sm transition-all duration-200 hover:bg-emerald-500 hover:scale-[1.03] active:scale-[0.97] hover:shadow-md"
            >
              <Plus size={12} /> Nuevo lead
            </button>
            <button
              onClick={exportCsv}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-xs text-zinc-600 dark:text-zinc-300 transition-all duration-200 hover:scale-[1.03] active:scale-[0.97] hover:border-emerald-500/60 hover:text-emerald-600 dark:hover:text-emerald-400"
            >
              <Download size={12} /> CSV
            </button>
          </div>
        </div>

        <div className="p-5">
          {tab === 'gallery' ? (
            <Gallery
              sectors={stats?.sectors ?? []}
              statuses={stats?.settings.statuses ?? []}
              onOpenLead={async (id, pdfSlug, styleId) => {
                const res = await fetch('/api/leads');
                if (!res.ok) return;
                const data = await res.json();
                const found = (data.leads as Lead[]).find((l) => l.id === id);
                if (!found) return;
                setFocusPdf(pdfSlug ? { pdf: pdfSlug, style: styleId, key: Date.now() } : null);
                setSelected(found);
              }}
            />
          ) : tab === 'board' ? (
            <Kanban
              leads={leads}
              statuses={stats?.settings.statuses ?? []}
              onOpen={openLead}
              onMove={moveLead}
              onDelete={deleteLeads}
              animKey={animKey}
            />
          ) : (
            <LeadTable
              leads={leads}
              sort={sort}
              dir={dir}
              onSort={(col) => {
                if (sort === col) setDir(dir === 'asc' ? 'desc' : 'asc');
                else { setSort(col); setDir('asc'); }
              }}
              onOpen={openLead}
              selectedIds={selectedIds}
              onToggleSelect={toggleSelect}
              onBulkStatus={bulkStatus}
              onDelete={deleteLeads}
              statuses={stats?.settings.statuses ?? []}
            />
          )}
        </div>
      </main>

      {insights && (
        <InsightsModal
          tab={insights}
          onClose={() => setInsights(null)}
          onOpenLead={(l) => { setInsights(null); setFocusPdf(null); setSelected(l); }}
          onChanged={() => { fetchStats(); fetchLeads(); }}
        />
      )}

      {creating && (
        <NewLeadModal
          onClose={() => setCreating(false)}
          onCreated={onLeadCreated}
          statuses={stats?.settings.statuses ?? []}
          priorities={stats?.settings.priorities ?? []}
          sectors={stats?.sectors ?? []}
          countries={stats?.countries ?? []}
        />
      )}

      {selected && (
        <LeadDetail
          lead={selected}
          onClose={closeLead}
          onPatch={patchLead}
          onDelete={deleteLeads}
          statuses={stats?.settings.statuses ?? []}
          stylePresets={stats?.settings.style_presets ?? []}
          maxPages={stats?.settings.max_pages ?? 3}
          focusPdf={focusPdf}
        />
      )}
    </div>
  );
}
