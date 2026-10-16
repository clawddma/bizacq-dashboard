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

## Afinidad preliminar y auditoría digital · revisión de octubre 15

`screen-v2` sustituye screen-v1 para la fase de prospección. El porcentaje de
cobertura de diligencia se retira. El score de afinidad se calcula sobre información
pública disponible: precio/ganancias (40), margen publicado (15), años de operación
(10), recurrencia declarada (10), delegación (10), encaje sectorial con IA/procesos
(10; hipótesis explícita) y financiación del vendedor anunciada (5). Pesos de
criterios desconocidos se excluyen del denominador. Se requiere precio y ganancia;
con menos de tres señales el score no supera 69. No se presume financiación SBA,
no se infiere SDE desde ingresos y no se fabrican retornos. Es una heurística
revisable de prospección, distinta del ranking completo documentado en los agentes.

Un anuncio antiguo publicado y observado puede ser elegible con alerta. URLs de
categoría, identidad sin coincidencia, bloqueos y páginas no disponibles conservan
su resultado de revalidación; no se interpretan como negocios vendidos ni provocan
movimientos de pipeline. `/portal-sync` con token solo actualiza evidencia/cifras
públicas y derivados. Notas, decisiones y órdenes quedan fuera de su contrato.

`cli/revalidate_portals.py` realiza la revisión acotada de las fichas pendientes:
seis conexiones máximas, una por dominio, pausa de dos segundos y sin reintentos
en 403/429. Los bloques se registran por fuente. HTML de evidencia y resultados
viven en `.nightly/revalidation/` (ignorado). Coincidencia de encabezado, no un 200
solo, identifica la ficha. Las páginas relacionadas no prueban la identidad.
`cli/portal_refresh.py` incorpora catálogos públicos accesibles y rota comprobaciones
nocturnas; cobertura parcial explícita. BizBuySell y BizQuest devuelven 403 a la
lectura local actual: observaciones realizadas por el conector web no equivalen a
sincronización nocturna completa. No se emplean proxies ni se sortean CAPTCHAs.

«Analizar oportunidad» ejecuta `auditDigitalOpportunity`: lee el anuncio, busca
candidatos de identidad y audita la web cuando hay URL atribuida al negocio. Una
coincidencia de búsqueda no confirma identidad y no se audita como si lo hiciera.
Detecta señales HTML de SEO básico, configuración móvil, reservas/cotización,
formularios, reseñas y redes. No prueba ranking SEO, funcionamiento de reservas,
tráfico ni reputación. Guarda observaciones y fuentes, hipótesis de ingresos,
automatización y control, línea base y piloto por palanca. Si la identidad es
confidencial o la fuente bloquea la lectura, registra la limitación. Elimina el
pedido de copiar instrucciones a Claude. No usa API paga ni LLM nocturno.

## Consulta en plataforma sin alertas · 15 octubre 2026

Daniel solicita consultar las ofertas en la plataforma, sin alertas ni dependencia
operativa del correo. Se retira `mail_alerts.py` de `nightly_refresh.py`. No se
configuran búsquedas guardadas, suscripciones de correo ni credenciales de buzón.
El prototipo del importador queda fuera del proceso automático.

Permanece la actualización local diaria a las 00:00 de Bogotá, bajo
`com.braindma.bizacq-refresh`, mediante fuentes públicas accesibles y el catálogo
oficial de Empire Flippers. El Mac debe estar despierto y con conexión. La ingesta
solo modifica datos públicos y derivados: notas, decisiones, etapas, documentos y
orden manual se conservan. Las fuentes inaccesibles o identidades no confirmadas
se mantienen en Por revalidar; no se presentan como disponibles verificadas.
BizBuySell y BizQuest todavía tienen cobertura automática limitada por sus bloqueos
HTTP: el retiro del correo no resuelve ese acceso ni activa una fuente alternativa.

## Vigencia automática y tarjetas · 15 octubre 2026

Sites es la interfaz principal mantenida. GitHub Pages conserva otra versión de
la interfaz y el mismo Worker/dataset; no representa otro pipeline. Un fragmento
`#deal=UUID` abre una ficha de la misma base en cualquiera de las interfaces.
Una pestaña que conserva JavaScript antiguo necesita recargarse tras un despliegue.

Se retiran de las tarjetas los bloques repetidos de comprobación/antigüedad. Queda
una línea sutil de publicación original cuando el portal la declara; de lo contrario,
«Fecha no informada». No se transforma la fecha de consulta o ingreso en publicación.
Los prefijos históricos `[Anuncio consultado ...]` se ocultan en títulos; el dato
original y la evidencia detallada permanecen disponibles.

La revisión nocturna cubre las fichas individuales activas no-Empire (tope 200,
actualmente suficiente), en vez de rotar solo 35. Se respeta el bloqueo por dominio.
Empire mantiene el catálogo oficial. La ausencia en un catálogo no prueba venta.
`applyAvailabilityObservation` descarta automáticamente desde RADAR, EN_ANALISIS,
PARA_CONTACTAR o EN_NEGOCIACION cuando la ficha individual coincidente indica
vendido o retirado y la observación incluye el texto de evidencia. Tres observaciones
404/410 en cortes diarios distintos descartan por enlace no disponible, sin afirmar
venta. Repetir un corte el mismo día no suma observaciones; una ficha publicada
reinicia el contador. Bloqueos, categorías, vejez o fallos temporales no disparan
venta ni descarte. CIERRE conserva la decisión del equipo. Reaparecer en un portal
no recupera automáticamente un descarte; la recuperación es manual.

El movimiento conserva notas, revisión, documentos y análisis; guarda motivo, estado
previo, fuente y evento de auditoría. No se sustituye un descarte humano existente.
El Radar depurado sigue excluyendo fichas cuya vigencia no se pudo demostrar.
No se garantiza cobertura total de portales bloqueados ni disponibilidad intradía.
Pruebas: `tests/availability.test.mjs`, `tests/test_portals.py`, contratos HTTP de
Worker, screening y smoke responsive 390/768/1440.

Si una ficha Empire desaparece del catálogo completo, la rutina de portales también
intenta leer su URL individual: solo evidencia explícita o tres 404/410 habilitan
el descarte, nunca la ausencia aislada en la API.

## Versión única y ficha financiera rápida · 16 octubre 2026

La única interfaz mantenida y publicada es Sites. La fuente canónica vive en
`web/index.html` y `web/economics.js`; `scripts/prepare_sites.py` copia solo esos
activos a Sites. `index.html` de la raíz es un redirect con `location.replace`,
conservando query y fragmento `#deal=UUID`. GitHub Pages publica exclusivamente la
rama `gh-pages` con `index.html` y `404.html` de reenvío; el código, los datos y los
scripts de main no se sirven como una segunda interfaz. Se verificó en navegador
que el enlace original de Flowers Bread Route abre el mismo UUID en Sites.

«Números para decidir» aparece al abrir cada oportunidad sin requerir análisis
histórico. Muestra precio, ganancia anual con base SDE/neto/flujo del broker,
ingresos y múltiplo. Prioriza hechos públicos observados sobre cifras heredadas.
Porcentaje del vendedor: solo si está publicado; si se anuncia financiación sin
porcentaje, se informa esa limitación. SBA se presenta como elegibilidad pendiente,
sin asumir crédito ni aprobar al comprador por una etiqueta. Regla oficial enlazada:
https://legacy.sba.gov/document/procedural-notice-5000-876626-revised-applicant-ownership-citizenship-residency-requirements-7a-504-loans

El simulador local incluye porcentajes de vendedor y banco convencional, tasas,
plazos, costos de cierre, capital de trabajo, sueldo de reemplazo y reserva. Calcula
cuota amortizada, aporte, flujo, cobertura orientativa, flujo/aporte y recuperación
simple sin crecimiento. Los valores iniciales son ejemplos editables, no ofertas;
no se guardan en CRM ni sustituyen análisis. Datos desconocidos no se reconstruyen
con márgenes inventados. Las estructuras y análisis legales heredados quedan bajo
secciones históricas plegadas. `tests/economics.test.mjs` valida fórmulas y ausencias;
`tests/redirect.test.mjs` valida reenvío de hashes y parámetros. El smoke prueba
interacción y geometría de la ficha en 390/768/1440 y conserva el negocio original.

Se corrigió la recuperación de comprobantes nocturnos: un éxito del día anterior
ya no se reetiqueta como consulta del día actual. `current_receipt` exige fecha de
inicio en el día de Bogotá, además del día del recibo y estado success. Se ejecutó
una consulta nueva el 16/oct: catálogo oficial de 9 páginas, 128 ofertas US en For
Sale; 176 comprobaciones de portales persistidas. Una comprobación fallida posterior
a una publicación mueve la ficha a Por revalidar, sin descartarla por un bloqueo.

Resultado observado tras la revisión: 328 registros, 228 anuncios activos publicados,
95 activos sin vigencia confirmada, 4 descartados y 1 en cierre. Los 95 incluyen
54 identidades sin resolver, 33 bloqueos, 6 inmuebles y 2 enlaces 404/410. No se
confunden con ventas. El recuento de Por revalidar excluye terminales. Notas,
revisiones y documentos del inventario inicial se conservaron; un movimiento manual
RADAR→EN_ANALISIS recibido durante el trabajo se respetó. La reconstrucción final
solo modificó derivados y preservó etapas, eventos, motivos y orden manual.
Evidencia privada: `.nightly/oct16-final-verification.json`, run
`cf0de634-0df4-4888-a23b-276c73af2265`; publicación y vigencia comercial son distintas.
