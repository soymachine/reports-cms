# ThinkThings Reports — Lead Pipeline

Dashboard local para captación de clientes de **Reports** (thinkthings.es).

## Componentes

| Componente | Path | Propósito |
|---|---|---|
| Base de datos | `leads.db` | SQLite, 250 leads importados del Excel |
| CLI para agentes | `lead_mgr.py` | add / list / get / update / exists / stats / add-pdf / add-generated / timeline |
| Importador | `scripts/import_excel.py` | Excel → SQLite (idempotente) |
| Buscador de PDFs | `scripts/pdf_finder.py <id> --max 3` | DuckDuckGo Lite → descarga PDFs de reports → `pdfs/{id}/` |
| Render de páginas | `scripts/render_pages.py <id> --pdf <path>` | pdftoppm → thumbnails + full pages en `generated/{id}/pages/` |
| Generador de rediseños | `scripts/generate_redesign.py <id> --pages 2,5 --pdf-slug X` | Llamada directa al MCP Magnific → `generated/{id}/redesigns/` (`--engine agent` vuelve al agente Hermes) |
| Cliente Magnific | `scripts/magnific_client.py` | Cliente MCP propio: genera, sube referencias, consulta saldo y coste. Sin él ejecutar imprime el saldo |
| Catálogo de modelos | `scripts/refresh_magnific_models.py` | Regenera `magnific_models.json` (modelos + créditos por imagen vía `simulate_cost`) |
| Miniaturas | `scripts/thumbs.py --backfill` | WebP de 720 px junto a cada rediseño, para que la galería no cargue PNGs de 6 MB |
| Limpieza de disco | `scripts/cleanup.py [--apply]` | Informe de lo que sobra en `generated/`; solo borra con `--apply` |
| PDF comparativo | `scripts/build_comparison_pdf.py <id>` | Deck antes/después con la identidad del estudio; `--select` elige imágenes concretas |
| Dashboard | `dashboard/` | Astro.js + React + Tailwind + GSAP (puerto 4321) |
| Config | `settings.json` | statuses, presets de estilo, cron job id |

## Uso

```bash
# Dashboard
cd dashboard && npm run dev        # http://localhost:4321

# CLI (agentes)
.venv/bin/python lead_mgr.py stats
.venv/bin/python lead_mgr.py list --status "Not contacted" --limit 10
.venv/bin/python lead_mgr.py add --organisation "..." --source agent
```

## Créditos y modelos

El modelo de Magnific se elige en el dashboard o en `settings.json` → `redesign.model`
(`resolution`, `quality`). El coste por imagen sale de `magnific_models.json`, medido con
`simulate_cost`, y es lo que usa el guardarraíl de presupuesto (`settings.json` → `budget`).
El saldo real de la cuenta aparece en la barra lateral.

Órdenes de magnitud por imagen: Nano Banana 2 a 2k = 75 cr., Nano Banana 2 Lite = 60 cr.,
Seedream 5 Pro 2k = 100 cr., GPT 2 2k medium = 260 cr. (y 700 cr. en `high`).

## Coherencia entre páginas

Las páginas de un mismo informe se generan como una serie, no sueltas: la primera imagen
de la tanda se pasa a las siguientes como **referencia de estilo** (`references` con
`type: "style"`), y el prompt añade una cláusula de serie (misma paleta, tipografía,
retícula y tratamiento de gráficos). Si el informe ya tiene rediseños de ese estilo, la
nueva tanda se ancla en el ganador — o en la primera página — para que todo el deck case.

Se controla con la casilla "mismo diseño en todas" del panel de generación, o con
`--no-consistency` / `--style-anchor <ruta>` en el script. La referencia de estilo no
cuesta créditos extra (verificado con `simulate_cost`).

## Comparador antes / después

Es donde se decide qué estilo entra en el email, así que tanto el panel del lead
como el comparador a pantalla completa están hechos para mirar mucho y decidir
rápido.

- **Tamaño de los pares** en el panel del lead: 100 %, 75 %, 50 % o «una fila»,
  que encoge las parejas hasta que todas las páginas del report caben de un vistazo.
- **Rejilla** en el comparador (`G`): una tarjeta por estilo, cada una con su propio
  antes y después. La escala se ajusta a mano, al 50 % o con «una fila», que calcula
  el tamaño máximo con el que entran todas sin bajar la vista.
- **Versiones** (`V`): las tomas de un mismo estilo en paralelo, para elegir cuál de
  los intentos quedó mejor.
- **Lupa sincronizada**: la rueda amplía y el arrastre mueve las dos imágenes a la
  vez, que es la única forma de comparar si una cifra se lee.
- **Deslizador** (`S`): el lado derecho es siempre el par seleccionado y el izquierdo
  se elige — la página del PDF, otro estilo u otra versión — así que se puede barrer
  v3 contra v1 y no solo contra el original. Con parpadeo A/B: `ESPACIO` alterna los
  dos lados en el mismo rectángulo; `[` y `]` mueven el corte.
- **Fondo** negro, gris o claro (`F`): una página blanca no se lee igual sobre negro.
- Ficha técnica (`I`) con modelo, resolución, prompt y control de datos; descarga del
  PNG y copia al portapapeles; `?` lista todos los atajos.

Las imágenes entran por su miniatura y se sustituyen por el PNG completo al llegar,
y los estilos y páginas vecinos se precargan, para que moverse no cueste esperas.
Las preferencias de vista (modo, escala, fondo) se recuerdan entre sesiones.

## Trabajos en cola

Las generaciones ya no se lanzan desde la petición HTTP: entran en una cola con tope de
concurrencia (`settings.json` → `jobs.max_concurrent`, por defecto 2). Se pueden cancelar
desde el panel y, si el dashboard se reinicia a media generación, los trabajos huérfanos se
cierran al arrancar en vez de quedarse girando para siempre.

## Acceso

Sin configurar nada, el dashboard es abierto (uso local). Si lo expones, define
`DASHBOARD_TOKEN` (o `settings.json` → `security.token`) y toda petición pedirá ese token
por HTTP Basic, cabecera `x-dashboard-token` o `?token=…` una vez.

## Tests

```bash
.venv/bin/python -m pytest tests -q        # lógica de pipeline, QC y créditos
npm --prefix dashboard run build && bash tests/smoke_api.sh   # endpoints vivos
```

## Pipeline de un lead

1. **Not contacted** → botón "Buscar PDFs" → descarga reports reales de la org
2. **PDF Found** → "Ver páginas" → seleccionar 2-3 páginas → "Generar rediseños" (Magnific MCP)
3. **Demo Ready** → "Generar email" → HTML antes/después listo para cold-email
4. **Contacted / Replied / Won / Lost** — seguimiento manual

## Agente nocturno (cron)

`ThinkThings Lead Hunter` (`d28024ce08c5`) — cada día 02:00 busca hasta 5 leads
nuevos con curl + DuckDuckGo Lite, dedupe por nombre, inserta con `source=agent`.

```bash
hermes cron run d28024ce08c5     # ejecución manual
hermes cron pause d28024ce08c5   # pausar
```

## Requisito: Magnific OAuth

La primera generación de rediseños requiere autorizar el MCP de Magnific una vez:

```bash
hermes mcp login magnific
```

## Requisitos del sistema

- Python: `.venv` (3.12, openpyxl) — recrear con `/opt/homebrew/bin/python3.12 -m venv .venv`
- poppler (`pdftoppm`, `pdfinfo`) — `brew install poppler`
- Node 22+ para el dashboard
