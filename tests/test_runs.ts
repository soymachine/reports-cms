/**
 * Pruebas de la composición de pases (dashboard/src/lib/runs.ts).
 *
 * Lo que se comprueba aquí es lo que a ojo no se ve: que al mirar un pase
 * antiguo cada página muestre la imagen que estaba vigente ENTONCES, y no la de
 * hoy. Un fallo aquí no rompe nada visiblemente — simplemente enseña un conjunto
 * que nunca existió, y sobre eso se decide qué se le manda a un cliente.
 *
 *   node --experimental-strip-types --test tests/test_runs.ts
 *   npm --prefix dashboard run test:unit
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  composeCurrent, composeRun, itemKey, overwritten, pickForPage, runIsLost,
  runKey, runLabel, runsOf,
} from '../dashboard/src/lib/runs.ts';
import type { GeneratedItem } from '../dashboard/src/lib/types.ts';

const PDF = 'informe-2026';

/** Una entrada de `leads.generated` con lo justo para estas pruebas. */
function entry(page: number, at: string, job: number | null,
               extra: Partial<GeneratedItem> = {}): GeneratedItem {
  return {
    page,
    pdf: PDF,
    style: 'magazine',
    styleName: 'Revista / Feature',
    original_img: `pages/full-${page}.png`,
    generated_img: `redesigns/page-0${page}-magazine-redesign-${at}.png`,
    created_at: at,
    job_id: job,
    ...extra,
  } as GeneratedItem;
}

// El caso del informe de EUREC: cuatro páginas, y luego el mismo estilo entero
// otra vez. Las entradas del primer pase quedan marcadas como superseded.
const primerPase = [
  entry(1, '2026-08-18T10:00:01', 10, { superseded: true, version: 1 }),
  entry(2, '2026-08-18T10:00:02', 10, { superseded: true, version: 1 }),
  entry(3, '2026-08-18T10:00:03', 10, { superseded: true, version: 1 }),
  entry(4, '2026-08-18T10:00:04', 10, { superseded: true, version: 1 }),
];
const segundoPase = [
  entry(1, '2026-08-20T12:40:01', 20, { version: 2 }),
  entry(2, '2026-08-20T12:40:02', 20, { version: 2 }),
  entry(3, '2026-08-20T12:40:03', 20, { version: 2 }),
  entry(4, '2026-08-20T12:40:04', 20, { version: 2 }),
];
const dosPases = [...primerPase, ...segundoPase];


test('el pase se identifica por su job cuando lo hay', () => {
  assert.equal(runKey(entry(1, '2026-08-20T12:40:01', 20)), 'job:20');
});

test('sin job, las entradas del mismo minuto son el mismo pase', () => {
  // los rediseños anteriores a la cola de trabajos no tienen job_id
  assert.equal(runKey(entry(1, '2026-08-18T10:00:01', null)),
               runKey(entry(2, '2026-08-18T10:00:59', null)));
  assert.notEqual(runKey(entry(1, '2026-08-18T10:00:01', null)),
                  runKey(entry(2, '2026-08-18T10:01:01', null)));
});

test('dos generaciones del mismo estilo son dos pases, el nuevo primero', () => {
  const runs = runsOf(dosPases, PDF, 'magazine');
  assert.equal(runs.length, 2);
  assert.equal(runs[0].ordinal, 1);
  assert.equal(runs[0].key, 'job:20');
  assert.deepEqual(runs[0].pages, [1, 2, 3, 4]);
  assert.equal(runs[1].key, 'job:10');
});

test('un estilo generado una sola vez tiene un pase, no cero', () => {
  assert.equal(runsOf(primerPase, PDF, 'magazine').length, 1);
});

test('los pases de otro estilo o de otro informe no se cuelan', () => {
  const otros = [
    ...dosPases,
    entry(1, '2026-08-20T13:00:00', 21, { style: 'swiss', styleName: 'Swiss' }),
    entry(1, '2026-08-20T13:00:00', 22, { pdf: 'otro-informe' }),
  ];
  const runs = runsOf(otros, PDF, 'magazine');
  assert.equal(runs.length, 2);
});

test('mirar un pase completo enseña sus cuatro páginas', () => {
  const shown = composeRun(dosPases, PDF, 'magazine', 'job:10');
  assert.deepEqual(shown.map((c) => c.item.page), [1, 2, 3, 4]);
  assert.ok(shown.every((c) => c.fromRun));
  // las del pase viejo, no las de hoy
  assert.ok(shown.every((c) => c.item.created_at!.startsWith('2026-08-18')));
});

test('lo vigente es la cabeza de cada página', () => {
  const shown = composeCurrent(dosPases, PDF, 'magazine');
  assert.deepEqual(shown.map((c) => c.item.page), [1, 2, 3, 4]);
  assert.ok(shown.every((c) => c.item.created_at!.startsWith('2026-08-20')));
});


// --- el caso que el número de versión no sabe contar: regenerar una página ---

const soloPagina3 = entry(3, '2026-08-21T09:00:00', 30, { version: 3 });
const conVariante = [
  ...primerPase,
  ...segundoPase.map((g) => (g.page === 3 ? { ...g, superseded: true } : g)),
  soloPagina3,
];

test('el pase de una sola página enseña el conjunto entero', () => {
  const shown = composeRun(conVariante, PDF, 'magazine', 'job:30');
  assert.deepEqual(shown.map((c) => c.item.page), [1, 2, 3, 4],
    'la gracia es poder juzgar la variante dentro del conjunto, no aislada');
});

test('en ese pase, solo la página regenerada es suya', () => {
  const shown = composeRun(conVariante, PDF, 'magazine', 'job:30');
  const propias = shown.filter((c) => c.fromRun).map((c) => c.item.page);
  assert.deepEqual(propias, [3]);
});

test('las páginas heredadas son las vigentes en ese momento, no las de v1', () => {
  const shown = composeRun(conVariante, PDF, 'magazine', 'job:30');
  const pagina1 = shown.find((c) => c.item.page === 1)!;
  assert.equal(pagina1.fromRun, false);
  assert.ok(pagina1.item.created_at!.startsWith('2026-08-20'),
    'hereda del segundo pase, que era lo vigente, no del primero');
});

test('mirando el primer pase, la variante posterior no se cuela', () => {
  const shown = composeRun(conVariante, PDF, 'magazine', 'job:10');
  const pagina3 = shown.find((c) => c.item.page === 3)!;
  assert.ok(pagina3.item.created_at!.startsWith('2026-08-18'));
});

test('una página que aún no existía no aparece en un pase anterior', () => {
  // la 5 se añadió al deck más tarde: en agosto 18 no había tal página
  const conPagina5 = [...dosPases, entry(5, '2026-08-22T10:00:00', 40)];
  const shown = composeRun(conPagina5, PDF, 'magazine', 'job:10');
  assert.deepEqual(shown.map((c) => c.item.page), [1, 2, 3, 4],
    'enseñar la 5 sería componer un conjunto que nunca existió');
});

test('un pase que no existe no compone nada', () => {
  assert.deepEqual(composeRun(dosPases, PDF, 'magazine', 'job:999'), []);
});

test('la etiqueta del chip dice cuándo y cuántas páginas', () => {
  const [ultimo] = runsOf(conVariante, PDF, 'magazine');
  const label = runLabel(ultimo);
  assert.match(label, /1 pág\./);
  assert.doesNotMatch(label, /págs\./);
  assert.match(runLabel(runsOf(dosPases, PDF, 'magazine')[0]), /4 págs\./);
});


// --- pasar de página dentro de la comparación grande ---

test('pasar de página se queda en el pase que se está mirando', () => {
  const pase = composeRun(dosPases, PDF, 'magazine', 'job:10').map((c) => c.item);
  const target = pickForPage(pase, dosPases, PDF, 2, 'magazine')!;
  assert.ok(target.created_at!.startsWith('2026-08-18'),
    'saltar a la versión vigente rompería la comparación que se está haciendo');
});

test('sin pase abierto, se pasa a la versión vigente', () => {
  const target = pickForPage([], dosPases, PDF, 2, 'magazine')!;
  assert.ok(target.created_at!.startsWith('2026-08-20'));
});

test('nunca se cae en la versión más antigua por accidente', () => {
  // `all.find(...)` devolvía la primera del array: la v1, ni la del pase ni la
  // vigente. Con tres versiones el fallo es inconfundible.
  const tres = [
    entry(9, '2026-08-01T10:00:00', 1, { superseded: true }),
    entry(9, '2026-08-02T10:00:00', 2, { superseded: true }),
    entry(9, '2026-08-03T10:00:00', 3),
  ];
  const target = pickForPage([], tres, PDF, 9, 'magazine')!;
  assert.equal(target.created_at, '2026-08-03T10:00:00');
});

test('si la página no tiene ese estilo, sirve cualquiera vigente', () => {
  const otroEstilo = [
    ...segundoPase,
    entry(7, '2026-08-20T13:00:00', 21, { style: 'swiss', styleName: 'Swiss' }),
  ];
  const target = pickForPage([], otroEstilo, PDF, 7, 'magazine')!;
  assert.equal(target.style, 'swiss');
});

test('una página sin ninguna imagen no devuelve nada', () => {
  assert.equal(pickForPage([], dosPases, PDF, 99, 'magazine'), null);
});


// --- imágenes sobrescritas antes de que existiera el archivado ---

// Antes de archive_previous_versions, relanzar un estilo pisaba el fichero: las
// dos entradas apuntan al mismo sitio y la vieja ya no se puede enseñar.
const mismoFichero = [
  { ...entry(1, '2026-08-18T10:00:00', null), generated_img: 'r/page-01.png', superseded: true },
  { ...entry(2, '2026-08-18T10:00:01', null), generated_img: 'r/page-02.png', superseded: true },
  { ...entry(1, '2026-08-19T10:00:00', null), generated_img: 'r/page-01.png' },
  { ...entry(2, '2026-08-19T10:00:01', null), generated_img: 'r/page-02.png' },
];

test('una entrada pisada por otra posterior se detecta como perdida', () => {
  const lost = overwritten(mismoFichero, PDF, 'magazine');
  assert.equal(lost.size, 2);
  assert.ok(lost.has(itemKey(mismoFichero[0])), 'la del 18 es la que se perdió');
  assert.ok(!lost.has(itemKey(mismoFichero[2])), 'la del 19 es la que está en disco');
});

test('un pase entero sin píxeles propios se marca como perdido', () => {
  const lost = overwritten(mismoFichero, PDF, 'magazine');
  const runs = runsOf(mismoFichero, PDF, 'magazine');
  assert.equal(runs.length, 2);
  const [nuevo, viejo] = runs;                 // el más reciente primero
  assert.equal(runIsLost(viejo, lost), true,
    'sin esto, conmutar a ese pase no cambia nada y parece que la función está rota');
  assert.equal(runIsLost(nuevo, lost), false);
});

test('con el archivado funcionando no se pierde nada', () => {
  const lost = overwritten(dosPases, PDF, 'magazine');
  assert.equal(lost.size, 0);
  for (const run of runsOf(dosPases, PDF, 'magazine')) {
    assert.equal(runIsLost(run, lost), false);
  }
});

test('un pase con una sola página perdida no cuenta como perdido entero', () => {
  const mixto = [
    ...mismoFichero.slice(0, 2),
    { ...entry(3, '2026-08-18T10:00:02', null), generated_img: 'r/page-03-v1.png',
      superseded: true },
    ...mismoFichero.slice(2),
  ];
  const lost = overwritten(mixto, PDF, 'magazine');
  const viejo = runsOf(mixto, PDF, 'magazine')[1];
  assert.equal(runIsLost(viejo, lost), false, 'todavía queda la página 3 que enseñar');
});
