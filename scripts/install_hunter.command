#!/bin/bash
# Programa el cazador nocturno con launchd. Doble clic en Finder, o
# ./scripts/install_hunter.command [HH:MM] desde la terminal.
#
# Para desprogramarlo:   ./scripts/install_hunter.command --uninstall
# Para pausarlo sin desprogramarlo: el interruptor del panel (recomendado).

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.thinkthings.leadhunter"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
TEMPLATE="$ROOT/launchd/$LABEL.plist.template"

pause_at_end() {
  # Al abrirlo con doble clic la ventana se cierra sola: sin esto no se lee nada.
  [ -t 0 ] || read -r -p "Pulsa Enter para cerrar…"
}

if [ "${1:-}" = "--uninstall" ]; then
  launchctl unload "$PLIST" 2>/dev/null
  rm -f "$PLIST"
  echo "▸ cazador desprogramado ($LABEL)"
  pause_at_end
  exit 0
fi

WHEN="${1:-02:00}"
HOUR="${WHEN%%:*}"
MINUTE="${WHEN##*:}"
if ! [[ "$HOUR" =~ ^[0-9]{1,2}$ && "$MINUTE" =~ ^[0-9]{1,2}$ ]] \
   || [ "$HOUR" -gt 23 ] || [ "$MINUTE" -gt 59 ]; then
  echo "✗ hora no válida: «$WHEN». Usa HH:MM, por ejemplo 03:30."
  pause_at_end
  exit 1
fi

if [ ! -x "$ROOT/.venv/bin/python" ]; then
  echo "✗ falta $ROOT/.venv/bin/python — crea el entorno antes (ver README)."
  pause_at_end
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/logs"
sed -e "s|__PROJECT_ROOT__|$ROOT|g" \
    -e "s|__HOUR__|$((10#$HOUR))|g" \
    -e "s|__MINUTE__|$((10#$MINUTE))|g" \
    "$TEMPLATE" > "$PLIST"

launchctl unload "$PLIST" 2>/dev/null      # por si ya estaba cargado
if launchctl load "$PLIST"; then
  printf '▸ cazador programado a las %02d:%02d\n' "$((10#$HOUR))" "$((10#$MINUTE))"
  echo "  registro: logs/hunter.log"
  echo "  pausar sin desprogramar: interruptor «Cazador automático» del panel"
  echo "  probar ahora: launchctl start $LABEL"
else
  echo "✗ launchctl no pudo cargar $PLIST"
  pause_at_end
  exit 1
fi
pause_at_end
