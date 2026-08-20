#!/bin/bash
# Reindexa el proyecto en el grafo de codebase-memory.
# Doble clic en Finder, o ./reindex.command [modo] desde la terminal.
#
# El grafo NO se actualiza solo: hay que relanzarlo tras tocar código.
# Modo por defecto: full (incluye scripts/ y extrae las rutas de la API).

set -uo pipefail

MODE="${1:-full}"
BIN="${CODEBASE_MEMORY_BIN:-$HOME/.local/bin/codebase-memory-mcp}"

# Trabaja siempre sobre la carpeta de este script, no sobre el cwd de Finder.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "▸ ThinkThings — reindexado del grafo"
echo "  proyecto: $ROOT"
echo "  modo:     $MODE"
echo

if [ ! -x "$BIN" ]; then
  echo "✗ No encuentro codebase-memory-mcp en: $BIN"
  echo "  Si está en otra ruta, exporta CODEBASE_MEMORY_BIN=/ruta/al/binario"
  read -r -p "Pulsa Enter para cerrar…"
  exit 1
fi

case "$MODE" in
  full|moderate|fast) ;;
  *)
    echo "✗ Modo no válido: $MODE (usa full, moderate o fast)"
    read -r -p "Pulsa Enter para cerrar…"
    exit 1
    ;;
esac

# Estado previo, para poder mostrar el delta al terminar.
before=$("$BIN" cli index_status --project "$(basename "$ROOT")" 2>/dev/null | tail -1)

echo "▸ Indexando… (puede tardar un minuto)"
out=$("$BIN" cli index_repository --repo-path "$ROOT" --mode "$MODE" 2>&1)
status=$?
result=$(printf '%s\n' "$out" | grep '^{' | tail -1)

if [ $status -ne 0 ] || [ -z "$result" ]; then
  echo "✗ El indexado ha fallado:"
  printf '%s\n' "$out" | tail -12
  read -r -p "Pulsa Enter para cerrar…"
  exit 1
fi

printf '%s\n' "$result" | python3 -c '
import json, sys
d = json.load(sys.stdin)
ex = ", ".join(d.get("excluded", {}).get("dirs", []))
print("")
print("  nodos:    {}".format(d.get("nodes", "?")))
print("  aristas:  {}".format(d.get("edges", "?")))
if ex:
    print("  excluido: {}".format(ex))
print("  estado:   {}".format(d.get("status", "?")))
' 2>/dev/null || printf '%s\n' "$result"

echo
echo "✓ Grafo actualizado"

if [ -t 0 ]; then
  read -r -p "Pulsa Enter para cerrar…"
fi
