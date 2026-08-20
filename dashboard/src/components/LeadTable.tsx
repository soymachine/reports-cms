import React from 'react';
import { ArrowUpDown, ArrowUp, ArrowDown, Eye, Globe, FileText, Sparkles, Bot, Trash2, Loader2 } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import type { Lead } from '../lib/types';
import { Badge, priorityVariant } from './ui/badge';

interface Props {
  leads: Lead[];
  sort: string;
  dir: 'asc' | 'desc';
  onSort: (col: string) => void;
  onOpen: (lead: Lead) => void;
  selectedIds: Set<number>;
  onToggleSelect: (id: number) => void;
  onBulkStatus: (status: string) => void;
  onDelete: (ids: number[]) => Promise<void>;
  statuses: string[];
}

const COLUMNS: { key: string; label: string }[] = [
  { key: 'rank', label: '#' },
  { key: 'organisation', label: 'Organización' },
  { key: 'priority', label: 'Prioridad' },
  { key: 'pdfs', label: 'Assets' },
  { key: 'sector', label: 'Sector' },
  { key: 'country', label: 'País' },
  { key: 'status', label: 'Estado' },
  { key: 'contact1_name', label: 'Contacto' },
];

export default function LeadTable({ leads, sort, dir, onSort, onOpen, selectedIds, onToggleSelect, onBulkStatus, onDelete, statuses }: Props) {
  // two-step confirm instead of window.confirm: nothing is deleted on a single click
  const [confirmRow, setConfirmRow] = React.useState<number | null>(null);
  const [confirmBulk, setConfirmBulk] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => { setConfirmBulk(false); }, [selectedIds.size]);

  const removeOne = async (id: number) => {
    setBusy(true);
    try { await onDelete([id]); } finally { setBusy(false); setConfirmRow(null); }
  };

  const removeBulk = async () => {
    setBusy(true);
    try { await onDelete([...selectedIds]); } finally { setBusy(false); setConfirmBulk(false); }
  };

  const sortIcon = (col: string) => {
    if (sort !== col) return <ArrowUpDown size={11} className="opacity-40" />;
    return dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />;
  };

  return (
    <div className="rounded-card border border-zinc-200 dark:border-zinc-800 overflow-hidden">
      {/* bulk bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 px-4 py-2 bg-emerald-500/10 border-b border-emerald-500/30 text-xs">
          <span className="text-emerald-600 dark:text-emerald-400">{selectedIds.size} seleccionados</span>
          <span className="text-zinc-500">mover a:</span>
          <div className="w-44">
            <Select value="" onValueChange={(v) => { if (v) onBulkStatus(v); }}>
              <SelectTrigger className="py-1">
                <SelectValue placeholder="elegir estado…" />
              </SelectTrigger>
              <SelectContent>
                {statuses.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="ml-auto flex items-center gap-2">
            {confirmBulk ? (
              <>
                <span className="text-rose-600 dark:text-rose-400">
                  ¿Eliminar {selectedIds.size} lead(s) y sus archivos?
                </span>
                <button
                  onClick={removeBulk}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-md bg-rose-600 px-2.5 py-1 text-white transition-all duration-200 hover:bg-rose-500 active:scale-[0.97] disabled:opacity-50"
                >
                  {busy ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />} Sí, eliminar
                </button>
                <button
                  onClick={() => setConfirmBulk(false)}
                  className="rounded-md border border-zinc-300 dark:border-zinc-700 px-2.5 py-1 text-zinc-600 dark:text-zinc-300 transition-all duration-200 hover:border-zinc-400"
                >
                  Cancelar
                </button>
              </>
            ) : (
              <button
                onClick={() => setConfirmBulk(true)}
                className="inline-flex items-center gap-1.5 rounded-md border border-rose-300 dark:border-rose-900 px-2.5 py-1 text-rose-600 dark:text-rose-400 transition-all duration-200 hover:bg-rose-500/10 active:scale-[0.97]"
              >
                <Trash2 size={11} /> Eliminar seleccionados
              </button>
            )}
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/60">
              <th className="w-8 px-3 py-2"></th>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  onClick={() => onSort(c.key)}
                  className="px-3 py-2 text-left font-medium text-zinc-500 dark:text-zinc-400 cursor-pointer select-none transition-colors duration-200 hover:text-emerald-600 dark:hover:text-emerald-400"
                >
                  <span className="inline-flex items-center gap-1">{c.label} {sortIcon(c.key)}</span>
                </th>
              ))}
              <th className="px-3 py-2 text-right font-medium text-zinc-500 dark:text-zinc-400">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((lead) => (
              <tr
                key={lead.id}
                onClick={() => onOpen(lead)}
                className="border-b border-zinc-100 dark:border-zinc-800/60 cursor-pointer transition-all duration-200 hover:bg-zinc-50 dark:hover:bg-zinc-900/50 hover:shadow-sm"
              >
                <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(lead.id)}
                    onChange={() => onToggleSelect(lead.id)}
                    className="accent-emerald-500 cursor-pointer transition-transform duration-200 hover:scale-110"
                  />
                </td>
                <td className="px-3 py-2 text-zinc-400 dark:text-zinc-500 tabular-nums">{lead.rank ?? '—'}</td>
                <td className="px-3 py-2 font-medium text-zinc-900 dark:text-zinc-100 max-w-[280px]">
                  <span className="line-clamp-1">{lead.organisation}</span>
                  {lead.source === 'agent' && (
                    <Bot size={11} className="inline ml-1 text-emerald-500" />
                  )}
                </td>
                <td className="px-3 py-2">
                  {lead.priority && <Badge variant={priorityVariant(lead.priority)}>{lead.priority.split(' ')[0]}</Badge>}
                </td>
                <td className="px-3 py-2">
                  <span className="flex items-center gap-2 text-zinc-500">
                    {lead.pdfs.length > 0 && (
                      <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
                        <FileText size={11} />{lead.pdfs.length}
                      </span>
                    )}
                    {lead.generated.length > 0 && (
                      <span className="inline-flex items-center gap-0.5 text-amber-500 dark:text-amber-400">
                        <Sparkles size={11} />{lead.generated.length}
                      </span>
                    )}
                  </span>
                </td>
                <td className="px-3 py-2 text-zinc-600 dark:text-zinc-400 max-w-[140px]"><span className="line-clamp-1">{lead.sector ?? '—'}</span></td>
                <td className="px-3 py-2 text-zinc-600 dark:text-zinc-400">{lead.country ?? '—'}</td>
                <td className="px-3 py-2"><Badge variant="outline">{lead.status}</Badge></td>
                <td className="px-3 py-2 text-zinc-600 dark:text-zinc-400 max-w-[140px]"><span className="line-clamp-1">{lead.contact1_name ?? '—'}</span></td>
                <td className="px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                  <span className="inline-flex items-center gap-1">
                    <button
                      onClick={() => onOpen(lead)}
                      title="Ver detalle"
                      className="p-1.5 rounded-md text-zinc-500 transition-all duration-200 hover:scale-110 hover:text-emerald-500 hover:bg-emerald-500/10 active:scale-95"
                    >
                      <Eye size={13} />
                    </button>
                    {lead.website && (
                      <a
                        href={lead.website.startsWith('http') ? lead.website : `https://${lead.website}`}
                        target="_blank"
                        rel="noreferrer"
                        title="Website"
                        className="p-1.5 rounded-md text-zinc-500 transition-all duration-200 hover:scale-110 hover:text-emerald-500 hover:bg-emerald-500/10 active:scale-95 inline-flex"
                      >
                        <Globe size={13} />
                      </a>
                    )}
                    {confirmRow === lead.id ? (
                      <span className="inline-flex items-center gap-1">
                        <button
                          onClick={() => removeOne(lead.id)}
                          disabled={busy}
                          title="Confirmar borrado"
                          className="rounded-md bg-rose-600 px-2 py-1 text-[10px] text-white transition-all duration-200 hover:bg-rose-500 active:scale-95 disabled:opacity-50"
                        >
                          {busy ? <Loader2 size={11} className="animate-spin" /> : 'Eliminar'}
                        </button>
                        <button
                          onClick={() => setConfirmRow(null)}
                          title="Cancelar"
                          className="rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-[10px] text-zinc-500 transition-all duration-200 hover:border-zinc-400"
                        >
                          No
                        </button>
                      </span>
                    ) : (
                      <button
                        onClick={() => setConfirmRow(lead.id)}
                        title="Eliminar lead"
                        className="p-1.5 rounded-md text-zinc-500 transition-all duration-200 hover:scale-110 hover:text-rose-500 hover:bg-rose-500/10 active:scale-95"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="px-4 py-2 text-[10px] text-zinc-400 dark:text-zinc-600 border-t border-zinc-200 dark:border-zinc-800">
        ESC cierra detalle · ↑↓ navega entre leads · click en cabecera ordena
      </div>
    </div>
  );
}
