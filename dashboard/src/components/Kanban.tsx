import React, { useEffect, useRef } from 'react';
import gsap from 'gsap';
import { FileText, Sparkles, Bot, Plus, Trash2, Loader2 } from 'lucide-react';
import type { Lead } from '../lib/types';
import { Badge, priorityVariant } from './ui/badge';

interface Props {
  leads: Lead[];
  statuses: string[];
  onOpen: (lead: Lead) => void;
  onMove: (leadId: number, status: string) => void;
  onDelete: (ids: number[]) => Promise<void>;
  animKey: string;
}

function reducedMotion(): boolean {
  if (typeof window === 'undefined') return true;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function Kanban({ leads, statuses, onOpen, onMove, onDelete, animKey }: Props) {
  const [confirmId, setConfirmId] = React.useState<number | null>(null);
  const [busyId, setBusyId] = React.useState<number | null>(null);

  const remove = async (id: number) => {
    setBusyId(id);
    try { await onDelete([id]); } finally { setBusyId(null); setConfirmId(null); }
  };

  const containerRef = useRef<HTMLDivElement>(null);
  const [dragOver, setDragOver] = React.useState<string | null>(null);

  // staggered entrance of cards on load / filter change
  useEffect(() => {
    if (reducedMotion() || !containerRef.current) return;
    const ctx = gsap.context(() => {
      gsap.fromTo(
        '.kanban-card',
        { opacity: 0, y: 8 },
        { opacity: 1, y: 0, duration: 0.3, stagger: 0.02, ease: 'power2.out', clearProps: 'transform,opacity' }
      );
    }, containerRef);
    return () => ctx.revert();
  }, [animKey]);

  const byStatus = (s: string) => leads.filter((l) => l.status === s);

  return (
    <div ref={containerRef} className="flex gap-3 overflow-x-auto pb-4 px-1 items-start">
      {statuses.map((status) => {
        const col = byStatus(status);
        return (
          <div
            key={status}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              if (dragOver !== status) setDragOver(status);
            }}
            onDragLeave={() => setDragOver((d) => (d === status ? null : d))}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(null);
              const id = Number(e.dataTransfer.getData('text/lead-id'));
              if (id) {
                onMove(id, status);
                // micro-animation on the target column
                if (!reducedMotion() && containerRef.current) {
                  const el = containerRef.current.querySelector(`[data-col="${CSS.escape(status)}"]`);
                  if (el) gsap.fromTo(el, { scale: 0.985 }, { scale: 1, duration: 0.25, ease: 'power2.out' });
                }
              }
            }}
            className={`w-72 shrink-0 rounded-card border bg-zinc-100/50 dark:bg-zinc-900/40 transition-all duration-200 ${
              dragOver === status
                ? 'border-emerald-500/60 shadow-lg shadow-emerald-500/5'
                : 'border-subtle'
            }`}
          >
            <div className="flex items-center justify-between px-3 py-2.5 border-b border-subtle">
              <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100">{status}</span>
              <span className="text-[10px] rounded-full bg-zinc-200 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 px-1.5 py-0.5 min-w-[20px] text-center transition-colors duration-200">
                {col.length}
              </span>
            </div>
            <div data-col={status} className="p-2 space-y-2 min-h-[60px] max-h-[calc(100vh-220px)] overflow-y-auto">
              {col.map((lead) => (
                <div
                  key={lead.id}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/lead-id', String(lead.id));
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onClick={() => onOpen(lead)}
                  className="kanban-card group rounded-lg border border-subtle bg-white dark:bg-zinc-900/60 p-3 cursor-pointer transition-all duration-200 hover:scale-[1.01] hover:shadow-md hover:border-emerald-500/40 active:scale-[0.99]"
                >
                  <div className="flex items-start justify-between gap-1.5 mb-1.5">
                    <div className="text-xs font-medium text-zinc-900 dark:text-zinc-100 leading-snug group-hover:text-emerald-700 dark:group-hover:text-emerald-300 transition-colors duration-200">
                      {lead.organisation}
                    </div>
                    <span className="shrink-0" onClick={(e) => e.stopPropagation()}>
                      {confirmId === lead.id ? (
                        <span className="inline-flex items-center gap-1">
                          <button
                            onClick={() => remove(lead.id)}
                            disabled={busyId === lead.id}
                            title="Confirmar borrado"
                            className="rounded bg-rose-600 px-1.5 py-0.5 text-[9px] text-white transition-all duration-200 hover:bg-rose-500 active:scale-95 disabled:opacity-50"
                          >
                            {busyId === lead.id ? <Loader2 size={9} className="animate-spin" /> : 'Sí'}
                          </button>
                          <button
                            onClick={() => setConfirmId(null)}
                            title="Cancelar"
                            className="rounded border border-zinc-300 dark:border-zinc-700 px-1.5 py-0.5 text-[9px] text-zinc-500 transition-all duration-200 hover:border-zinc-400"
                          >
                            No
                          </button>
                        </span>
                      ) : (
                        <button
                          onClick={() => setConfirmId(lead.id)}
                          title="Eliminar lead"
                          className="p-1 rounded text-zinc-400 dark:text-zinc-600 opacity-0 group-hover:opacity-100 transition-all duration-200 hover:text-rose-500 hover:bg-rose-500/10 active:scale-95 focus:opacity-100"
                        >
                          <Trash2 size={11} />
                        </button>
                      )}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1 mb-1.5">
                    {lead.priority && <Badge variant={priorityVariant(lead.priority)}>{lead.priority.split(' ')[0]}</Badge>}
                    {lead.source === 'agent' && (
                      <Badge variant="accent"><Bot size={10} /> agent</Badge>
                    )}
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-muted">
                    <span className="truncate">
                      {[lead.sector, lead.country].filter(Boolean).join(' · ')}
                    </span>
                    <span className="flex items-center gap-1.5 shrink-0 ml-2">
                      {lead.pdfs.length > 0 && (
                        <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
                          <FileText size={11} /> {lead.pdfs.length}
                        </span>
                      )}
                      {lead.generated.length > 0 && (
                        <span className="inline-flex items-center gap-0.5 text-amber-500 dark:text-amber-400">
                          <Sparkles size={11} /> {lead.generated.length}
                        </span>
                      )}
                    </span>
                  </div>
                </div>
              ))}
              {col.length === 0 && (
                <div className="text-[10px] text-zinc-400 dark:text-zinc-600 text-center py-4 select-none">
                  arrastra leads aquí
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
