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

### Fase 0 — Verificación previa (30 min, bloquea todo lo demás)

Antes de escribir el login hay que confirmar que el MCP de Magnific permite
registro dinámico de clientes. Desde esta máquina, con la sesión actual:

```bash
curl -s https://mcp.magnific.com/.well-known/oauth-protected-resource | jq .
curl -s https://mcp.magnific.com/.well-known/oauth-authorization-server | jq .
cat ~/.hermes/mcp-tokens/magnific.meta.json      # qué descubrió Hermes
cat ~/.hermes/mcp-tokens/magnific.client.json    # client_id y si hubo DCR
```

Tres desenlaces:

- **Hay `registration_endpoint`** → camino limpio: nos registramos como cliente
  propio ("thinkthings-cms") y quedamos independientes.
- **No lo hay, pero el `client_id` de Hermes es público** (los clientes OAuth
  públicos con PKCE no llevan secreto) → reutilizamos ese `client_id` en el flujo
  de código de autorización. Bootstrap heredado de Hermes por una vez, pero **cero
  dependencia en ejecución**: no hace falta que Hermes esté instalado.
- **Ni una cosa ni la otra** → única vía: copiar los tres ficheros de
  `~/.hermes/mcp-tokens/` a la máquina del hermano y renovar cuando caduque el
  refresh token. Es el escenario malo; entonces la recomendación es dejar Hermes
  instalado *solo* para el login y quitarlo de todo lo demás (fases 2-6 siguen
  siendo válidas).

> No he podido comprobarlo desde este entorno remoto: el proxy bloquea el dominio
> de Magnific. Es el primer paso a ejecutar en local.

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

### Fase 4 — El cazador nocturno

Dos piezas nuevas, ambas versionadas:

1. **`agents/lead-hunter.md`** — el prompt del cazador, hoy perdido dentro de
   Hermes. Hay que reconstruirlo (buscar hasta 5 organizaciones nuevas con
   DuckDuckGo Lite, dedupe por nombre normalizado, insertar con `source=agent`
   vía `lead_mgr.py`). `lead_mgr.py` ya está diseñado como CLI para agentes y
   devuelve JSON: sirve tal cual, solo cambia quién lo llama.
2. **`scripts/hunt.command`** — envoltorio que ejecuta:

   ```bash
   claude --bare -p "$(cat agents/lead-hunter.md)" \
     --allowedTools "Bash(.venv/bin/python lead_mgr.py *),Bash(curl *),Read" \
     --output-format json >> logs/hunt-$(date +%F).json
   ```

   `--bare` es lo recomendado para scripts: arranca sin cargar hooks, plugins ni
   `CLAUDE.md` del entorno, así el resultado es el mismo en las dos máquinas. Ojo:
   en modo `--bare` Claude Code no usa el login de suscripción, necesita
   `ANTHROPIC_API_KEY`. Si se prefiere usar la suscripción, se quita `--bare` y se
   acepta que el entorno local influye. `--allowedTools` acota lo que puede tocar;
   sin permisos abiertos y sin `--permission-mode` amplio.

   Alternativa a considerar: hoy `pdf_finder.py` ya hace búsqueda + descarga sin
   LLM. Si al reconstruir el prompt se ve que el cazador solo hacía búsquedas
   mecánicas, sale más barato y más fiable un `scripts/hunt.py` determinista sin
   agente. Decidirlo al escribir el prompt, no antes.

3. **Programación**: `com.thinkthings.leadhunter.plist` en el repo +
   `scripts/install_hunter.command` que lo copia a `~/Library/LaunchAgents` y hace
   `launchctl load`. En macOS `launchd` es más fiable que `crontab` (arranca aunque
   la máquina estuviera dormida a las 02:00, con `StartCalendarInterval`).
4. **`hunt-now.ts`**: `spawn('hermes', ['cron','run', jobId])` →
   `spawn('scripts/hunt.command')`, y fuera `settings.json → cron.lead_hunter_job_id`
   (queda `cron.schedule` como documentación del horario).

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
- `leads.db` y `pdfs/` no están en git (correcto): hay que decidir si el hermano
  parte de cero (`import_excel.py`) o se le pasa una copia de la base.

Entregable: **`setup.command`** que verifica Python 3.12, crea `.venv`, instala
`openpyxl`, comprueba `pdftoppm` y `node`, hace `npm install` y termina lanzando
`magnific_login.py`; más un `CLAUDE.md` con las reglas del proyecto (hoy están en
`Instructions.md`, escrito para agentes de Hermes) para que Claude Code las cargue
solo en las dos máquinas.

Y actualizar `README.md` (líneas 90, 91, 99) e `Instructions.md` (38, 52, 53, 69,
71, 96, 97, 212, 252, 265), donde Hermes aparece como requisito del sistema.

## 4. Orden de ejecución y coste

| Fase | Qué desbloquea | Esfuerzo |
|------|----------------|----------|
| 0 Verificar OAuth | todo lo demás | 30 min |
| 1 `magnific_login.py` | independencia real | medio día |
| 3 Semáforo | dashboard portable | 1 h |
| 2 Catálogo | quita `hermes chat` | 1 h |
| 5 Borrar `--engine agent` | último `hermes chat` | 30 min |
| 4 Cazador + launchd | el cron | medio día (más si el prompt hay que reinventarlo) |
| 6 `setup.command` + docs | la máquina del hermano | 2-3 h |

Fases 1, 2, 3 y 5 son independientes entre sí salvo por el orden lógico; la 4 es
la única con incertidumbre alta, porque el prompt original no está en el repo.

## 5. Riesgos

1. **Magnific sin registro dinámico** (fase 0). Es el único riesgo que puede
   tumbar el plan; mitigación en la fase 0.
2. **Una cuenta de Magnific, dos máquinas.** El refresh token rota en cada
   renovación (`magnific_client.py:135`): si las dos máquinas comparten copia del
   mismo token, la segunda se queda fuera al renovar la primera. Lo correcto es un
   login por máquina, no copiar el fichero.
3. **`claude -p` no es gratis.** El cazador nocturno pasa a consumir cuota o API
   key en la máquina de quien lo tenga programado. Conviene fijar un tope y
   registrar el coste, que `--output-format json` ya reporta en `total_cost_usd`.
4. **El cazador reconstruido no será idéntico al original.** Vale la pena
   ejecutarlo unas noches en paralelo comparando lo que inserta antes de fiarse.

## 6. Decisiones que necesito de ti

- ¿El cazador debe seguir siendo agéntico (`claude -p`) o lo hacemos determinista
  en Python? Lo sabremos mejor al reconstruir el prompt, pero tienes preferencia.
- ¿La máquina de tu hermano parte de una base de datos vacía o le pasamos copia de
  `leads.db` y `pdfs/`?
- ¿Programamos el cazador en las dos máquinas o solo en una? (Dos máquinas
  cazando a la vez duplican leads; el dedupe es por nombre normalizado, aguanta,
  pero es gasto doble.)
