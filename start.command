#!/bin/bash
# Arranca el dashboard en modo desarrollo y abre el navegador.
# Doble clic en Finder, o ./start.command desde la terminal.
# Para pararlo: Ctrl+C en esta ventana.

set -uo pipefail

PORT="${PORT:-4321}"
URL="http://localhost:$PORT/"

# Trabaja siempre relativo a la ubicación de este script: db.ts resuelve
# leads.db como ../leads.db, así que el cwd debe ser dashboard/.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT/dashboard"

echo "▸ ThinkThings — dashboard (dev)"
echo

if ! command -v npm >/dev/null 2>&1; then
  echo "✗ npm no está en el PATH. Instala Node 22 o abre una terminal donde npm exista."
  read -r -p "Pulsa Enter para cerrar…"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "▸ node_modules no existe — instalando dependencias…"
  npm install || { echo "✗ npm install falló"; read -r -p "Pulsa Enter para cerrar…"; exit 1; }
  echo
fi

# Un servidor ya levantado sigue sirviendo el código con el que arrancó, así que
# tras un cambio de rama enseña lo de antes y parece que los cambios no llegan.
# Por eso este script siempre lo reinicia... salvo si hay una generación viva:
# queue.ts lanza el proceso de Magnific SIN detached, o sea que es hijo del
# servidor y moriría con él, tirando por la borda créditos ya gastados.
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  # Con el Python del proyecto y no con el sqlite3 del sistema: aquel siempre
  # está (el pipeline entero depende de él) y así la comprobación no se salta
  # sola en una máquina donde falte el cliente de línea de órdenes.
  RUNNING=0
  if [ -x "$ROOT/.venv/bin/python" ] && [ -f "$ROOT/leads.db" ]; then
    RUNNING=$("$ROOT/.venv/bin/python" -c "
import sqlite3, sys
try:
    c = sqlite3.connect('file:$ROOT/leads.db?mode=ro', uri=True)
    print(c.execute(\"SELECT COUNT(*) FROM jobs WHERE state = 'running'\").fetchone()[0])
except Exception:
    print(0)
" 2>/dev/null || echo 0)
  fi

  if [ "${RUNNING:-0}" -gt 0 ] && [ "${1:-}" != "--force" ]; then
    echo "▸ Hay $RUNNING trabajo(s) en marcha (generación de rediseños)."
    echo "  Reiniciar ahora los mata, y los créditos ya gastados no vuelven."
    echo
    if [ -t 0 ]; then
      read -r -p "¿Reiniciar de todos modos? [s/N] " answer
    else
      answer="n"
    fi
    case "${answer:-n}" in
      [sSyY]*) ;;
      *)
        echo "▸ dejando el servidor como está — abriendo el navegador."
        echo "  (cuando terminen, vuelve a ejecutar este script)"
        open "$URL"
        exit 0
        ;;
    esac
  fi

  echo "▸ parando el servidor anterior para cargar el código actual…"
  kill $(lsof -t -nP -iTCP:"$PORT" -sTCP:LISTEN) 2>/dev/null
  for _ in $(seq 1 20); do
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
    sleep 0.25
  done
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "✗ el proceso del puerto $PORT no se ha parado. Míralo con:"
    echo "    lsof -nP -iTCP:$PORT -sTCP:LISTEN"
    read -r -p "Pulsa Enter para cerrar…"
    exit 1
  fi
  echo
fi

# Abre el navegador en cuanto el servidor responda, sin bloquear el arranque.
(
  for _ in $(seq 1 40); do
    if curl -sf -o /dev/null "$URL"; then
      open "$URL"
      break
    fi
    sleep 0.5
  done
) &

echo "  El dashboard estará en: $URL"
echo "  (Ctrl+C para pararlo)"
echo

npm run dev -- --port "$PORT"
