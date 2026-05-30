# BizAcq Intelligence — Handover de Proyecto

> Contexto operativo para retomar BizAcq en una nueva sesión de Claude Code.
> Última actualización: 2026-05-30 · Versión deals.json: 0.16.0-martins-corrected
> Modelo previo: Opus 4.7 (1M context) · Sesión cerrada para upgrade a Opus 4.8

---

## TL;DR — qué es esto y cómo retomar

Sistema multi-agente de adquisición de negocios SMB en EE.UU. para Daniel Mesa (ES) + socio (MX). Dashboard CRM con auto-sync vía Cloudflare Worker. 40 deals reales en 12 estados. **Free-tier, $0/mes.**

**Antes de hacer cualquier cambio:**
```bash
cd /Users/braindma/bizacq && git pull --rebase
```
El Worker commitea desde el dashboard cuando el socio agrega/mueve cosas — siempre arrancar con `git pull`.

---

## URLs y endpoints vivos

| Componente | URL | Estado |
|---|---|---|
| Dashboard (usuario) | https://clawddma.github.io/bizacq-dashboard/ | ✅ vivo |
| Worker (backend API) | https://bizacq-api.clawddma.workers.dev | ✅ vivo |
| Repo (source of truth) | https://github.com/clawddma/bizacq-dashboard | ✅ |
| Worker status page | https://bizacq-api.clawddma.workers.dev/ | ✅ muestra "🟢 BizAcq API activo" + conteo |

### Endpoints del Worker
- `GET /health` → ping
- `GET /deals` → proxy de `deals.json` desde GitHub raw (siempre fresco)
- `GET /` → página HTML de status (para humanos)
- `POST /add-deal` → agregar lead crudo (estado PENDIENTE_ANALISIS)
- `POST /update-deal` → cambiar pipeline_status, manual_orders, notes
- `POST /request-analysis` → marcar deal con `deep_analysis_requested: true`

Protección: Origin allowlist + rate limit 30/h (si KV configurado) + payload validation.

---

## Arquitectura

```
┌────────────────────────────────────────────────────┐
│ Dashboard (GitHub Pages — estático monolítico)     │
│ https://clawddma.github.io/bizacq-dashboard/       │
│ - HTML + Tailwind + Alpine.js (un solo index.html) │
│ - "+ Agregar negocio" → POST Worker /add-deal      │
│ - Drag-and-drop → POST Worker /update-deal         │
│ - "🔬 Analizar a fondo" → POST /request-analysis   │
└────────────────────┬───────────────────────────────┘
                     │ fetch (CORS allowlist)
                     ▼
┌────────────────────────────────────────────────────┐
│ Cloudflare Worker (cloudflare/worker.js)           │
│ bizacq-api.clawddma.workers.dev                    │
│ Secrets: GITHUB_TOKEN (set), GEMINI_API_KEY (TODO) │
│ - Valida origin + rate limit                       │
│ - Commit a GitHub Contents API                     │
└────────────────────┬───────────────────────────────┘
                     │ GitHub Contents API
                     ▼
┌────────────────────────────────────────────────────┐
│ GitHub: clawddma/bizacq-dashboard                  │
│ data/deals.json = SOURCE OF TRUTH (versionado)     │
│ Yo (Claude) accedo vía `git pull` — sin cambios    │
└────────────────────────────────────────────────────┘
```

**Por qué este patrón** (Worker proxy → GitHub):
- Tú/socio escriben sin token en browser
- Yo accedo vía git (sin nuevo flujo)
- Versionado/auditable (cada cambio es un commit)
- $0/mes (Worker free tier)

---

## Estado del producto al 2026-05-30

### 40 deals reales en 12 estados
| Estado | Count | Notas |
|---|---|---|
| TX | 11 | core target original |
| FL | 9 | core target + Wellnature (lead socio) |
| AZ | 4 | Phoenix Exterior, Auto Glass, Insurance, Outdoor Living |
| MA | 3 | Boston: UPS Store, Mission's/Martin's bread routes |
| NV | 2 | LV Diesel Truck, Reno Landscape |
| TN | 2 | bread routes Nashville/Chattanooga |
| GA | 2 | descartados (múltiplo alto) |
| NC | 1 | Martin's Bread Route Cary (corregido) |
| CO | 1 | Bar Grill Boulder |
| OR | 1 | FedEx Routes Portland |
| NY | 1 | Landscaping Buffalo (TEA) |
| WI | 1 | Vet Urgent Care Milwaukee |
| WY | 1 | Skincare WY (RED FLAG: inventory $14M sospechoso) |

### Features del dashboard
- Kanban 6 columnas: RADAR / EN_ANALISIS / PARA_CONTACTAR / EN_NEGOCIACION / CIERRE / DESCARTADO
- Drag-and-drop (entre columnas + reorden vertical) con auto-sync vía Worker
- Filtros multi-select ACUMULABLES: Estados (51) · Precio (5 buckets) · SDE absoluto (5) · Margen % (4) · Múltiplo (4) · Prioridad · Score mínimo (slider, default 75)
- Pestañas: Pipeline / Por categoría (jerárquica super → sub) / Glosario (40+ términos)
- KPI bar superior estilo OET: deals activos · valor pipeline · SDE total · prioridad alta · score promedio
- Detail panel con secciones de confianza etiquetada (📊 verified / 🧮 calculated / 📈 benchmark / 🔍 inferred)
- "Compartir link al socio" — deep linking con `#deal=UUID`
- Filtro "📥 Solo cargados manualmente" — distingue leads del scraping vs leads del socio
- Botón "+ Agregar negocio" → modo Worker (instant) o fallback clipboard
- Botón "🔬 Analizar a fondo" → marca deal (estados: 🔬 pedir → ⏳ solicitado → ✓ verificado)
- Responsive: desktop grid 6 cols, mobile scroll horizontal snap
- Lecturas pendientes del análisis: badge ⏳ pendiente / ⏳ solicitado en cards

### Pipeline de análisis (qué hace cada subagente)
- `scout` (TODO) → Playwright stealth scrapers (NO implementado en producción, sólo skill)
- `filter` → reglas duras (Python conceptual, hoy hecho a mano por mí)
- `financial` → DSCR, payback, structure SBA/seller/bank, scores
- `strategy` → buy_thesis, ai_upside, exit_profile, red_flags
- `ranking` → fórmula overall_score (financial 0.30 + self_fin 0.20 + ai_upside 0.15 + strategic 0.15 + legal 0.20)
- `monitor` (TODO) → diff de listings (no implementado)
- `legal` → feasibility (OK/WARN/BLOCKED), informative_requirements, EB-5 viability
- `eb5-advisor` → TEA + jobs + investment minimum + path recommendation
- `fact-checker` → bases públicas (Census, SBA FOIA, SOS, PACER, OpenCorporates) — invocado on-demand

---

## Decisiones clave (no revertir sin razón)

1. **Cloudflare Worker como write-proxy**, NO backend tradicional. Token en secret, no en browser. Origin allowlist.
2. **NO Anthropic API en proyectos personales** ([[feedback_max_no_api]]). LLMs gigantes son YO (en chat) o vía routines del Max de Daniel. Próxima vía: Gemini API (free tier) para fact-check tiempo real.
3. **GitHub deals.json como source of truth** — yo accedo vía git, versionado/auditable. NO mover a KV/D1.
4. **Perfil migratorio del comprador** ([[bizacq_perfil_compradores]]): ES+MX, sin LPR. SBA bloqueado, E-2 viable, EB-5 posible para deals > $800K. Aplicar en TODOS los legal_check.
5. **Filter rules**: SDE > $75K, múltiplo < 4.5x. Excepción razonable: bread routes con cash recurring (Martin's Cary SDE $54K se quedó RADAR con flag explícito).
6. **target_states: []** (todos los 50 estados) — `preferred_states: ["TX","FL"]` solo da bonus de scoring.
7. **Iconos de confianza**: 📊 verified (listing) / 🧮 calculated (math) / 📈 benchmark (industria) / 🔍 inferred (mi hipótesis) — visible en detail panel.
8. **Escritura "abierta"** (sin write-key) por elección de Daniel + protección con Origin + rate limit + payload validation.

---

## Lo pendiente (en orden de prioridad)

### 🔥 #1 — Gemini /analyze endpoint (fact-check tiempo real)
Daniel propuso (correctamente) usar **Gemini 2.5 Flash con Google Search grounding** en el Worker para que el botón "Analizar más a fondo" sea verdaderamente tiempo real (sin routine, sin pegar mensajes).

**Por qué Gemini funciona donde Llama no:** Gemini 2.5 Flash tiene `google_search` tool nativo → grounding con web real + cita URLs. Resuelve el trade-off velocidad/fidelidad.

**Lo que falta:**
1. Daniel configura `GEMINI_API_KEY` vía:
   ```
   !cd /Users/braindma/bizacq/cloudflare && npx wrangler secret put GEMINI_API_KEY
   ```
2. Agregar endpoint POST `/analyze` al Worker: recibe `dealId` → fetcha deal de GitHub → llama Gemini con prompt estructurado + grounding → parsea JSON → escribe `deep_analysis` → commit → quita `deep_analysis_requested`.
3. Modificar dashboard: `requestDeepAnalysis()` → POST `/analyze` (en lugar de `/request-analysis`), con spinner mientras Gemini procesa (~15 seg).

**Híbrido propuesto:** Gemini default para todos los deals (rápido, $0). Yo (Claude) reservado para "deep dive ejecutivo" de finalistas que avancen a EN_NEGOCIACION.

### #2 — Auditar 33 deals con URL de categoría
Caso Martin's Bread Route reveló patrón sistémico. **33 de 40 deals** tienen `source_url_kind: "category"` — riesgo de URL apuntando a página que muestra otros negocios. Solución: cuando Gemini /analyze esté vivo, **disparar barrido automático** que verifica cada uno y reemplaza con listing específico cuando lo encuentre.

### #3 — Rotar GitHub token (expuesto en chat)
Daniel pegó un PAT (`github_pat_***` — valor completo está en el historial del chat de Opus 4.7, no se replica aquí) en texto plano. Aunque el Worker lo guarda como secret, queda en historial del chat. Acción:
1. Revocar en github.com/settings/personal-access-tokens
2. Crear nuevo PAT scoped a `bizacq-dashboard` Contents:write
3. `!cd /Users/braindma/bizacq/cloudflare && npx wrangler secret put GITHUB_TOKEN`

### #4 — Fact-check del Wellnature (lead del socio)
ID `38f23de9-88dc-4cff-8f5b-7a35f92437fe`. DTC beauty St Petersburg FL, $1.1M, $100K MRR, 110K subs. Score 84 ALTA. Tiene análisis base + legal pero NO `deep_analysis`. Demo natural del Gemini /analyze cuando esté activo. **Discrepancia crítica a verificar:** profit $750K (header) vs $390K (descripción 11 meses).

### Opcionales
- **Cloudflare Pages → bizacq.bellapop.co**: dominio propio (coherente con guapa.bellapop.co, etc.). NO bloqueante.
- **Scout real (Playwright stealth)**: hoy uso WebSearch + PDFs manuales. Para automatizar barrido diario de 50 estados × 7 portales se necesita Playwright stealth + proxies (no free).
- **Monitor agent**: detectar listings que cambian precio o desaparecen.

---

## Casos especiales / red flags a no olvidar

### Skincare WY ($14M inventory) — el deal sospechoso
- ID `e0b7ff29-f9a2-4e28-b386-d6c000d67120`
- Sheridan WY 82801 ES el shell-company hub conocido del país (ICIJ Pandora Papers)
- "Dropshipping" + "$14M inventory" son contradictorios por definición
- 3 red flags + 12 preguntas obligatorias al broker antes de LOI
- Mantenido en RADAR, NO DESCARTAR — pero NO firmar sin resolver 12 Qs

### Wellnature (lead del socio)
- ID `38f23de9-88dc-4cff-8f5b-7a35f92437fe`
- St. Petersburg FL — DTC clean beauty Wellnature
- $1.095M / SDE $750K / Revenue $7.5M / Inventory $35K
- 110K MRR subscribers ($100K+/mes) — subscription real (a diferencia de Skincare WY)
- 🔴 Discrepancia: $750K profit (header) vs $390K (descripción 11 meses)
- Primer deal con EB-5 DIRECT viable

### Martin's Bread Route Cary NC (corregido 2026-05-29)
- Fue Daniel quien encontró la inconsistencia (URL llevaba a otro negocio)
- URL original era CATEGORÍA, datos del snippet NO coincidían con listing real
- Reemplazado con datos verificados del listing 2275502
- SDE $54K (debajo de mínimo $75K) → mantenido en RADAR con flag (caso especial)

---

## Memorias relevantes (user/feedback/project)

Las uso constantemente al trabajar en BizAcq:
- `bizacq_perfil_compradores` — Daniel ES + socio MX, sin LPR, SBA bloqueado
- `feedback_max_no_api` — NO Anthropic API en proyectos personales
- `feedback_deploy_gratis_github_pages` — patrón OET de hosting
- `daniel_dev_stack` — patrones UX/UI (KPI cards, filtros dinámicos, monolítico)
- `bizacq_proyecto` — resumen ejecutivo (autogenerado al actualizar)

---

## Cómo retomar la sesión

1. **Lee este CLAUDE.md primero** (lo estás haciendo)
2. `cd /Users/braindma/bizacq && git pull --rebase`
3. Revisa `TaskList` — hay 5 tasks pendientes marcados `[PRÓXIMA SESIÓN]` o `[OPCIONAL]`
4. Pregunta a Daniel por dónde empezar (la mayoría de las veces es el Gemini /analyze, que destraba todo lo demás)
5. **No reinventes decisiones tomadas** — sección "Decisiones clave" arriba
6. **Respeta el perfil migratorio** en cualquier legal_check nuevo
7. Cuando termines algo, actualiza la memoria `bizacq_proyecto` con el estado

---

## Backup point (tag git)

Tag: `backup-2026-05-30-opus47-handover` — snapshot del proyecto al cierre de la sesión de Opus 4.7. Para restaurar:
```bash
git checkout backup-2026-05-30-opus47-handover
```
