import React, { useEffect, useState } from 'react';
import { X, ScrollText, Loader2, Radar, ChevronRight, Users } from 'lucide-react';
import { fmtDate } from '../lib/types';
import { Badge, priorityVariant } from './ui/badge';

interface CronRun {
  id: number;
  job: string;
  ran_at: string;
  summary: string | null;
  leads: {
    id: number;
    organisation: string;
    priority: string | null;
    sector: string | null;
    country: string | null;
    status: string;
  }[];
}

export default function CronLogsModal({ onClose }: { onClose: () => void }) {
  const [runs, setRuns] = useState<CronRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/cron-history');
        const data = await res.json();
        setRuns(data.runs ?? []);
        if (data.runs?.length) setOpen(data.runs[0].id);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[65] flex items-start justify-center overflow-y-auto p-4 sm:p-8">
      <div className="lead-modal-backdrop fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="lead-modal-panel relative w-full max-w-3xl rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#0d0d0f] shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 px-5 py-3">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <ScrollText size={14} className="text-emerald-500" />
            Logs del agente nocturno
          </h2>
          <button onClick={onClose} className="rounded-lg p-1 text-zinc-500 transition-all duration-200 hover:scale-110 hover:text-zinc-800 dark:hover:text-zinc-200">
            <X size={16} />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-5 space-y-2">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-xs text-zinc-500">
              <Loader2 size={14} className="animate-spin" /> Cargando historial…
            </div>
          ) : runs.length === 0 ? (
            <div className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-800 px-4 py-8 text-center text-[11px] text-zinc-500">
              Todavía no hay ejecuciones registradas.
            </div>
          ) : (
            runs.map((run) => {
              const expanded = open === run.id;
              return (
                <div key={run.id} className="rounded-lg border border-zinc-200 dark:border-zinc-800 overflow-hidden">
                  <button
                    onClick={() => setOpen(expanded ? null : run.id)}
                    className="w-full flex items-start gap-2 px-3 py-2.5 text-left transition-colors duration-200 hover:bg-zinc-50 dark:hover:bg-zinc-900/60"
                  >
                    <ChevronRight
                      size={13}
                      className={`mt-0.5 shrink-0 text-zinc-400 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Radar size={11} className="text-emerald-500 shrink-0" />
                        <span className="text-xs text-zinc-800 dark:text-zinc-200">{run.job}</span>
                        <span className="text-[10px] text-zinc-500">{fmtDate(run.ran_at)}</span>
                        <span className="text-[10px] text-zinc-400 dark:text-zinc-600">{String(run.ran_at).slice(11, 16)}</span>
                        {run.leads.length > 0 && (
                          <span className="inline-flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
                            <Users size={10} /> {run.leads.length}
                          </span>
                        )}
                      </div>
                      {!expanded && run.summary && (
                        <p className="mt-1 text-[11px] text-zinc-500 line-clamp-1">{run.summary}</p>
                      )}
                    </div>
                  </button>

                  {expanded && (
                    <div className="border-t border-zinc-200 dark:border-zinc-800 px-3 py-3 space-y-3">
                      <div>
                        <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-1">Resultado</div>
                        <p className="text-[11px] leading-relaxed text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap">
                          {run.summary || 'Sin resumen registrado.'}
                        </p>
                      </div>

                      {run.leads.length > 0 && (
                        <div>
                          <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-1.5">
                            Leads de esta ejecución ({run.leads.length})
                          </div>
                          <div className="space-y-1">
                            {run.leads.map((l) => (
                              <div
                                key={l.id}
                                className="flex items-center justify-between gap-2 rounded-md border border-zinc-200 dark:border-zinc-800 px-2.5 py-1.5 text-[11px]"
                              >
                                <div className="min-w-0 flex items-center gap-2">
                                  <span className="text-zinc-400 dark:text-zinc-600 tabular-nums shrink-0">#{l.id}</span>
                                  <span className="truncate text-zinc-800 dark:text-zinc-200">{l.organisation}</span>
                                </div>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  <span className="text-zinc-500 hidden sm:inline truncate max-w-[120px]">
                                    {[l.sector, l.country].filter(Boolean).join(' · ')}
                                  </span>
                                  {l.priority && <Badge variant={priorityVariant(l.priority)}>{l.priority.split(' ')[0]}</Badge>}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
