/**
 * Pases de generación: agrupar los rediseños por la tirada que los produjo.
 *
 * El número de versión de cada entrada se calcula por página
 * (generate_redesign.py → next_version), así que regenerar una sola página deja
 * esa página en v2 y las demás en v1: «la v2 del conjunto» no existe. Lo que sí
 * existe es el pase — lo que produjo un clic en «Generar» —, y está en los datos
 * desde siempre: cada entrada guarda su `job_id` y su `created_at`.
 *
 * Estas funciones agrupan por pase y componen, para cualquiera de ellos, cómo se
 * veía el informe entero en ese momento: las páginas de ese pase, y para el
 * resto la que estuviera vigente entonces.
 */
import type { GeneratedItem } from './types';

export interface Run {
  /** identidad estable del pase, para usarla como clave de React y de estado */
  key: string;
  /** el más reciente primero: 1 es el pase más nuevo */
  ordinal: number;
  /** cuándo se lanzó (el created_at más antiguo del pase) */
  at: string;
  /** páginas que se generaron en este pase, ordenadas */
  pages: number[];
  items: GeneratedItem[];
}

export interface ComposedPage {
  item: GeneratedItem;
  /** false cuando la página no se generó en este pase y se hereda de otro anterior */
  fromRun: boolean;
}

/** Clave del pase: el job cuando lo hay; si no, el minuto de creación.
 *
 * Las entradas de un mismo pase se escriben con microsegundos de diferencia, de
 * ahí el redondeo al minuto. Los rediseños anteriores a la cola de trabajos no
 * tienen job_id, y así siguen agrupándose bien. */
export function runKey(item: GeneratedItem): string {
  if (item.job_id !== null && item.job_id !== undefined) return `job:${item.job_id}`;
  return `at:${(item.created_at ?? '').slice(0, 16)}`;
}

const time = (item: GeneratedItem): string => item.created_at ?? '';

/**
 * Los pases de un estilo concreto, del más reciente al más antiguo.
 * Un estilo con una sola generación devuelve un único pase.
 */
export function runsOf(items: GeneratedItem[], pdf: string, style: string): Run[] {
  const mine = items.filter((g) => g.pdf === pdf && g.style === style && g.generated_img);

  const groups = new Map<string, GeneratedItem[]>();
  for (const item of mine) {
    const key = runKey(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  return [...groups.entries()]
    .map(([key, group]) => ({
      key,
      ordinal: 0,
      at: group.map(time).sort()[0] ?? '',
      pages: [...new Set(group.map((g) => g.page))].sort((a, b) => a - b),
      items: group,
    }))
    .sort((a, b) => b.at.localeCompare(a.at))
    .map((run, i) => ({ ...run, ordinal: i + 1 }));
}

/**
 * Cómo se veía el informe en un pase: sus páginas, más las que ya existían
 * entonces y no se volvieron a generar.
 *
 * Una página que se generó por primera vez DESPUÉS de este pase no aparece: en
 * ese momento no existía, y enseñarla sería inventar un conjunto que nunca hubo.
 */
export function composeRun(items: GeneratedItem[], pdf: string, style: string,
                           key: string): ComposedPage[] {
  const mine = items.filter((g) => g.pdf === pdf && g.style === style && g.generated_img);
  const run = mine.filter((g) => runKey(g) === key);
  if (!run.length) return [];

  // el corte es el instante más TARDÍO del pase: una página del propio pase
  // nunca puede quedar fuera de su propia ventana
  const cutoff = run.map(time).sort().reverse()[0] ?? '';
  const chosen = new Map<number, ComposedPage>();

  for (const item of run) {
    const previous = chosen.get(item.page);
    // dos imágenes de la misma página en un pase no debería pasar; si pasa,
    // manda la última escrita
    if (!previous || time(previous.item) <= time(item)) {
      chosen.set(item.page, { item, fromRun: true });
    }
  }

  for (const item of mine) {
    if (chosen.get(item.page)?.fromRun) continue;
    if (time(item) > cutoff) continue;              // todavía no existía
    const previous = chosen.get(item.page);
    if (!previous || time(previous.item) < time(item)) {
      chosen.set(item.page, { item, fromRun: false });
    }
  }

  return [...chosen.values()].sort((a, b) => a.item.page - b.item.page);
}

/** Lo vigente: la cabeza de cada página, que es lo que se ve por defecto. */
export function composeCurrent(items: GeneratedItem[], pdf: string,
                               style: string): ComposedPage[] {
  return items
    .filter((g) => g.pdf === pdf && g.style === style && g.generated_img && !g.superseded)
    .sort((a, b) => a.page - b.page)
    .map((item) => ({ item, fromRun: true }));
}

/**
 * Qué imagen enseñar al pasar a otra página desde la comparación grande.
 *
 * Manda el conjunto que se está mirando —el pase abierto—, porque es el que se
 * está comparando. Si esa página no está en él, se busca en el informe entero
 * respetando el estilo actual, y siempre la vigente: `all.find(...)` a secas
 * devuelve la primera del array, que es la versión MÁS ANTIGUA.
 */
export function pickForPage(scope: GeneratedItem[], all: GeneratedItem[],
                            pdf: string, page: number,
                            style: string): GeneratedItem | null {
  const inScope = scope.find((g) => g.page === page);
  if (inScope) return inScope;

  const here = all.filter((g) => g.pdf === pdf && g.page === page && g.generated_img);
  const head = (list: GeneratedItem[]) =>
    list.find((g) => !g.superseded) ?? list[list.length - 1] ?? null;

  return head(here.filter((g) => g.style === style)) ?? head(here);
}


/** Etiqueta del chip: «Pase 2 · 20 ago 12:40 · 3 págs». */
export function runLabel(run: Run): string {
  const when = run.at
    ? new Date(run.at).toLocaleString('es-ES',
        { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : 'sin fecha';
  const pages = run.pages.length === 1 ? '1 pág.' : `${run.pages.length} págs.`;
  return `${when} · ${pages}`;
}
