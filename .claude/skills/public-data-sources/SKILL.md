---
name: public-data-sources
description: Catálogo de bases de datos públicas gratuitas para verificar negocios — Secretary of State por estado, SBA FOIA, Census Bureau, BLS, PACER, OpenCorporates, Yelp/Google Maps reviews. Usado por el fact-checker subagent para subir confianza del análisis de deals específicos.
---

# Public-data-sources skill

## Filosofía
$0 mensual. Solo APIs públicas o portales free. Cada fuente con URL exacta, qué busca, qué devuelve.

---

## 1. Secretary of State (entity legal)

Cada estado mantiene un registro público de entities. Lo más útil para verificar que el business existe legalmente.

| Estado | URL de búsqueda |
|---|---|
| TX | https://mycpa.cpa.state.tx.us/coa/Index.html (Texas Comptroller — also has business search at https://comptroller.texas.gov/taxes/franchise/) |
| FL | https://search.sunbiz.org/ |
| NY | https://apps.dos.ny.gov/publicInquiry/ |
| CA | https://bizfileonline.sos.ca.gov/search/business |
| GA | https://ecorp.sos.ga.gov/BusinessSearch |
| NV | https://esos.nv.gov/EntitySearch/OnlineEntitySearch |
| AZ | https://ecorp.azcc.gov/EntitySearch/Index |
| NC | https://www.sosnc.gov/online_services/search/by_title/_Business_Registration |
| CO | https://www.sos.state.co.us/biz/BusinessEntityCriteriaExt.do |
| TN | https://tnbear.tn.gov/Ecommerce/FilingSearch.aspx |
| MA | https://corp.sec.state.ma.us/CorpWeb/CorpSearch/CorpSearch.aspx |
| OR | https://sos.oregon.gov/business/Pages/find.aspx |
| WI | https://www.wdfi.org/apps/CorpSearch/Search.aspx |
| WY | https://wyobiz.wy.gov/Business/FilingSearch.aspx |
| Otros | Google "[state name] secretary of state business search" |

**Qué buscar:**
- Entity status: ACTIVE, INACTIVE, DISSOLVED, ADMINISTRATIVELY DISSOLVED
- Filing date (consistencia con "founded" del listing)
- Registered agent (si es servicio profesional como Northwest, Harbor Compliance → red flag for pantalla)
- Officers / Members (si visibles)
- Address (si es UPS Store / virtual office → red flag)

**Cómo aprovechar con WebFetch:**
Algunos estados tienen URLs deep para entity ID; WebFetch puede traer el HTML resultado.

---

## 2. SBA Loan Data (FOIA público)

**URL**: https://data.sba.gov/dataset/7-a-504-foia

Descargas CSV con TODOS los SBA 7(a) y 504 loans aprobados desde 1991. Actualizado mensualmente.

Campos relevantes:
- `BorrName`, `BorrCity`, `BorrState`, `NAICS Code` (industria)
- `ApprovalDate`, `GrossApproval` (monto del loan)
- `LoanStatus` (PAID, IN LIQUIDATION, CHARGED OFF — el último es default)

**Uso:**
1. Filtrar por NAICS (lookup el código de la industria del deal)
2. Filtrar por estado
3. Calcular: # de loans últimos 3 años, monto promedio, default rate
4. Cross-check si BorrName matchea el del listing (raro pero validador fuerte)

**NAICS codes útiles:**
- HVAC: 238220 (Plumbing, Heating, Air-Conditioning Contractors)
- Plumbing: 238220 (same as HVAC)
- Electrical: 238210
- Landscaping: 561730
- Cleaning: 561720 (Janitorial Services)
- Pest Control: 561710
- Auto Repair: 811111
- Dental Practice: 621210
- Med Spa: 621498 / 812199
- E-commerce: 454110 (Electronic Shopping)
- Insurance Agency: 524210
- Restaurant: 722511 (Full-Service Restaurants)
- Veterinary: 541940

---

## 3. US Census Bureau (demographics + business patterns)

**API**: https://api.census.gov/data.html (free, no key needed for basic queries)

Para el ZIP del business:
- ACS (American Community Survey) — demographics, income, population
- CBP (County Business Patterns) — establishments + employment by industry by county

**WebFetch ejemplo URL:**
```
https://api.census.gov/data/2022/cbp?get=NAME,EMP,ESTAB&for=county:*&in=state:48&NAICS2017=238220
```
Devuelve: nombre de cada county en Texas (state 48), número de establecimientos HVAC, empleo total.

**Útil para:**
- Validar que la ciudad/county tiene mercado activo en esa industria
- Detectar mercado saturado (alta establishment count, low per-capita revenue)
- Identificar mercados sub-atendidos (counties con baja densidad → opportunity)

---

## 4. BLS (Bureau of Labor Statistics)

**URL**: https://www.bls.gov/cew/data/files/QCEW.htm

QCEW = Quarterly Census of Employment and Wages. Data por industria por county.

**Útil para:**
- Trend de empleo en la industria + estado (subiendo o bajando)
- Salario promedio (para validar wage assumptions en proforma)

WebSearch generalmente más rápido para preguntas específicas: "BLS HVAC employment trend Texas 2024 2025"

---

## 5. PACER (Federal Courts)

**URL**: https://pcl.uscourts.gov/pcl/index.jsf — PACER Case Locator (free search, paid docs)

Search por nombre del seller (individual o entity):
- Bankruptcies (Chapter 7, 11, 13)
- Federal civil lawsuits
- IRS liens (sometimes)
- Trademark disputes
- Patent litigation

**Free tier:** búsquedas gratis. Ver dockets cuesta $0.10/page (cap $3/doc). Si Daniel necesita los dockets full, le decimos cuánto cuesta (~$5-30 per deal).

**Trellis** (https://trellis.law/) — state courts, varios free.

---

## 6. OpenCorporates

**URL**: https://opencorporates.com/

Free tier: 50 searches/month. Aggregates corporate data globally.

Útil cuando:
- El seller dice "operamos en Delaware" pero el SOS local tiene info distinta
- Verificar officers/directors histórico (si ha habido cambios sospechosos)

---

## 7. Reviews públicas

- **Yelp**: https://www.yelp.com (browse without auth)
- **Google Maps / Business Profile**: https://www.google.com/maps (browse)
- **TripAdvisor** (para hospitality)

**Search via WebSearch o WebFetch.** Métricas:
- Star rating actual
- Número total de reviews
- Tendencia (¿bajando ratings últimos 6 meses?)
- Reviews negativos: leer top 5 más recientes negative reviews — qué dicen los clientes

---

## 8. Property + Real Estate

- **County Assessor** (varía por county) — search "[county name] assessor property search"
- **Zillow / Redfin** — value estimates si el deal incluye real estate

---

## Workflow típico de un fact-check

Dado un deal con: title, city, state, industry, asking_price, source_url:

1. **WebSearch del business name + ciudad** → encontrar website, redes, listings
2. **Secretary of State del estado** → verificar entity active + fecha
3. **WebSearch del seller name (si visible) + estado** → check Google + LinkedIn
4. **PACER quick search** del business name + seller name → court records
5. **SBA FOIA** filter por NAICS + state → contexto del market activity
6. **Census CBP** del county → market density y trend
7. **Yelp/Google reviews** del business name + ciudad → reputation
8. **Compile findings** en el `deep_analysis` object con citations

Total time: 8-15 minutes by an LLM agent. Total cost: $0.

## Output disciplina

Cada finding lleva su `source` URL. Sin source, no es un finding — es una inferencia.

Categorías a emitir veredicto explícito:
- ✓ Existence (business exists + reputation consistent with listing claims)
- ✓ Legal entity (active, age matches, address not red flag)
- ✓ SBA market activity (industry + state has healthy SBA volume)
- ✓ Demographics (county supports the business density claimed)
- ✓ Litigation (no concerning federal cases)
- ✓ Reputation (review trend stable or positive)

Cualquiera de esos con ⚠ o 🚩 → output como warning/red flag en findings.
