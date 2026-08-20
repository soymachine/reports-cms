#!/bin/bash
# Arranca el dashboard en modo desarrollo y abre el navegador.
# Doble clic en Finder, o ./start.command desde la terminal.
# Para pararlo: Ctrl+C en esta ventana.

set -uo pipefail

PORT="${PORT:-4321}"
URL="http://localhost:$PORT/"

# Trabaja siempre relativo a la ubicación de este script: db.ts resuelve
# leads.db como ../leads.db, así que el cwd debe ser dashboard/.
cd "$(dirname "${BASH_SOURCE[0]}")/dashboard"

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

# Si ya hay algo escuchando en el puerto, no arrancamos otra instancia.
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "▸ Ya hay un servidor escuchando en el puerto $PORT — abriendo el navegador."
  open "$URL"
  exit 0
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
