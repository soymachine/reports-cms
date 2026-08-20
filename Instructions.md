# ThinkThings Reports — Lead Pipeline

Documento de continuación para otro agente/LLM (Claude Code u otro).

## 1. Qué es este proyecto

Pipeline local para captar leads de **Reports** para [ThinkThings.es](https://thinkthings.es), un estudio de diseño gráfico de Barcelona/Zaragoza.

Flujo de trabajo:

1. Importar/exportar base de prospectos (SQLite).
2. Buscar reports públicos en PDF de cada organización.
3. Renderizar las páginas del PDF.
4. Seleccionar páginas y generar rediseños estéticos vía **Magnific MCP**.
5. Generar un borrador de cold-email con comparativa antes/después.
6. Seguimiento en un dashboard tipo Kanban.

## 2. Estado actual (snapshot)

- **260 leads** en `leads.db` (250 importados de Excel + 10 añadidos por agente nocturno).
- **8 leads** con PDFs descargados.
- **2 leads** con rediseños generados.
- Lead de ejemplo con rediseños: `id=1` (Hydrogen Europe) y `id=13` (EUREC).
- Cron nocturno activo: `ThinkThings Lead Hunter`, job id `d28024ce08c5`, 02:00 diario.
- Dashboard corriendo en `http://localhost:4321`.

## 3. Arquitectura

```
/Users/danimoyalya2/Documents/Dani/Personal/ThinkThings/
├── leads.db                  # SQLite (fuente única de verdad)
├── lead_mgr.py               # CLI JSON para agentes
├── settings.json             # Config de estados, estilos, cron
├── scripts/
│   ├── import_excel.py       # Excel → SQLite
│   ├── pdf_finder.py         # DuckDuckGo Lite → descarga PDFs
│   ├── render_pages.py       # pdftoppm → thumbnails/full
│   └── generate_redesign.py  # Llamada directa al MCP Magnific
├── pdfs/{lead_id}/           # PDFs descargados
├── generated/{lead_id}/      # Páginas renderizadas + rediseños
└── dashboard/                # Astro.js + React + Tailwind
    ├── src/components/       # UI React
    ├── src/pages/api/        # Endpoints del servidor Astro
    └── src/styles/global.css # Tokens de color
```

### Tecnologías

- **Backend scripts**: Python 3.12, venv en `.venv/`, `openpyxl`, `sqlite3`.
- **Dashboard**: Astro 4, React 18, Tailwind 3, `better-sqlite3`, GSAP, `lucide-react`.
- **Render PDF**: `pdftoppm` (poppler).
- **Generación imágenes**: MCP `magnific` por llamada directa (`scripts/magnific_client.py`).
- **Buscador**: DuckDuckGo Lite con `curl` (el agente nocturno no usa `web_search` de Hermes porque no está configurado).

## 4. Cómo arrancar

### Requisitos del sistema

- Python 3.12 y `openpyxl` en `.venv`:
  ```bash
  /opt/homebrew/bin/python3.12 -m venv .venv
  .venv/bin/pip install openpyxl
  ```
- Node 22+.
- `pdftoppm` / `pdfinfo`:
  ```bash
  brew install poppler
  ```
- Sesión de Magnific autorizada una vez por máquina (no requiere Hermes):
  ```bash
  .venv/bin/python scripts/magnific_login.py
  ```

### Comandos habituales

```bash
# Dashboard
npm run dev        # http://localhost:4321
npm run build      # verificar antes de entregar

# CLI
.venv/bin/python lead_mgr.py stats
.venv/bin/python lead_mgr.py list --status "Not contacted" --limit 10
.venv/bin/python lead_mgr.py get 13
.venv/bin/python lead_mgr.py update 13 --status "Demo Ready" --next-action "Llamar el lunes"

# Scripts
.venv/bin/python scripts/pdf_finder.py 13 --max 3
.venv/bin/python scripts/render_pages.py 13 --pdf "pdfs/13/EUREC-news-NECP-assessment-from-EC-19-June-final-online-version.pdf"
.venv/bin/python scripts/generate_redesign.py 13 --pages 1,9 --pdf-slug EUREC-news-NECP-assessment-from-EC-19-June-final-online-version
```

### Cron

```bash
hermes cron run d28024ce08c5     # manual
hermes cron pause d28024ce08c5   # pausar
```

## 5. Modelo de datos

Tabla principal: `leads`.

Campos clave:

| Campo | Tipo | Notas |
|-------|------|-------|
| `id` | INTEGER PK | autoincremental |
| `rank`, `priority_score` | INTEGER | orden/puntuación del Excel |
| `priority` | TEXT | `A - Hot`, `B - Strong`, `C - Medium`, `D - Long list` |
| `organisation` | TEXT | obligatorio, único por nombre normalizado |
| `country`, `city`, `sector`, `type`, `relationship`, `rationale`, `services` | TEXT | datos del prospecto |
| `website`, `linkedin` | TEXT | |
| `contact1_*`, `contact2_*`, `general_email`, `email_confidence` | TEXT | contactos |
| `status` | TEXT | `Not contacted`, `PDF Found`, `Demo Ready`, `Contacted`, `Replied`, `Won`, `Lost`, `Discarded` |
| `next_action`, `notes`, `last_contacted`, `email_draft` | TEXT | |
| `source` | TEXT | `excel` o `agent` |
| `pdfs` | JSON | `[{file, slug, url, title, downloaded_at}]` |
| `generated` | JSON | `[{page, pdf, style, styleName, original_img, generated_img, status, created_at}]` |
| `timeline` | JSON | `[{type, text, date}]` |

Tabla auxiliar: `cron_history` (job, ran_at, summary).

### Formas de nombrar archivos

- PDF descargado: `pdfs/{lead_id}/{slug}.pdf`.
- Páginas renderizadas: `generated/{lead_id}/pages/{slug}/full-{N}.png` y `thumb-{N}.png`. **No asumir padding fijo**: `pdftoppm` genera `full-1.png`, `full-01.png` o `full-001.png` según el total de páginas. Usar `glob` + regex para extraer el número.
- Rediseños: `generated/{lead_id}/redesigns/page-{N}-{style}-redesign.{ext}`.

## 6. Dashboard

### Estructura de componentes

| Archivo | Rol |
|---------|-----|
| `Dashboard.tsx` | Layout general, estado, fetch de `/api/leads`, `/api/stats`, tema |
| `Sidebar.tsx` | Filtros, stats, logo temático, botón "Hunt now", indicador Magnific |
| `Kanban.tsx` | Vista Kanban por status con drag & drop |
| `LeadTable.tsx` | Vista tabla ordenable con selección múltiple |
| `LeadDetail.tsx` | Modal a pantalla completa con datos, PDFs, render, rediseños, email |
| `ui/badge.tsx` | Badge de prioridad/estado |

### Convenciones visuales

- Fuente principal: **IBM Plex Mono** (weight 400), definida en Tailwind y en `global.css`.
- Modo oscuro por defecto; toggle guarda `tt-theme` en `localStorage`.
- Tailwind dark mode: `'class'`.
- Paleta en `dashboard/src/styles/global.css`:
  - `--background`, `--foreground`, `--card`, `--muted`, `--border`, `--accent`.
  - Modo claro: fondo zinc-50, texto zinc-900.
  - Modo oscuro: fondo `#09090b`, texto `#f4f4f5`.
- Utilidades custom: `.text-muted`, `.text-subtle`, `.border-subtle`, `.bg-surface`.
- Tarjetas con `rounded-card` (10 px), bordes sutiles.
- Todos los elementos interactivos deben tener `transition-all duration-200`, hover con `scale-[1.02]` aprox., active `scale-[0.97]`.
- Indicador Magnific arriba a la izquierda del sidebar: verde si conectado, rojo si auth, ámbar si error.
- Logos del sidebar:
  - Claro: `Logo_TT2024_negro_horitzontal.png`.
  - Oscuro: `Logo_TT2024_color_horitzontal.png`.

### Endpoints del dashboard

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/stats` | Totales, agrupaciones, settings, último cron |
| GET | `/api/leads?q=&priority=&sector=&country=&source=&sort=&dir=` | Lista filtrada y ordenada |
| PATCH | `/api/leads` | Actualizar lead (`id` + campos patchables) |
| POST | `/api/find-pdfs` | Lanza `pdf_finder.py` para un lead |
| GET | `/api/find-pdfs-status` | Polling del estado de búsqueda |
| POST | `/api/render-pages` | Renderiza un PDF (`lead_id`, `pdf`) |
| POST | `/api/generate` | Lanza `generate_redesign.py` (`lead_id`, `pages`, `pdf_slug`, `style_id`, `style_name`, `style_prompt`) |
| GET | `/api/generate-status` | Polling del estado de generación |
| POST | `/api/email-draft` | Genera HTML de cold-email con pares antes/después |
| POST | `/api/hunt-now` | Lanza el cron job manualmente |
| GET | `/api/magnific-status` | Estado del MCP Magnific vía `scripts/magnific_status.py` (cache 60 s) |
| GET | `/api/file?path=...` | Sirve archivos de `pdfs/` y `generated/` con protección anti-traversal |
| GET | `/api/export?q=...` | CSV de leads filtrados |

### Flujo de UI clave

1. En Kanban/Tabla, click en lead abre `LeadDetail`.
2. Dentro del modal:
   - Panel superior con datos de la empresa en grid responsive.
   - Fila `Estado` + `Próxima acción`.
   - Sección **Reports**: lista de PDFs descargados.
   - Al pulsar "Ver páginas" de un PDF, se expande un acordeón inline con:
     - Visor de página actual (izquierda) + thumbnails (derecha).
     - Selector de estilo + botón "Generar rediseños" (máx. 4 páginas).
   - Tras generar, aparece sección **Antes / Después** plegable dentro de cada PDF, con selector de estilo y 2 columnas de imágenes reducidas.
   - Click en cualquier imagen abre comparativa a pantalla completa (z-70, ESC cierra).
   - Notas y timeline al final a ancho completo.

## 7. Scripts del backend

### `lead_mgr.py`

CLI JSON para agentes. Subcomandos: `add`, `list`, `get`, `update`, `exists`, `stats`, `add-pdf`, `add-generated`, `timeline`.

### `scripts/import_excel.py`

Importa `documentacion/thinkthings_eu_associations_prospect_database.xlsx` → `leads.db`. Es idempotente por nombre normalizado.

### `scripts/pdf_finder.py`

Búsqueda en DuckDuckGo Lite (`"{org}" report filetype:pdf`), descarga hasta N PDFs a `pdfs/{lead_id}/`, registra en `leads.pdfs` y añade timeline.

### `scripts/render_pages.py`

Usa `pdftoppm -png -r {dpi}` para generar `full-N.png` (previsualización/original) y `thumb-N.png`. Devuelve JSON con rutas relativas.

### `scripts/generate_redesign.py`

Llama al MCP Magnific directamente (`scripts/magnific_client.py`): una llamada por
página, una imagen por llamada, y el coste en créditos sale de la respuesta de la
API. Guarda en `generated/{lead_id}/redesigns/page-{NN}-{style}-redesign.png`.

Registra el resultado en `leads.generated`. Lee `settings.json` para `max_pages`.

## 8. Configuración (`settings.json`)

```json
{
  "project": "ThinkThings Reports Leads",
  "cron": { "lead_hunter_job_id": "d28024ce08c5", "schedule": "0 2 * * *" },
  "pdf_finder": { "max_pdfs_per_search": 3 },
  "redesign": {
    "max_pages": 4,
    "style_presets": [
      { "id": "editorial", "name": "Editorial Premium", "prompt": "..." },
      { "id": "swiss", "name": "Swiss / Internacional", "prompt": "..." },
      { "id": "dark-data", "name": "Dark Data Viz", "prompt": "..." },
      { "id": "brutalist", "name": "Brutalist", "prompt": "..." }
    ]
  },
  "statuses": ["Not contacted", "PDF Found", "Demo Ready", "Contacted", "Replied", "Won", "Lost", "Discarded"],
  "priorities": ["A - Hot", "B - Strong", "C - Medium", "D - Long list"]
}
```

## 9. Reglas de trabajo para continuar

1. **Verifica siempre el build** después de cambiar el dashboard:
   ```bash
   cd dashboard && npm run build
   ```
2. **Prefiere `patch` o `write_file`** sobre `sed`/`echo`.
3. **Usa `.venv/bin/python`** para scripts, no el Python global.
4. **No asumas padding fijo** en nombres de página renderizada (`full-*.png`).
5. **Respetar los tokens de color** en `global.css`; evita `text-zinc-500 dark:text-zinc-400` directo; usa `.text-muted` / `.border-subtle`.
6. **Fuente IBM Plex Mono weight 400**; el usuario no quiere negritas.
7. **Mantén animaciones ligeras**: `transition-all duration-200`, micro-escala en hover/active.
8. **No subas secretos**: la sesión de Magnific vive en `~/.thinkthings/magnific/`, no en el repo.
9. **Prueba con leads reales** (por ejemplo `id=1` o `id=13`) antes de decir que algo funciona.

## 10. Problemas conocidos / pendientes

- La pulida visual con skill `impeccable` está en curso: contraste, bordes, estados vacíos, jerarquía.
- Algunos títulos de PDF se guardan con entidades HTML en la BD; el frontend las decodifica con `decodeHtml()`, pero idealmente se normalizarían al importar/descargar.
- El agente nocturno usa DuckDuckGo Lite con `curl`; es frágil ante cambios de HTML.
- La comparativa a pantalla completa ya está implementada, pero conviene revisar UX en móvil.
- Posibles mejoras: búsqueda semántica de leads, envío real de email, integración con CRM/Airtable, autenticación en dashboard.

## 11. Recursos importantes

- Documentación Hermes: https://hermes-agent.nousresearch.com/docs
- Skill `lead-pipeline` (estructura base del proyecto).
- Skill `impeccable` (pulida visual/UI).
- Skill `shadcn-ui` / `astro-shadcn-webapp` si se añaden nuevos componentes.

---

Última actualización: sesión actual. Si algo no cuadra, consulta `README.md`, `settings.json` y el esquema de `leads.db`.
