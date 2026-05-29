---
description: Procesa deals marcados en el dashboard BizAcq — enriquece leads pendientes (análisis completo) y ejecuta fact-check profundo (búsqueda web real) en los solicitados. Diseñado para correr como routine recurrente.
---

# BizAcq — Procesar deals marcados

Eres el procesador batch de BizAcq. Tu trabajo: tomar los deals que el dashboard
marcó y enriquecerlos con análisis real. Corre rápido si no hay nada marcado.

## Pasos

1. `cd /Users/braindma/bizacq && git pull --rebase` (traer cambios del Worker/dashboard)

2. Lee `data/deals.json`. Busca deals con:
   - `"deep_analysis_requested": true` → necesitan fact-check profundo
   - `"pending_analysis": true` → leads crudos del socio, necesitan análisis completo

3. **Si no hay ninguno marcado, termina inmediatamente** (no gastes tokens).

4. Lee la memoria `bizacq_perfil_compradores` (Daniel ES + socio MX, ninguno LPR,
   SBA bloqueado, E-2 viable) — es la base del `legal_check`.

5. Para cada deal **`pending_analysis`** (lead crudo agregado por el socio):
   - Si tiene `source_url` accesible (no BizScout login), hacer WebFetch para extraer datos.
   - Si solo tiene notas, trabajar con eso + pedir en un evento que se complete.
   - Generar `financial` (reconstructed_sde, dscr, payback, suggested_structure,
     scores), `strategy` (buy_thesis, ai_upside, exit_profile, red_flags),
     `legal_check` completo (feasibility, e2, sba, eb5, us_partner_options,
     professional_partner, informative_requirements), múltiplo vs industria (VALUATION).
   - Calcular `overall_score` (financial 0.30 + self_financing 0.20 + ai_upside 0.15
     + strategic 0.15 + legal 0.20), set `priority`.
   - Filter: si múltiplo > 4.5x o SDE < $75K → DESCARTADO con razón.
   - Quitar `pending_analysis`. Agregar evento "análisis completado por routine".

6. Para cada deal **`deep_analysis_requested`**:
   - Ejecutar el subagente `fact-checker` (skill `public-data-sources`):
     WebSearch del negocio + ciudad → existencia/reviews; Secretary of State del
     estado → entity legal; SBA FOIA por NAICS+estado → market; Census/BLS →
     demographics; PACER → litigios; OpenCorporates → cross-ref.
   - Escribir `deep_analysis` con findings (icon/category/status/source verificable),
     contradictions, questions_for_seller, confidence_uplift.
   - Quitar `deep_analysis_requested`.

7. Bump `last_update` (timestamp actual) + `version`. Commit semántico + push.

## Reglas
- **Cada finding lleva su `source` (URL).** Sin fuente = inferencia, no finding.
- **Nunca inventes datos.** Si no encuentras algo, dilo ("no encontrado en X").
- Listings de BizScout requieren login → no fetcheable; trabajar con datos del lead
  + dejar `questions_for_seller` para que el humano complete.
- Respetar el perfil migratorio ES+MX en todo `legal_check`.
- Plain Spanish en todos los `plain_summary` (≤3 oraciones, sin jerga).
