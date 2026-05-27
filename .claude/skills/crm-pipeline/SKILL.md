---
name: crm-pipeline
description: The 6-state deal pipeline (RADAR → EN_ANALISIS → PARA_CONTACTAR → EN_NEGOCIACION → CIERRE, plus DESCARTADO). Defines allowed transitions, automatic vs manual moves, the events emitted on each transition, and the priority/score thresholds that trigger auto-promotion.
---

# CRM-pipeline skill

## The 6 states

```
RADAR → EN_ANALISIS → PARA_CONTACTAR → EN_NEGOCIACION → CIERRE
                                                            ↓
                                                       DESCARTADO  (from any state)
```

Stored in `deals.pipeline_status` as VARCHAR(30). One state at a time.

## State semantics

| State | What it means | Who enters it | Visible actions |
|---|---|---|---|
| `RADAR` | Pasó filtros duros, sin análisis financiero aún | FilterAgent (auto) | "Analizar" / "Descartar" |
| `EN_ANALISIS` | FinancialAgent y/o StrategyAgent procesando o ya devolvieron | Auto si `filter_score > 70`; manual desde RADAR | "Pasar a Contactar" / "Volver a Radar" / "Descartar" |
| `PARA_CONTACTAR` | El usuario decidió contactar al broker | Manual | "Pasé a Negociación" / "Descartar" |
| `EN_NEGOCIACION` | Conversación activa con el vendedor | Manual | "Cerrado" / "Descartar" |
| `CIERRE` | Deal ganado, due diligence final o cerrado | Manual | (terminal salvo notas) |
| `DESCARTADO` | No aplica — requires `discard_reason` | Auto o manual desde cualquier estado | "Recuperar a Radar" (debe limpiar el motivo) |

## Allowed transitions

```python
ALLOWED = {
    'RADAR':           {'EN_ANALISIS', 'DESCARTADO'},
    'EN_ANALISIS':     {'RADAR', 'PARA_CONTACTAR', 'DESCARTADO'},
    'PARA_CONTACTAR':  {'EN_NEGOCIACION', 'DESCARTADO'},
    'EN_NEGOCIACION':  {'CIERRE', 'DESCARTADO'},
    'CIERRE':          {'DESCARTADO'},  # only if a deal falls through post-close
    'DESCARTADO':      {'RADAR'},       # recovery requires clearing discard_reason
}
```

Enforce in the API layer (`api/routers/pipeline.py`) — never allow a forbidden transition. Forbidden attempts return 422 with the allowed set.

## Automatic transitions

These the system performs without user input:

| From | To | Trigger | Who |
|---|---|---|---|
| (none) | `RADAR` | Listing passed all hard filter rules | FilterAgent |
| (none) | `DESCARTADO` | Listing failed any hard filter rule | FilterAgent |
| `RADAR` | `EN_ANALISIS` | `filter_score > 70` (auto-analyze threshold) | FilterAgent → enqueue FinancialAgent |
| `RADAR` | `EN_ANALISIS` | `overall_score ≥ 80` after a rescore | RankingAgent |
| any active | `DESCARTADO` | `overall_score < 40` | RankingAgent |
| any active | `DESCARTADO` | MonitorAgent detects 3 consecutive 404s | MonitorAgent (`discard_reason='Vendido o expirado'`) |

All manual transitions come from the dashboard (`api/routers/pipeline.py POST /deals/{id}/transition`).

## Events emitted on transition

Every transition writes a `deal_events` row:

```python
{
  "event_type": "status_change",
  "old_value": {"status": "RADAR"},
  "new_value": {"status": "EN_ANALISIS", "trigger": "auto" | "user", "actor": "filter_agent" | "Daniel" | ...}
}
```

The dashboard timeline reads this table — every visible event MUST have a corresponding `deal_events` row.

## Priority buckets (separate from state)

```python
def assign_priority(overall_score):
    if overall_score >= 80: return 'ALTA'
    if overall_score >= 60: return 'MEDIA'
    if overall_score >= 40: return 'BAJA'
    return None  # → also triggers DESCARTADO via RankingAgent
```

Stored in `deals.priority`. Independent of `pipeline_status` (a deal can be MEDIA priority and in EN_NEGOCIACION).

## Drag-and-drop in the Kanban

When the user drags a card to a new column, the frontend calls `POST /deals/{id}/transition` with the target state. The server validates against `ALLOWED` — if rejected, the frontend snaps the card back and shows a toast with the reason.

Transitions to `DESCARTADO` open a modal asking for `discard_reason` (free text, required). The modal can be dismissed only by entering a reason or cancelling the move.

## State counters (sidebar)

The dashboard sidebar shows live counters per state. Backed by `GET /stats/pipeline-counts` which returns:
```json
{"RADAR": 47, "EN_ANALISIS": 8, "PARA_CONTACTAR": 3, "EN_NEGOCIACION": 1, "CIERRE": 0, "DESCARTADO": 312}
```
Cached for 30 seconds with Redis.

## Anti-patterns

- Don't add new states. Six is the contract.
- Don't allow direct RADAR → PARA_CONTACTAR (must analyze first).
- Don't transition without writing a `deal_events` row.
- Don't auto-move OUT of EN_NEGOCIACION — that's the user's decision.
