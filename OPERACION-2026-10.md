# BizAcq — operación y alcance, 15 de octubre de 2026

La instrucción de Daniel del 15/oct reactiva la actualización puntual y diaria a las
00:00 de Bogotá. Esta autorización sustituye el hold histórico solo para el alcance
que describe este documento. El checkpoint de Codex permanece pausado: el trabajo
nocturno lo realiza un proceso determinista local, sin llamadas a modelos.

## Superficies y fuentes de verdad

- Dashboard compartido: https://clawddma.github.io/bizacq-dashboard/
- API: https://bizacq-api.clawddma.workers.dev
- Datos compartidos: `data/deals.json`, escritos por el Worker sobre GitHub.
- Código existente: HTML + Alpine; se conservan filtros, etapas, notas, documentos,
  órdenes y análisis anteriores. No se trasladó a otra plataforma.
- Radar como entrada: molde original de seis columnas, tarjetas y ficha lateral; búsqueda y filtros existentes.
- Accesos rápidos: nuevas sin revisar y finalistas. El orden manual sigue disponible.
- Sites público: https://bizacq-radar.danielmesar959464.chatgpt.site
- ID de Sites: appgprj_6ad1171d12448191b52a7a3eec965ddd. Paquete de despliegue en `.sites/bizacq/`; sin copia de datos.
- Sites y GitHub Pages consultan el mismo Worker; no hay una segunda base de datos.
- El navegador consulta cambios cada 60 segundos mientras está visible y sin una ficha abierta ni cambios pendientes. No ejecuta scraping.
- Evaluación: calificación humana 0–5, decisión, hipótesis de automatización y siguiente
  acción compartidas mediante `/update-deal`. No equivale a mover el pipeline.
- Búsquedas guardadas: solo en el navegador donde se crearon; no se anuncian como compartidas.
- Fuentes y actualización: últimas ejecuciones, salud y cobertura por fuente, acceso
  a nueve portales. Acceso público no significa sincronización automática.

## Actualización local

- Proceso: `cli/nightly_refresh.py --apply`.
- LaunchAgent: `com.braindma.bizacq-refresh`, instalado en `~/Library/LaunchAgents/`.
- Calendario: Hour=0 / Minute=0. El Mac se verificó en UTC−05, equivalente a Bogotá.
- `RunAtLoad`: recupera una ejecución al encender/iniciar sesión. No ejecuta otro corte
  si el día de Bogotá ya tiene un comprobante de éxito.
- El Mac debe estar encendido y conectado. No hay infraestructura paga.
- `flock` evita solapamientos. Una ejecución terminada deja comprobante en `.nightly/`.
- Publicación atómica por lote mediante `POST /source-sync`, con token exclusivo local.
  `.nightly.env.local` (0600) y `.nightly/` están ignorados por Git. Nunca imprimir el token.
- Límite: 150 incorporaciones nuevas, 250 registros por lote; fichas existentes en
  rotación. Un corte parcial queda declarado como tal.
- El Worker fusiona únicamente campos de fuente; conserva IDs, notas, documentos,
  pipeline, evaluaciones, análisis y orden del equipo. Cambios monetarios conservan
  antes/después y vuelven a marcar el análisis como pendiente.
- GitHub Contents omite el contenido inline por encima de 1 MB: el Worker usa su
  representación raw, conservando SHA para evitar sobrescrituras concurrentes.
- `/deals` lee mediante Contents API y `no-store`. GitHub raw puede retrasarse respecto
  al commit; una respuesta de escritura no sustituye la lectura posterior por run ID.
- `/checkpoint-apply` no forma parte de este despliegue; no usar el script histórico
  `cli/refresh_20261015.py` para la operación nocturna.

## Cobertura real

**Empire Flippers:** API oficial gratuita sin autenticación, máximo una solicitud por
segundo; el adaptador usa 1,1 s entre páginas y tope de diez páginas. Solo registros
con `country=US` y `listing_status=For Sale`. Fecha original: exclusivamente
`first_listed_at`; nunca `created_at`, `first_made_money_at` ni fecha de consulta.
El beneficio neto anual permanece en `reported_net_profit`; no se renombra a SDE.
Una etiqueta del portal no es confirmación comercial del broker ni auditoría propia.

**DealLedger:** exportación abierta CC0 con links a brokers. Se comprobaron 24.820
filas, pero la fecha máxima de observación del archivo es 8/oct/2026. Se importaron
150 referencias secundarias tras excluir artículos, títulos genéricos/repetidos,
URLs sin estructura de ficha y ubicaciones no reconocidas. Mientras la fecha máxima
no avance a las últimas 72 horas se suspenden nuevas incorporaciones de esta fuente.
Sus fichas permanecen sin verificación directa. La categoría procede de la fuente,
no de una clasificación auditada; requiere revisión al analizar cada negocio.

**BizBuySell, BizQuest, BusinessesForSale, Flippa, Acquire, BizScout, Sunbelt y
Transworld:** accesos de exploración y captura manual de enlaces. No se declara
sincronizado su inventario completo. Algunas fichas requieren cuenta o NDA. No se
aceptaron contratos ni se compraron suscripciones ni se contactaron brokers.

Ausencia de una ficha en un feed no prueba venta o retiro. La rutina registra el
recuento ausente y conserva el historial; nunca descarta automáticamente por ello.
No se recalculan análisis históricos ni se invoca un LLM sin solicitud explícita.

## Verificación y diagnóstico

```bash
cd /Users/braindma/braindma/proyectos/bizacq
python3 -m unittest tests.test_nightly_refresh
node tests/source_sync.test.mjs
# Requiere la vista local servida en 127.0.0.1:8789; no escribe en producción:
python3 tests/dashboard_smoke.py
# Simula lectura de fuentes sin publicar:
python3 cli/nightly_refresh.py
launchctl print gui/$(id -u)/com.braindma.bizacq-refresh
```

El smoke actual prueba entrada por Radar, pendientes, búsqueda, ausencia de falsos
cambios locales, payload de evaluación interceptado, conservación de una ficha abierta
al actualizar y ausencia de desborde de página a 390/768/1440. El rediseño con tabla
y sidebar se retiró por preferencia explícita de Daniel; se conserva la calificación
compartida dentro de la ficha original. La prueba de Worker verifica fusión, duplicados, idempotencia,
autorización y persistencia de evaluación con GitHub simulado. Los análisis antiguos
no se auditaron ni se convirtieron en recomendaciones actuales.

## Siguiente mejora del método de adquisición

La tesis por negocio debe formularse como proceso observable → intervención → métrica
base → piloto → evidencia de resultado. Antes de una oferta, conciliar ganancias
con caja, dependencia del dueño, recurrencia, concentración, permisos y capital de
trabajo. Después de una adquisición: documentar el plan de 100 días, medir ahorro y
ventas por separado, y decidir mantener/vender con resultados observados. La interfaz
captura esa hipótesis; no inventa incrementos de venta, retorno ni valor de salida.

Referencias de diseño del flujo: DealRoom (pipeline, tabla, diligencia y tareas) y
Axial (criterios financieros, geográficos e industriales del comprador).

- https://dealroom.net/product/pipeline
- https://guide.axial.net/docs/how-to-source-deals-via-axial
- https://empireflippers.com/marketplace-api/
- https://github.com/jeffsosville/dealledger/blob/main/data/public/DATA_DICTIONARY.md

## Depuración y scoring preliminar · 15/oct/2026

`screen-v1` en `cloudflare/worker.js` es la única fuente del score mostrado. No usa
`overall_score` ni análisis históricos para priorizar. Los datos desconocidos suman
cero puntos; `coverage` muestra el peso respaldado por datos disponibles, que siguen
siendo declaraciones del portal. No equivale a confianza auditada ni probabilidad de éxito.

Pesos: identidad/vigencia 15; valoración 20; trayectoria/calidad financiera 15;
recurrencia 15; concentración 10; dependencia/transferencia 10; automatización 10;
viabilidad de transacción 5. Hoy varios componentes carecen de evidencia y no suman.
Los cortes de múltiplos son heurísticos iniciales, no benchmarks sectoriales calibrados.
SDE, beneficio neto y flujo del broker conservan su definición en cada ratio.

Por revalidar: sin comprobación directa publicada de los últimos 7 días, URL de
categoría, publicación de más de 365 días o contradicción histórica detectada.
Se preservan etapa, notas, revisión y órdenes. El Radar depurado oculta esos
candidatos activos; la pestaña de revalidación permite investigarlos. Cierres y
descartados conservan visibilidad histórica. No se afirma que estén vendidos o sean falsos.
Si un catálogo completo oficial ya no contiene una oferta, se marca ausente y se
separa para revalidar; nunca se deduce una venta del simple faltante.

`POST /analyze-deal` guarda un informe preliminar con los datos disponibles y las
preguntas de diligencia. No invoca LLM ni consulta registros legales. El endpoint
heredado `/request-analysis` deja una solicitud manual, sin promesa de ejecución.
`POST /screening-rebuild` requiere el token de ingesta y solo modifica derivados.
La ingesta nocturna recalcula el score sin sustituir notas, etapas o revisiones.

Pruebas: `node tests/source_sync.test.mjs`, `node tests/screening.test.mjs`,
`python3 -m unittest tests/test_nightly_refresh.py`, `python3 tests/radar_smoke.py`.
El último usa lecturas reales y escrituras interceptadas. La prueba en Sites usa
exclusivamente `bizacq-isolated-qa`, marcada explícitamente como ficha técnica.
`/qa-fixture` exige token y solo puede eliminar esa ficha cuando `is_test_record` es true.
