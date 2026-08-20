# Migración: quitar Hermes y quedarse solo con Claude Code

Objetivo: que el proyecto funcione entero en una máquina nueva (la de mi hermano)
sin Hermes instalado, y sin perder ninguna capacidad actual.

**Veredicto: es posible.** Ninguna pieza del pipeline necesita a Hermes *como
motor*. Lo que Hermes aporta hoy es (a) el login OAuth contra el MCP de Magnific,
(b) un cron, (c) un chequeo de estado y (d) un agente que ya casi no se usa.
Las cuatro tienen sustituto. El único trabajo real de ingeniería es (a): unas
150 líneas de OAuth propio.

Conviene además separar dos cosas que se confunden:

- **El pipeline de rediseños no necesita ningún LLM.** Desde que existe
  `scripts/magnific_client.py`, las llamadas a Magnific son deterministas. Ahí no
  hay que sustituir Hermes por Claude Code: hay que sustituirlo por *nada*.
- **El cazador nocturno de leads sí es un trabajo de agente** (decidir qué
  organizaciones son buenos leads). Ese es el único sitio donde Claude Code entra
  de verdad, en modo `claude -p`.

## 1. Inventario: qué hace Hermes hoy

| # | Uso | Dónde | Criticidad | Sustituto |
|---|-----|-------|-----------|-----------|
| 1 | `hermes mcp login magnific` — sesión OAuth en `~/.hermes/mcp-tokens/` | `scripts/magnific_client.py:35` | **Bloqueante.** Sin esto no se genera nada | Script de login propio |
| 2 | `hermes cron run/pause d28024ce08c5` — cazador nocturno | `settings.json`, `dashboard/src/pages/api/hunt-now.ts:12` | Alta | `claude -p` + `launchd` |
| 3 | `hermes mcp test magnific` — semáforo de estado | `dashboard/src/pages/api/magnific-status.ts:18` | Media (cosmética) | `account_balance()` del cliente propio |
| 4 | `hermes chat -q` — catálogo de modelos | `scripts/refresh_magnific_models.py:56` | Baja (se corre a mano y rara vez) | Llamadas MCP directas |
| 5 | `hermes chat -q` — motor `--engine agent` de rediseño | `scripts/generate_redesign.py:518` | Nula (es respaldo del camino `direct`) | Borrarlo |

Dos hallazgos que importan más que la lista:

- **El cazador nocturno no está en el repo.** Solo está el id del job
  (`d28024ce08c5`) en `settings.json`; el prompt y el horario viven en la config
  de Hermes de esta máquina. Clonar el repo en otra máquina **no** trae el agente:
  hoy ya es irreproducible. Migrar obliga a escribirlo en el repo, que es una
  mejora en sí misma.
- **`magnific_client.py` ya sabe refrescar su token solo** (`_refresh`, líneas
  103-135): lee `token_endpoint` de `magnific.meta.json` y `client_id` de
  `magnific.client.json`. Es decir, de todo el ciclo OAuth, lo único que hoy pone
  Hermes es **el primer login**. El resto ya es nuestro.

## 2. Por qué no basta con registrar Magnific en Claude Code

La tentación es `claude mcp add --transport http magnific https://mcp.magnific.com`
y autorizar con `/mcp`. Funciona para *chatear* con Magnific, pero **no sirve al
pipeline**: Claude Code guarda esas credenciales en el llavero de macOS o en un
fichero de credenciales propio, no en una ruta pública y estable que
`magnific_client.py` pueda leer. Depender de eso sería cambiar un acoplamiento
frágil (Hermes) por otro (el almacén interno de otro CLI).

Además, meter la generación de imágenes dentro de un agente es exactamente el
error del que ya salimos: variantes de más pagadas, ficheros pisados, créditos
extraídos de la prosa (ver cabecera de `magnific_client.py`).

**Decisión: el proyecto se autentica solo.** Ni Hermes ni Claude Code en el camino
crítico. Claude Code queda para lo que es agéntico de verdad: el cazador.

## 3. Fases

### Fase 0 — Verificación previa (5 min, bloquea todo lo demás)

Antes de escribir el login hay que confirmar que el MCP de Magnific permite
registro dinámico de clientes. **Ya está automatizado** en
`scripts/fase0_check.py`: sondeo de solo lectura, sin dependencias, que no gasta
créditos y no imprime ningún token.

```bash
python3 scripts/fase0_check.py
```

Mira tres cosas: si el MCP anuncia sus metadatos OAuth, si el servidor de
autorización declara `registration_endpoint`, y qué dejó escrito Hermes en
`~/.hermes/mcp-tokens/`. Termina con uno de estos veredictos:

- **Escenario A — hay `registration_endpoint`** → camino limpio: nos registramos
  como cliente propio ("thinkthings-cms") y quedamos independientes.
- **Escenario B — no lo hay, pero el `client_id` de Hermes es público** (los
  clientes OAuth públicos con PKCE no llevan secreto) → reutilizamos ese
  `client_id`. Bootstrap heredado de Hermes por una vez, pero **cero dependencia
  en ejecución**: no hace falta que Hermes esté instalado.
- **Escenario C — ni una cosa ni la otra** → no hay login sin Hermes. Recomendación
  entonces: dejarlo instalado *solo* para el login y quitarlo de todo lo demás
  (fases 2-6 siguen siendo válidas). Antes de rendirse, mirar si Magnific ofrece
  API key en su panel web.

Un cuarto desenlace, `SIN VEREDICTO`, significa que la máquina no llegó al
servidor: no dice nada sobre A/B/C. Repetir con conexión directa.

> Este sondeo **no puede correrse desde una sesión remota de Claude Code**: el
> contenedor no tiene tu `~/.hermes/` y la política de red del entorno bloquea el
> dominio de Magnific. Es un paso de tu máquina.

### Fase 1 — `scripts/magnific_login.py` (núcleo del trabajo)

Un script sin dependencias externas (`urllib` + `http.server`, como el resto):

1. Descubrimiento: `/.well-known/oauth-protected-resource` →
   `/.well-known/oauth-authorization-server` del servidor de autorización.
2. Registro dinámico (RFC 7591) si existe, con
   `redirect_uri = http://127.0.0.1:8765/callback`; si no, `client_id` conocido.
3. Código de autorización + PKCE (S256): levanta un servidor local en 8765, abre
   el navegador, captura el `code`, lo canjea por tokens.
4. Escribe los **mismos tres ficheros con los mismos nombres** que hoy escribe
   Hermes (`magnific.json`, `magnific.meta.json`, `magnific.client.json`), con
   permisos `0600`, en `~/.thinkthings/magnific/`.

Al conservar el formato, `_refresh()` de `magnific_client.py` sigue funcionando
sin tocarlo. El único cambio en el cliente es la resolución del directorio:

```python
# scripts/magnific_client.py
def _token_dir() -> Path:
    if os.environ.get("MAGNIFIC_TOKEN_DIR"):
        return Path(os.environ["MAGNIFIC_TOKEN_DIR"])
    own = Path.home() / ".thinkthings" / "magnific"
    if (own / "magnific.json").exists():
        return own
    return Path.home() / ".hermes" / "mcp-tokens"   # legado, se borrará
```

Así **esta máquina no se rompe en ningún momento**: sigue usando la sesión de
Hermes hasta que se corra el login nuevo. Y los mensajes de error dejan de decir
`ejecuta hermes mcp login magnific` y pasan a decir
`.venv/bin/python scripts/magnific_login.py` (afecta a `magnific_client.py` ×3,
`LeadDetail.tsx:871`, `Sidebar.tsx:39`).

Criterio de aceptación: con `~/.hermes` renombrado temporalmente, `python -c
"from magnific_client import Magnific; print(Magnific().account_balance())"`
devuelve el saldo.

### Fase 2 — Catálogo de modelos sin agente

`refresh_magnific_models.py` hoy le pide a un LLM que llame a `images_models_list`
y `simulate_cost` y devuelva JSON, y luego rebusca el JSON entre la prosa. Es el
mismo antipatrón que ya se corrigió en la generación, y el cliente propio ya tiene
`simulate_cost()` (línea 247). Se reescribe el `ask_agent()` como bucle directo
sobre modelos × resoluciones. Menos código, sin timeouts de 30 min, sin
`.magnific_models_last_output.log`.

### Fase 3 — Semáforo de estado sin CLI

`dashboard/src/pages/api/magnific-status.ts` deja de hacer `execFileSync` sobre un
binario en `/Users/danimoyalya2/.local/bin/hermes` (ruta que, dicho sea de paso,
rompe el dashboard en cualquier otra máquina aunque Hermes esté instalado) y pasa
a ejecutar `.venv/bin/python scripts/magnific_status.py`, resolviendo el intérprete
desde `PROJECT_ROOT` como ya hacen `credits.ts`, `disk.ts` y compañía. El script
devuelve `{ok, status, balance}` distinguiendo `connected` / `auth_required` /
`error` por **excepción tipada** (`MagnificAuthError`), no por buscar `✓` y `OAuth`
en un texto. Se mantiene la caché de 60 s.

### Fase 4 — El cazador nocturno (determinista)

**Decisión tomada: sin agente.** El cazador pasa a ser `scripts/hunt.py`, Python
puro, sin LLM. Ventajas e inconvenientes comparados más abajo (§5).

Piezas:

1. **`scripts/hunt.py`** — busca organizaciones candidatas en DuckDuckGo Lite con
   las mismas consultas que ya usa `pdf_finder.py` (que hoy hace búsqueda +
   descarga + control de calidad sin ningún LLM: la mitad del trabajo ya está
   escrita y probada), normaliza el nombre, descarta las que ya existen y las
   inserta con `source=agent` reutilizando las funciones de `lead_mgr.py`. Tope
   por ejecución: `settings.json → hunter.max_new_leads` (5).
   El scoring de prioridad ya existe en `scripts/score_leads.py`.
2. **Interruptor y parada** (ver §"El botón de parar" abajo).
3. **Programación con `launchd`**: `com.thinkthings.leadhunter.plist` versionado +
   `scripts/install_hunter.command` que lo copia a `~/Library/LaunchAgents` y hace
   `launchctl load`. En macOS `launchd` es más fiable que `crontab`:
   `StartCalendarInterval` recupera la ejecución si la máquina estaba dormida a
   las 02:00.
4. **`hunt-now.ts`**: `spawn('hermes', ['cron','run', jobId])` → `spawn(python,
   ['scripts/hunt.py'])`, resolviendo el intérprete desde `PROJECT_ROOT` como ya
   hacen `credits.ts` y compañía. Fuera `settings.json → cron.lead_hunter_job_id`.

#### El botón de parar

Buena intuición, y esconde **dos cosas distintas** que conviene no mezclar:

| Quiero… | Qué hace falta | Control en la interfaz |
|---|---|---|
| Abortar la ejecución que está corriendo ahora | matar el proceso por su pid | Botón **Detener** (solo visible mientras corre) |
| Que no vuelva a saltar esta noche | una bandera que el script mire al arrancar | Interruptor **Cazador activo** |

El segundo es el importante y el que casi siempre falta. La forma robusta **no**
es descargar el job de `launchd` (necesita permisos, falla en silencio y luego
nadie recuerda cómo volver a cargarlo), sino la inversa: `launchd` sigue
disparando cada noche, y lo primero que hace `hunt.py` es leer
`settings.json → hunter.enabled`; si está en `false`, escribe una línea en el log
y sale con código 0. Pausar y reanudar es entonces un `PATCH` a un fichero, sin
tocar el sistema, y funciona igual en las dos máquinas.

La cola de trabajos (`dashboard/src/lib/queue.ts`) ya resuelve el primer caso para
las generaciones: registra el pid, permite cancelar y cierra los huérfanos al
arrancar. El cazador debe entrar por ahí en vez de inventarse su propio mecanismo.

Endpoints: `POST /api/hunt-now` (lanzar), `POST /api/hunt-stop` (matar el pid en
curso), `POST /api/hunt-toggle` (bandera `enabled`), `GET /api/hunt-status`
(corriendo / última ejecución / leads insertados / activo o pausado).

#### Las dos máquinas

Programado en ambas, como pediste, con dos salvaguardas:

- **Horarios escalonados** (02:00 aquí, 03:30 allí) para que no compitan por los
  mismos resultados de búsqueda en el mismo minuto.
- El dedupe por nombre normalizado ya existe (`scripts/dedupe.py`), pero está
  pensado para limpiar *después*. `hunt.py` debe comprobar `lead_mgr exists`
  **antes** de insertar, que es más barato que arreglarlo luego.

Como es determinista, "gasto doble" aquí solo significa ancho de banda y algún
lead repetido: sin agente no hay coste por token. Esa es, de hecho, la razón más
práctica para elegir determinista mientras estáis en desarrollo.

### Fase 5 — Borrar el motor `agent`

Quitar de `generate_redesign.py` el bloque `--engine agent` (líneas ~509-549),
`PROMPT_TEMPLATE`, `parse_credits()` sobre prosa y el fallback de la línea 492.
Son ~120 líneas cuyo único propósito es sobrevivir a un fallo de sesión, y que en
realidad *empeoran* ese fallo (genera imágenes sin control de coste justo cuando
algo va mal). Sin sesión, lo correcto es fallar con `MAGNIFIC_AUTH_REQUIRED` y que
el dashboard pida el login. `--engine` desaparece del CLI y de `generate.ts`.

### Fase 6 — Portabilidad real a la otra máquina

Lo que hoy impide clonar y arrancar, más allá de Hermes:

- `/Users/danimoyalya2/.local/bin/hermes` — desaparece en la fase 3.
- `.venv` con Python 3.12 y `/opt/homebrew/bin/python3.12` documentado a pelo.
- `poppler` (`pdftoppm`, `pdfinfo`) y Node 22+.
- `leads.db` y `pdfs/` no están en git (correcto) y se le pasan copiados. Hace
  falta `scripts/export_bundle.command`: cierra la base con `VACUUM INTO` (copiar
  un SQLite en caliente puede dar un fichero corrupto), empaqueta `leads.db` +
  `pdfs/` + `generated/` en un `.tar.gz` con su suma de verificación, y del otro
  lado `scripts/import_bundle.command` lo descomprime y verifica. Los tokens de
  Magnific **no** van en el paquete: cada máquina hace su propio login (ver §6).

Entregables: **una guía HTML autocontenida** (`documentacion/traspaso.html`, un
único fichero para abrir con doble clic, sin dependencias) con los pasos en orden
para la máquina nueva; y **`setup.command`** que verifica Python 3.12, crea `.venv`, instala
`openpyxl`, comprueba `pdftoppm` y `node`, hace `npm install` y termina lanzando
`magnific_login.py`; más un `CLAUDE.md` con las reglas del proyecto (hoy están en
`Instructions.md`, escrito para agentes de Hermes) para que Claude Code las cargue
solo en las dos máquinas.

Y actualizar `README.md` (líneas 90, 91, 99) e `Instructions.md` (38, 52, 53, 69,
71, 96, 97, 212, 252, 265), donde Hermes aparece como requisito del sistema.

## 4. Orden de ejecución y coste

| Fase | Qué desbloquea | Esfuerzo |
|------|----------------|----------|
| 0 Verificar OAuth (`fase0_check.py`) | todo lo demás | 5 min |
| 1 `magnific_login.py` | independencia real | medio día |
| 3 Semáforo | dashboard portable | 1 h |
| 2 Catálogo | quita `hermes chat` | 1 h |
| 5 Borrar `--engine agent` | último `hermes chat` | 30 min |
| 4 Cazador + launchd + botón de parada | el cron | 1 día |
| 6 Paquete de traspaso + guía HTML + `setup.command` | la máquina del hermano | medio día |

Fases 1, 2, 3 y 5 son independientes entre sí salvo por el orden lógico; la 4 es
la única con incertidumbre alta, porque el prompt original no está en el repo.

## 5. Cazador: agéntico vs determinista

Pediste el porqué de la elección, así que aquí está el balance completo.

### Agéntico (`claude -p`)

**A favor**
- Juicio: distingue "asociación europea de energía renovable" de "consultora que
  vende informes", que es precisamente lo que un `grep` no sabe hacer.
- Se adapta solo cuando DuckDuckGo cambia el HTML o cuando una web reorganiza su
  sección de publicaciones. Hoy el buscador es "frágil ante cambios de HTML"
  (`Instructions.md`, problemas conocidos); un agente absorbe ese cambio sin que
  nadie toque código.
- Enriquece: puede rellenar sector, país y una `rationale` en prosa leyendo la
  web de la organización. Un script solo copia lo que encuentra literal.
- Cambiar el criterio de caza es editar un párrafo, no reescribir funciones.

**En contra**
- Cuesta dinero por ejecución, y el coste es variable e imprevisible.
- No es reproducible: dos noches iguales pueden dar resultados distintos, así que
  cuando inserta basura no siempre sabes por qué.
- No se puede testear de verdad. `tests/test_pipeline.py` no puede cubrirlo.
- Necesita permisos de shell para ser útil, y eso es superficie de riesgo en algo
  que corre solo a las 02:00 sin nadie mirando.
- Ata el proyecto a un CLI externo — exactamente el problema del que salimos con
  Hermes. Cambiaríamos una dependencia por otra.
- Falla de formas raras: prosa en vez de JSON, timeouts, cuota agotada.

### Determinista (`scripts/hunt.py`)

**A favor**
- Coste cero por ejecución y comportamiento idéntico en las dos máquinas.
- Testeable y depurable: un fallo se reproduce y se arregla.
- Sin permisos, sin claves de API, sin CLI externo. Funciona con el `.venv` y ya.
- Reaprovecha lo que ya existe y está probado: `pdf_finder.py` (búsqueda +
  calidad), `lead_mgr.py` (inserción), `dedupe.py`, `score_leads.py`.
- Que corra en dos máquinas a la vez no duplica ningún gasto.

**En contra**
- No tiene criterio: mete lo que encaje con el patrón, y habrá que podar a mano.
  Mitigación: insertar como `Not contacted` con `source=agent` y revisar en el
  tablero antes de gastar créditos en ninguno.
- Se rompe cuando cambia el HTML de DuckDuckGo, y hay que arreglarlo a mano.
- Ampliar el criterio de búsqueda es escribir código, no un párrafo.

### Por qué determinista aquí

Coincido con tu elección, y la razón de fondo es que **el cazador no decide nada
caro**: solo propone filas en una tabla que tú revisas antes de que cueste un
céntimo. El juicio del LLM aportaría precisión en un sitio donde un falso positivo
sale gratis y se borra con un clic. Ahí no compensa ni el coste ni la
irreproducibilidad ni volver a atar el proyecto a un CLI externo.

Y no es irreversible: si al vivir con él ves que la mitad de lo que trae es ruido,
`hunt.py` puede ganar un `--engine agent` de una sola llamada — pasar la lista de
candidatos a `claude -p` para que filtre y explique, dejando la búsqueda y la
inserción donde están. Lo agéntico entraría entonces como *criba*, que es barato y
acotado, y no como *conductor* de todo el proceso, que es donde duele.

## 6. Riesgos

1. **Magnific sin registro dinámico** (fase 0). Es el único riesgo que puede
   tumbar el plan; mitigación en la fase 0.
2. **Una cuenta de Magnific, dos máquinas.** El refresh token rota en cada
   renovación (`magnific_client.py:135`): si las dos máquinas comparten copia del
   mismo token, la segunda se queda fuera al renovar la primera. Lo correcto es un
   login por máquina, no copiar el fichero.
3. **Copiar la base en caliente corrompe SQLite.** El paquete de traspaso debe
   usar `VACUUM INTO` con el dashboard parado, nunca un `cp` de `leads.db`.
4. **El cazador reconstruido no será idéntico al original**, y sin agente traerá
   más ruido. Ejecutarlo unas noches en modo informe (`--dry-run`, que enseñe lo
   que insertaría sin insertarlo) antes de dejarlo suelto.
5. **`claude -p` ya no es riesgo**, al haber elegido determinista: el proyecto
   deja de depender de cualquier CLI de agente, tanto Hermes como Claude Code.

## 7. Decisiones tomadas (20/08/2026)

1. **Cazador determinista**, no agéntico. Comparativa en §5.
2. **Se copia `leads.db` y `pdfs/`** a la máquina nueva, con paquete verificado.
   Guía HTML de traspaso como entregable de la fase 6.
3. **Cazador programado en las dos máquinas**, con horarios escalonados, y con
   interruptor de pausa e botón de parada en el dashboard (fase 4).
