# Mejoras pendientes

Lista viva de lo que queda por hacer, con el porqué. Las que ya están hechas se
marcan y se dejan como registro de decisiones.

## Hechas (19/08/2026)

1. **Llamada directa a Magnific** — `scripts/magnific_client.py`, cliente MCP propio sobre
   la sesión OAuth de Hermes. `generate_redesign.py --engine direct` (por defecto) genera
   sin agente intermedio; `--engine agent` sigue disponible como respaldo.
2. **Cola de trabajos** — `dashboard/src/lib/queue.ts`: tope de concurrencia, cancelación,
   pid registrado y cierre de huérfanos al arrancar.
3. **Créditos reales** — coste exacto de la API por imagen, saldo de la cuenta en la barra
   lateral y `/api/credits` con el gasto por lead.
5. **QC bloqueante** — el deck excluye los rediseños con el control de datos en fallo salvo
   override explícito (`--allow-failed-qc`), avisando de cuáles ha dejado fuera.
7. **Miniaturas** — WebP de 720 px por rediseño (`scripts/thumbs.py`), usadas en galería,
   selector y fichas.
8. **Higiene de disco** — `scripts/cleanup.py` informa y, con `--apply`, poda; `/api/disk`
   expone el informe en solo lectura.
9. **Selección de páginas** — el scorer valora cifras y tablas, penaliza índices y
   bibliografías, y explica su decisión en la interfaz.
11. **Coherencia entre páginas** — la primera imagen de cada tanda ancla el estilo de las
    demás vía `references type: "style"`, más una cláusula de serie en el prompt y anclaje
    en el deck existente al añadir páginas.
10. **Acceso y tests** — token opcional (`DASHBOARD_TOKEN`), `tests/test_pipeline.py` y
    `tests/smoke_api.sh`.

## Aplazadas (decisión del 19/08/2026)

### 4. Cerrar el bucle comercial: enviar y seguir

Hoy el pipeline muere en "Demo Ready": se redacta un email desde el lead y a partir
de ahí todo es manual. Con 260 leads en la base, los demos generados se quedan sin
salir por la puerta.

Qué haría falta:

- Adjuntar el PDF comparativo al borrador de email (hoy hay que descargarlo a mano).
- Registrar fecha de envío, de apertura si es posible y de respuesta, en vez de
  depender solo del campo `status`.
- Recordatorios de seguimiento a 3 y 10 días desde el envío.
- Campo "próxima acción" (fecha + nota) que ordene el tablero Kanban, para que la
  vista por defecto sea "qué toca hoy" en vez de "qué existe".

Riesgo a tener en cuenta: enviar correo en nombre del estudio es una acción hacia
fuera e irreversible. El envío debe ser explícito y confirmado, nunca automático.

### 6. Generación por lotes

Un botón del tipo "genera demos para los N leads del radar", con modelo, estilo y
presupuesto elegidos una sola vez. Hoy la generación es página a página y lead a
lead.

Depende de la cola de trabajos (mejora 2, ya hecha): sin un worker con tope de
concurrencia, un lote son N procesos simultáneos quemando créditos sin control.

Qué haría falta:

- Selección múltiple de leads (la tabla ya tiene checkboxes) → "generar demos".
- Un tope de gasto para el lote entero, además de los topes por lead y por día.
- Vista de progreso del lote y parada de emergencia que cancele lo pendiente.
