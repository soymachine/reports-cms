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

## Hechas (21/08/2026)

12. **Comparador antes / después** — la parte crítica: es donde se decide qué estilo
    y qué versión salen a un cliente. El panel del lead gana un control de tamaño de
    los pares (100 / 75 / 50 % y «una fila»); el comparador gana rejilla de pares por
    estilo con escala y encaje en una fila, rejilla de versiones en paralelo, lupa
    sincronizada sobre las dos imágenes, parpadeo A/B en el deslizador, fondo
    conmutable, ficha técnica, descarga y copia del PNG, atajos con su chuleta y
    preferencias recordadas. Las versiones se eligen siempre desde la barra, sin
    desplegar nada, y el deslizador compara contra lo que se le diga (el PDF, otro
    estilo, otra versión) en vez de estar atado al original. En el panel del lead
    cada par lleva sus chips de versión, para componer el deck eligiendo página a
    página la toma que mejor case, con aviso cuando lo que se mira ya no es lo que
    entraría en el PDF. Las imágenes cargan por miniatura primero y las vecinas
    se precargan. De paso, escribir en el cuadro de «rehacer» ya no dispara los
    atajos ni cierra el comparador de golpe.

13. **Trabajos que sobreviven a la ficha** — la búsqueda de PDFs corre en el servidor,
    pero el indicador vivía en el modal: al cerrar y reabrir el lead el botón decía
    «Buscar PDFs de reports» como si no hubiera nada, y el salto a `PDF Found` no
    llegaba a ocurrir porque lo hacía el navegador al ver terminar el trabajo. Ahora
    el estado lo escribe el script, el panel se reengancha al trabajo en curso al
    abrirse (búsqueda o generación), y la búsqueda registra su pid para que el
    barrido de arranque no la dé por muerta al reiniciar el dashboard.

14. **Rediseño obligatorio en el prompt** — con seedream-5-pro a 1.5k, 3 de 4 páginas
    volvieron prácticamente idénticas al original: el prompt describía el resultado
    deseado y pedía conservar las cifras, pero en ningún sitio decía que la maquetación
    del original NO se conserva. Ahora todo prompt (menos el de refinar sobre un
    rediseño aprobado) abre con el encargo explícito: la referencia es contenido, no
    diseño; lista lo que debe cambiar y lo que no; y declara que conservar la
    composición es un fallo. Además el control de calidad mide la distancia de
    maquetación y marca los calcos en la interfaz, que era la parte que hasta ahora
    dependía del ojo de quien mirase.

15. **Pares antes/después hechos a mano** — el estudio rehace páginas por su
    cuenta y necesitaba meterlas en el circuito sin perder el PDF comparativo.
    Dos campos por report (originales y nuevas), emparejado por nombre de archivo
    con la pareja a la vista antes de subir, número de página editable y borrado
    de lo ya subido. Entran como entradas normales de `generated` con
    `source: "manual"`, así que reaprovechan tal cual el panel Antes / Después, el
    comparador, los ganadores, el control de calidad, el deck ES/EN y el email.
    De paso, `qc_redesign.py` ya no revienta cuando el PDF de origen no está en
    disco: devolvía un traceback en vez de JSON y dejaba al que llama sin nada.

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
