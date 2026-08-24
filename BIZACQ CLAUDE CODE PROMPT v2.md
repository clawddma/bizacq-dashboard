# BizAcq Intelligence — Claude Code Foundation Prompt v2.0

## Sistema Autónomo de Identificación y Adquisición de Negocios Rentables

### Texas & Florida | Dashboard-First | Token-Efficient

-----

> **Cómo usar este prompt:** Pégalo completo como el primer mensaje en tu proyecto de Claude Code. Define toda la arquitectura, los agentes, el pipeline CRM y las convenciones desde el día 1.

-----

## MISIÓN DEL PROYECTO

Construye **BizAcq Intelligence** — un sistema multi-agente que encuentra, analiza y prioriza oportunidades de compra de negocios en Texas y Florida, controlado completamente desde un dashboard tipo CRM.

Tres criterios no negociables en toda la lógica de selección:

1. **El negocio genera caja desde el día 1** — SDE positivo, probado, con historial.
1. **La compra se puede financiar con la misma operación** — seller financing, SBA, o estructura donde el negocio paga su propia deuda de adquisición (DSCR ≥ 1.25x).
1. **Tiene potencial de mejora con IA** — para venderlo después a 2x–4x el precio de compra.

Todo lo que el sistema encuentra, analiza y prioriza se gestiona desde un **dashboard único**. No hay Telegram, no hay reportes por correo, no hay canales externos. El dashboard ES el sistema de control.

-----

## STACK TECNOLÓGICO

- **Backend:** Python 3.12+ con FastAPI
- **Agentes:** LangGraph (flujos cíclicos con estado persistente)
- **LLM:** Anthropic Claude API
  - `claude-haiku-4-5` → Filtrado rápido, clasificaciones, extracción de datos (bajo costo)
  - `claude-sonnet-4-20250514` → Análisis financiero profundo y estrategia M&A (solo cuando el deal pasa filtros)
- **Base de datos:** PostgreSQL + Redis (caché y cola de tareas)
- **Scraping:** Playwright + BeautifulSoup + rate limiting por dominio
- **Frontend:** Next.js + Tailwind CSS (dashboard CRM)
- **API interna:** FastAPI
- **Scheduling:** APScheduler
- **Sin dependencias de Telegram, email, o canales externos**

-----

## ESTRATEGIA DE CONSUMO DE TOKENS — REGLA FUNDAMENTAL

**Los agentes con LLM solo se activan cuando el deal pasa el filtro anterior.**

```
ScoutAgent      → SIN LLM (scraping puro, código Python)
FilterAgent     → SIN LLM (reglas duras, lógica Python, costo $0)
FinancialAgent  → Haiku SOLO si FilterAgent aprueba (bajo costo)
StrategyAgent   → Sonnet SOLO si financial_score > 55 (costo justificado)
RankingAgent    → SIN LLM (fórmula matemática, costo $0)
MonitorAgent    → SIN LLM (comparación de datos, costo $0)
```

Esto significa que el 80–90% de los listings encontrados nunca consumen un token de LLM. Solo los deals que realmente tienen potencial activan análisis con IA.

**Regla adicional de prompting:**

- Prompts cortos y directos. Máximo 400 tokens de input por llamada a Haiku.
- Para Sonnet: el prompt incluye SOLO los datos relevantes del deal, no texto completo del listing.
- Siempre pedir respuesta en JSON estructurado para evitar parsing costoso.
- Cachear resultados de análisis — si un deal ya fue analizado, no re-analizar a menos que haya un cambio relevante (precio, datos financieros).

-----

## PIPELINE CRM — ESTADOS DEL DEAL

Este es el corazón del dashboard. Cada deal tiene exactamente uno de estos 6 estados en todo momento:

```
[ RADAR ] → [ EN ANÁLISIS ] → [ PARA CONTACTAR ] → [ EN NEGOCIACIÓN ] → [ CIERRE ] → [ DESCARTADO ]
```

### Descripción de cada estado:

**RADAR** — *“Lo encontramos, cumple lo básico”*

- El deal pasó los filtros automáticos duros (estado, precio, SDE mínimo, múltiplo).
- Aún no ha sido analizado financieramente.
- Acción disponible para el usuario: “Analizar” (activa FinancialAgent + StrategyAgent) o “Descartar”.
- El sistema puede mover deals de RADAR a EN ANÁLISIS automáticamente según scoring previo.

**EN ANÁLISIS** — *“Los agentes lo están revisando”*

- FinancialAgent y StrategyAgent están procesando o ya produjeron resultados.
- El usuario ve el score general, los números clave y el veredicto en lenguaje simple.
- Acción disponible: “Pasar a Contactar”, “Volver a Radar”, o “Descartar”.

**PARA CONTACTAR** — *“Está bueno, hay que hablar con el vendedor”*

- El usuario o su socio decidieron que vale la pena contactar al broker/vendedor.
- El sistema muestra los datos de contacto del listing y sugiere los puntos clave a preguntar.
- Acción disponible: “Pasé a Negociación” o “Descartar”.

**EN NEGOCIACIÓN** — *“Estamos hablando con ellos”*

- Conversación activa con el vendedor o broker.
- El usuario puede agregar notas manuales.
- El sistema mantiene el historial de cambios en el listing (precio, condiciones).
- Acción disponible: “Cerrado” o “Descartar”.

**CIERRE** — *“Deal cerrado o en due diligence final”*

- Registro histórico del deal ganado.
- Muestra el resumen financiero del deal cerrado.

**DESCARTADO** — *“No aplica”*

- Deals que no siguieron adelante, con razón de descarte registrada.
- Visible en historial, filtrable, para aprender de patrones.

-----

## AGENTES DEL SISTEMA

### AGENTE 1 — `ScoutAgent`

**Qué hace:** Encuentra negocios en venta en TX y FL.
**Cómo:** Scraping automatizado de fuentes configuradas, sin usar LLM.

Fuentes a monitorear (extensible vía `config.yaml`):

- `bizbuysell.com` — filtrado por TX y FL
- `bizquest.com` — mismo filtro
- `flippa.com` — negocios digitales con flujo verificado
- `empireflippers.com` — marketplaces digitales
- `loopnet.com` — solo listings que incluyan operación + real estate

Extrae por listing (sin LLM, solo parsing HTML/JSON):

- URL, título, precio de venta, ingresos anuales, EBITDA/SDE reportado, tipo de negocio, ciudad, estado, años en operación, razón de venta, si acepta seller financing, si está pre-calificado SBA, y texto completo de la descripción.

Detecta duplicados por URL. Persiste en DB con timestamp y fuente. Emite evento a cola para FilterAgent.

Rate limiting: configurable por dominio. Rotación de User-Agent. Soporte para cookies manuales si el sitio requiere login.

-----

### AGENTE 2 — `FilterAgent`

**Qué hace:** Descarta automáticamente los que no cumplen. Sin LLM, costo $0.
**Criterio:** Si no pasa, va directo a DESCARTADO. Si pasa, va a RADAR en el dashboard.

Descarta si cualquiera de estas condiciones se cumple:

- Estado ≠ TX o FL
- Precio de venta > $5M (configurable: `MAX_DEAL_SIZE`)
- SDE/EBITDA negativo o no reportado Y negocio < 2 años de operación
- Múltiplo precio/SDE > 4.5x
- Categoría en blacklist: MLM, esquemas de distribución, negocios sin operación física o digital clara
- Descripción tiene < 100 palabras (listing vacío/incompleto)

Si pasa todos los filtros: crea el deal en estado **RADAR** con un `filter_score` calculado (sin LLM).

El `filter_score` es una puntuación rápida basada en:

- ¿Tiene seller financing? (+15 pts)
- ¿Está pre-calificado SBA? (+10 pts)
- ¿Tiene > 3 años de operación? (+10 pts)
- ¿Precio/SDE < 3x? (+15 pts)
- ¿Industria en lista de alto potencial de IA? (+10 pts)

-----

### AGENTE 3 — `FinancialAnalystAgent`

**Qué hace:** Construye el modelo financiero del deal. Usa Haiku (bajo costo).
**Se activa:** Solo cuando el usuario hace clic en “Analizar” desde RADAR, o automáticamente si `filter_score` > 70.

**Input al LLM:** Solo los datos estructurados del deal (no el texto crudo completo). Prompt ≤ 400 tokens.

**Output esperado (JSON):**

```json
{
  "reconstructed_sde": 180000,
  "dscr": 1.42,
  "cash_on_cash_y1": 0.18,
  "payback_years": 4.2,
  "seller_financing": true,
  "sba_eligible": true,
  "suggested_structure": {
    "equity_pct": 10,
    "sba_loan_pct": 80,
    "seller_note_pct": 10,
    "estimated_monthly_debt_service": 8200
  },
  "self_financing_score": 78,
  "financial_score": 72,
  "risk_flags": ["Posible dependencia del dueño actual", "Sin historial de clientes recurrentes"],
  "plain_summary": "El negocio genera $180K al año limpio. Con 10% de entrada ($45K), el préstamo SBA cubre el resto y el negocio mismo paga la deuda con margen. Si el dueño se va, hay riesgo de caída de operación."
}
```

El campo `plain_summary` es lo que ve el usuario en el dashboard — lenguaje humano, sin jerga.

**Lógica financiera (Python puro, sin LLM):**

- Reconstrucción de SDE con add-backs estándar.
- Proyecciones de caja a 3 y 5 años (conservador / base / optimista).
- DSCR con estructura de deuda sugerida.
- Elegibilidad SBA 7(a) y SBA 504.
- Cálculo de equity requerido y retorno sobre equity.

-----

### AGENTE 4 — `StrategyAgent`

**Qué hace:** Evalúa el potencial estratégico y el upside con IA. Usa Sonnet.
**Se activa:** Solo si `financial_score` > 55. Deals que no pasan ese umbral no consumen tokens de Sonnet.

**Input al LLM:** Datos financieros ya procesados + descripción resumida del negocio (no texto crudo). Prompt ≤ 600 tokens.

**Output esperado (JSON):**

```json
{
  "buy_thesis": [
    "Negocio de servicios HVAC con 8 años en operación y clientes recurrentes en Houston",
    "Flujo de caja estable con bajo riesgo estacional",
    "Owner quiere retirarse — motivación real de venta"
  ],
  "ai_upside": {
    "score": 82,
    "opportunities": [
      "Automatizar agendamiento y seguimiento de clientes (ahorro estimado: 15h/semana)",
      "Pricing dinámico por zona y temporada",
      "Sistema de mantenimientos preventivos con recordatorios automáticos"
    ],
    "value_multiplier_estimate": "2.5x – 3.5x en 3 años"
  },
  "exit_profile": "Reventa a operador regional o PE de servicios de hogar",
  "red_flags": ["Equipo técnico de 3 personas — riesgo si se van"],
  "strategic_score": 74,
  "plain_summary": "Buen negocio de HVAC con clientes fijos. Si automatizamos el agendamiento y el seguimiento, puede valer 2.5 a 3.5 veces lo que pagamos en 3 años. El riesgo es que tiene pocos técnicos clave."
}
```

-----

### AGENTE 5 — `RankingAgent`

**Qué hace:** Calcula el score final y asigna prioridad. Sin LLM, costo $0.

Fórmula (pesos configurables en `config.yaml`):

```
overall_score = (
  financial_score     × 0.35 +
  self_financing_score × 0.25 +
  ai_upside_score     × 0.20 +
  strategic_score     × 0.20
)
```

Prioridad visible en el dashboard:

- **🔥 ALTA (≥ 80):** Moverlo a EN ANÁLISIS de inmediato si no está ya.
- **⚡ MEDIA (60–79):** Revisar esta semana.
- **👀 BAJA (40–59):** Watchlist — monitorear cambios.
- **❌ DESCARTAR (< 40):** Mover a DESCARTADO automáticamente.

-----

### AGENTE 6 — `MonitorAgent`

**Qué hace:** Vigila cambios en los deals activos. Sin LLM, costo $0.
**Se activa:** Cada 48 horas para deals en RADAR, EN ANÁLISIS, y PARA CONTACTAR.

Detecta:

- Bajada de precio > 10% → re-score automático + badge de alerta en el dashboard.
- Listing eliminado → marca como “Vendido / Expirado”, mueve a DESCARTADO con nota automática.
- Cambio en condiciones de seller financing → actualiza el registro y genera alerta visible.

Mantiene historial completo de cambios por deal en la DB.

-----

## DASHBOARD — DISEÑO DEL CRM

El dashboard es la única interfaz de control. Diseña con estas vistas:

### Vista Principal — Pipeline CRM

- **Columnas Kanban** una por cada estado: RADAR / EN ANÁLISIS / PARA CONTACTAR / EN NEGOCIACIÓN / CIERRE / DESCARTADO.
- Cada deal es una card que muestra:
  - Nombre del negocio y tipo.
  - Ciudad, Estado (badge TX o FL).
  - Precio de venta y SDE reportado.
  - Score general (número + color: verde/amarillo/rojo).
  - Badge de prioridad: 🔥 Alta / ⚡ Media / 👀 Baja.
  - Badge de alerta si hay cambio reciente (price drop, etc.).
  - Fecha de entrada al sistema.
- Las cards son arrastrables entre columnas (drag & drop) para que el usuario mueva deals manualmente.
- Clic en una card abre el panel de detalle.

### Panel de Detalle del Deal

Organizado en secciones simples, lenguaje claro:

**Sección: ¿Qué es este negocio?**

- Tipo, ubicación, años de operación, razón de venta.
- Link al listing original.

**Sección: Los números clave**

- Precio de venta | SDE anual | Múltiplo precio/SDE
- ¿El negocio paga su propia deuda? → DSCR en formato humano: “Sí, genera $1.42 por cada $1 que debe pagar de crédito.”
- Retorno sobre lo que pones de tu bolsillo (año 1, año 3).
- ¿Cuántos años para recuperar la inversión?

**Sección: ¿Cómo se compra sin poner todo el dinero?**

- Estructura sugerida: “10% tuyo ($45K), 80% banco SBA, 10% el vendedor te financia.”
- Pago mensual estimado de la deuda.
- Si califica seller financing: destacarlo visualmente.
- Si califica SBA: destacarlo con enlace a info SBA.

**Sección: Potencial con IA**

- Score de upside (0–100) con explicación en 2 líneas.
- Las 3 mejores oportunidades de automatización.
- Estimado de valor de reventa: “En 3 años, podría valer entre 2.5x y 3.5x lo que pagaste.”

**Sección: Riesgos a tener en cuenta**

- Lista de flags en lenguaje simple. Ej: “El dueño lleva la operación solo — hay que planear la transición.”

**Sección: Notas**

- Campo de texto libre para que el usuario o su socio agreguen notas.
- Las notas se guardan con timestamp y son visibles para ambos.

**Sección: Historial de cambios**

- Timeline de eventos: cuándo fue encontrado, cuándo cambió de precio, cuándo fue analizado, etc.

### Barra de filtros global

Siempre visible en la parte superior:

- Filtro por Estado: TX / FL / Ambos
- Filtro por Prioridad: Alta / Media / Baja
- Filtro por Tipo de negocio (dropdown con categorías)
- Filtro por Rango de precio
- Filtro por ¿Acepta seller financing? (toggle)
- Filtro por ¿Califica SBA? (toggle)
- Ordenar por: Score, Precio, Fecha, Múltiplo

### Panel de Control (sidebar o header)

- Contador de deals por estado.
- Botón: “Buscar ahora” (activa ScoutAgent manualmente).
- Botón: “Analizar todos en RADAR” (activa FinancialAgent en batch para los pendientes).
- Indicador de última búsqueda completada.
- Indicador de tokens consumidos esta semana (para control de costos).

-----

## LENGUAJE DEL SISTEMA — REGLA CRÍTICA

**Los agentes son rigurosos internamente. El dashboard habla como personas.**

Mapa de traducción obligatorio para todo texto visible al usuario:

|Término técnico                      |Lo que muestra el dashboard                                      |
|-------------------------------------|-----------------------------------------------------------------|
|SDE (Seller’s Discretionary Earnings)|“Lo que genera el negocio al año”                                |
|DSCR 1.42x                           |“El negocio genera $1.42 por cada $1 de deuda — bien cubierto”   |
|Múltiplo precio/SDE 2.8x             |“Pagas 2.8 años de ganancias por el negocio”                     |
|Cash-on-cash return 18%              |“Recuperas 18% de lo que pusiste de tu bolsillo en el primer año”|
|Seller financing                     |“El vendedor te financia parte del precio”                       |
|SBA 7(a) eligible                    |“Califica para crédito SBA (hasta 90% del precio)”               |
|AI upside score 82                   |“Alto potencial de mejora con tecnología”                        |
|EBITDA                               |“Ganancia operativa antes de impuestos”                          |
|Payback period 4.2 años              |“Recuperas tu inversión en ~4 años”                              |
|IRR 28%                              |“Retorno total de tu dinero: 28% anual”                          |

Cada `plain_summary` generado por los agentes debe seguir este tono: claro, directo, sin jerga, máximo 3 oraciones. El usuario debe poder leerlo en 10 segundos y saber si le interesa o no.

-----

## ESTRUCTURA DE DIRECTORIOS

```
bizacq/
├── agents/
│   ├── prompts/                    # System prompts como archivos .txt separados
│   │   ├── financial_analyst.txt
│   │   └── strategy.txt
│   ├── scout_agent.py
│   ├── filter_agent.py
│   ├── financial_analyst_agent.py
│   ├── strategy_agent.py
│   ├── ranking_agent.py
│   └── monitor_agent.py
├── core/
│   ├── models.py                   # Pydantic: Deal, DealFinancials, DealStrategy
│   ├── database.py                 # SQLAlchemy async + PostgreSQL
│   ├── queue.py                    # Redis queue
│   ├── config.py                   # Pydantic Settings desde .env
│   └── llm_client.py               # Anthropic client con retry + token tracking
├── scrapers/
│   ├── base_scraper.py
│   ├── bizbuysell.py
│   ├── bizquest.py
│   ├── flippa.py
│   ├── empire_flippers.py
│   └── loopnet.py
├── financial/
│   ├── sde_calculator.py
│   ├── dscr_model.py
│   ├── cash_flow_model.py
│   └── sba_eligibility.py
├── api/
│   ├── main.py
│   └── routers/
│       ├── deals.py                # CRUD de deals, cambios de estado
│       ├── pipeline.py             # Kanban state management
│       ├── agents.py               # Trigger manual de agentes
│       └── stats.py                # Contadores, token usage
├── frontend/                       # Next.js
│   ├── components/
│   │   ├── Pipeline/               # Kanban board
│   │   ├── DealCard/               # Card del deal
│   │   ├── DealDetail/             # Panel lateral de detalle
│   │   └── Filters/                # Barra de filtros
│   └── pages/
│       └── index.tsx               # Una sola página — el dashboard
├── scheduler/
│   └── jobs.py
├── tests/
│   ├── test_agents/
│   ├── test_scrapers/
│   └── test_financial/
├── docker/
│   ├── Dockerfile
│   └── docker-compose.yml
├── migrations/                     # Alembic
├── config.yaml
├── .env.example
├── requirements.txt
└── README.md
```

-----

## ESQUEMA DE BASE DE DATOS

```sql
-- deals: registro maestro de cada oportunidad
deals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source          VARCHAR(50) NOT NULL,        -- 'bizbuysell', 'flippa', etc.
  source_url      TEXT UNIQUE NOT NULL,
  title           TEXT,
  state           CHAR(2),                     -- 'TX', 'FL'
  city            VARCHAR(100),
  asking_price    NUMERIC(15,2),
  reported_revenue NUMERIC(15,2),
  reported_sde    NUMERIC(15,2),
  business_type   VARCHAR(200),
  years_operation INT,
  seller_financing BOOLEAN DEFAULT false,
  sba_prequalified BOOLEAN DEFAULT false,
  raw_description TEXT,
  -- CRM pipeline
  pipeline_status VARCHAR(30) DEFAULT 'RADAR',
  -- 'RADAR','EN_ANALISIS','PARA_CONTACTAR','EN_NEGOCIACION','CIERRE','DESCARTADO'
  discard_reason  TEXT,
  -- Scores
  filter_score    NUMERIC(5,2),
  overall_score   NUMERIC(5,2),
  priority        VARCHAR(10),                 -- 'ALTA','MEDIA','BAJA'
  -- Control
  last_seen_at    TIMESTAMPTZ,
  listed_at       DATE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- deal_financials: resultado del FinancialAnalystAgent
deal_financials (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id               UUID REFERENCES deals(id) ON DELETE CASCADE,
  reconstructed_sde     NUMERIC(15,2),
  dscr                  NUMERIC(5,3),
  cash_on_cash_y1       NUMERIC(5,3),
  cash_on_cash_y3       NUMERIC(5,3),
  payback_years         NUMERIC(4,1),
  equity_required       NUMERIC(15,2),
  suggested_structure   JSONB,
  projections           JSONB,
  self_financing_score  NUMERIC(5,2),
  financial_score       NUMERIC(5,2),
  sba_eligible          BOOLEAN,
  risk_flags            TEXT[],
  plain_summary         TEXT,
  analyzed_at           TIMESTAMPTZ DEFAULT NOW()
);

-- deal_strategy: resultado del StrategyAgent
deal_strategy (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id               UUID REFERENCES deals(id) ON DELETE CASCADE,
  buy_thesis            TEXT[],
  ai_opportunities      TEXT[],
  ai_upside_score       NUMERIC(5,2),
  value_multiplier_low  NUMERIC(4,2),
  value_multiplier_high NUMERIC(4,2),
  exit_profile          TEXT,
  red_flags             TEXT[],
  strategic_score       NUMERIC(5,2),
  plain_summary         TEXT,
  analyzed_at           TIMESTAMPTZ DEFAULT NOW()
);

-- deal_events: historial de cambios automáticos
deal_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id     UUID REFERENCES deals(id) ON DELETE CASCADE,
  event_type  VARCHAR(50),  -- 'price_drop','status_change','listing_removed','rescored'
  description TEXT,         -- Descripción en lenguaje simple
  old_value   JSONB,
  new_value   JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- deal_notes: notas manuales del usuario/socio
deal_notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id     UUID REFERENCES deals(id) ON DELETE CASCADE,
  author      VARCHAR(100),   -- 'Daniel', 'Socio', etc.
  note        TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- token_usage: tracking de consumo de LLM
token_usage (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id     UUID REFERENCES deals(id),
  agent       VARCHAR(50),
  model       VARCHAR(50),
  input_tokens  INT,
  output_tokens INT,
  cost_usd    NUMERIC(10,6),
  called_at   TIMESTAMPTZ DEFAULT NOW()
);
```

-----

## CONFIGURACIÓN — `config.yaml`

```yaml
acquisition:
  target_states: ["TX", "FL"]
  max_deal_size_usd: 5_000_000
  min_sde_usd: 75_000
  min_years_operation: 2
  max_price_sde_multiple: 4.5
  min_dscr: 1.25

scoring_weights:
  financial_score: 0.35
  self_financing_score: 0.25
  ai_upside_score: 0.20
  strategic_score: 0.20

priority_thresholds:
  alta: 80
  media: 60
  baja: 40

auto_analyze_filter_score_threshold: 70   # Si filter_score > 70, analiza automáticamente

scraping:
  sources:
    - name: bizbuysell
      enabled: true
      interval_hours: 24
      rate_limit_seconds: 3
    - name: bizquest
      enabled: true
      interval_hours: 24
      rate_limit_seconds: 3
    - name: flippa
      enabled: true
      interval_hours: 48
      rate_limit_seconds: 5
    - name: empire_flippers
      enabled: true
      interval_hours: 48
      rate_limit_seconds: 5
    - name: loopnet
      enabled: false
      interval_hours: 72
      rate_limit_seconds: 5

blacklist_categories:
  - "MLM"
  - "Multi-Level Marketing"
  - "Vending Machine Routes"
  - "ATM Business"

ai_upside_high_potential_industries:
  - "HVAC"
  - "Plumbing"
  - "Electrical"
  - "Landscaping"
  - "Cleaning Services"
  - "E-commerce"
  - "SaaS"
  - "Digital Marketing Agency"
  - "Insurance Agency"
  - "Accounting"
  - "Med Spa"
  - "Dental Practice"
  - "Auto Repair"
  - "Pest Control"
  - "Pool Service"

llm:
  haiku_model: "claude-haiku-4-5"
  sonnet_model: "claude-sonnet-4-20250514"
  financial_agent_model: "haiku"
  strategy_agent_model: "sonnet"
  strategy_activation_threshold: 55   # financial_score mínimo para activar Sonnet
  max_input_tokens_haiku: 400
  max_input_tokens_sonnet: 600
```

-----

## REGLAS DE DESARROLLO

### Código

1. Type hints en todas las funciones. Pydantic para todos los modelos de datos.
1. Todas las operaciones de I/O (scraping, DB, LLM) son `async`.
1. Toda llamada a API externa usa `tenacity` con exponential backoff (3 intentos).
1. Logging estructurado con `structlog`. Nivel configurable por agente.
1. Tests unitarios con `pytest` para toda la lógica financiera.
1. Secrets únicamente desde `.env` vía `pydantic-settings`. Nunca hardcodeados.
1. Los agentes capturan excepciones y las loguean sin crashear el pipeline.

### LLM / Tokens

1. System prompts en archivos `.txt` en `agents/prompts/`. Nunca inline.
1. Respuestas siempre en JSON con schema definido. Validar con Pydantic antes de usar.
1. Registrar tokens consumidos en tabla `token_usage` después de cada llamada.
1. Haiku para FinancialAgent. Sonnet solo para StrategyAgent cuando `financial_score` > 55.
1. Cachear resultados: si un deal ya tiene `deal_financials` y los datos del listing no cambiaron, no re-analizar.

### Base de datos

1. Alembic para todas las migraciones. Nunca modificar tablas manualmente.
1. Operaciones multi-tabla en transacciones explícitas.

### Git

1. Commits semánticos: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`.

-----

## ORDEN DE IMPLEMENTACIÓN

**Fase 1 — Fundación**

1. Setup: `pyproject.toml`, `requirements.txt`, estructura de directorios completa.
1. `docker-compose.yml` con PostgreSQL + Redis.
1. `core/config.py` con Pydantic Settings.
1. `core/models.py` con todos los modelos Pydantic.
1. `core/database.py` con SQLAlchemy async.
1. Alembic init + primera migración con esquema completo.
1. `core/llm_client.py` con Anthropic client + token tracking.

**Fase 2 — Scraping**
8. `scrapers/base_scraper.py` con rate limiting y retry.
9. `scrapers/bizbuysell.py` con filtro TX/FL nativo.
10. `scrapers/bizquest.py` — mismo patrón.
11. Tests de scrapers con HTML fixtures.

**Fase 3 — Agentes**
12. `agents/filter_agent.py` — reglas duras + filter_score sin LLM.
13. `financial/` — sde_calculator, dscr_model, cash_flow_model, sba_eligibility.
14. `agents/financial_analyst_agent.py` — Haiku + lógica Python.
15. `agents/strategy_agent.py` — Sonnet con umbral de activación.
16. `agents/ranking_agent.py` — fórmula matemática + asignación de prioridad.
17. `agents/monitor_agent.py` — comparación de datos sin LLM.

**Fase 4 — API**
18. `api/main.py` + todos los routers.
19. `scheduler/jobs.py` con APScheduler.

**Fase 5 — Dashboard**
20. Next.js: Kanban Pipeline con drag & drop.
21. Panel de detalle del deal con todas las secciones.
22. Barra de filtros global.
23. Panel de control (counters, trigger manual, token usage).

-----

## ENTREGABLES ESPERADOS AL FINALIZAR FASE 1

- `docker-compose up` levanta sin errores.
- PostgreSQL y Redis conectados y funcionales.
- Configuración desde `.env` funcionando correctamente.
- Migraciones de Alembic ejecutadas con esquema completo.
- Tests de modelos Pydantic pasando.
- `llm_client.py` capaz de hacer una llamada de prueba a Haiku y registrar el uso.
- `README.md` con instrucciones completas de setup local.

**Empieza por Fase 1. Antes de escribir código, confirma el stack final y señala cualquier cambio arquitectural que recomiendes con su justificación. Luego implementa la Fase 1 completa.**

-----

*BizAcq Intelligence v2.0 — Dashboard-first, token-efficient, plain language*
*Focus: Self-financing acquisitions in TX & FL with AI upside for 2x–4x exit*