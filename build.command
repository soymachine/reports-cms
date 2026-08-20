#!/bin/bash
# Lanza el build del dashboard (npm run build).
# Doble clic en Finder, o ./build.command desde la terminal.

set -euo pipefail

# Trabaja siempre relativo a la ubicación de este script, no al cwd de Finder.
cd "$(dirname "${BASH_SOURCE[0]}")/dashboard"

echo "▸ ThinkThings — build del dashboard"
echo "  dir: $(pwd)"
echo

if ! command -v npm >/dev/null 2>&1; then
  echo "✗ npm no está en el PATH. Instala Node 22 o abre una terminal donde npm exista."
  read -r -p "Pulsa Enter para cerrar…"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "▸ node_modules no existe — instalando dependencias…"
  npm install
  echo
fi

if npm run build; then
  echo
  echo "✓ Build completado → dashboard/dist/"
  status=0
else
  status=$?
  echo
  echo "✗ El build ha fallado (código $status)"
fi

# Mantiene la ventana abierta cuando se lanza con doble clic desde Finder.
if [ -t 0 ]; then
  read -r -p "Pulsa Enter para cerrar…"
fi
exit $status
