---
name: financial-modeling
description: SDE reconstruction, DSCR computation, cash-on-cash and payback calculations, SBA 7(a)/504 eligibility, and the suggested-buy-structure heuristic (equity / SBA loan / seller note). All pure Python — never delegate financial math to an LLM.
---

# Financial-modeling skill

## SDE (Seller's Discretionary Earnings) reconstruction

Start from `reported_sde` if available. Otherwise reconstruct from `reported_revenue` using these add-backs:

```python
def reconstruct_sde(revenue, reported_ebitda=None, owner_salary=0,
                    one_time_expenses=0, personal_expenses=0,
                    interest=0, depreciation=0, amortization=0):
    base = reported_ebitda if reported_ebitda is not None else 0
    return base + owner_salary + one_time_expenses + personal_expenses \
           + interest + depreciation + amortization
```

When the listing doesn't break these out, mark `risk_flags += ["SDE no verificado — basado en cifras reportadas sin add-backs documentados"]`.

Confidence tags: `sde_confidence = 'high'` if reported with breakdown, `'medium'` if reported as a single number, `'low'` if reconstructed from revenue × industry margin.

## DSCR (Debt Service Coverage Ratio)

```python
def dscr(sde, annual_debt_service):
    if annual_debt_service <= 0:
        return float('inf')
    return sde / annual_debt_service
```

Target: `DSCR ≥ 1.25` (config `min_dscr`). Below 1.25 → flag the deal as "no se financia solo".

## Suggested buy structure

Default heuristic — adjust by industry risk:

| Profile | Equity | SBA 7(a) | Seller note |
|---|---|---|---|
| Strong (years > 5, recurring revenue) | 10% | 80% | 10% |
| Standard | 15% | 75% | 10% |
| Higher risk (concentration / new) | 20% | 70% | 10% |
| No SBA eligibility | 25% | 0% | 25% bank + 50% seller |

Compute monthly debt service assuming:
- SBA 7(a): 10-year amortization, current SBA Prime + 2.75% (read from config `sba_rate`)
- Seller note: 5-year amortization, 6% interest (default; configurable)

## Cash-on-cash (Y1 and Y3)

```python
def cash_on_cash(annual_cashflow_to_equity, equity_invested):
    return annual_cashflow_to_equity / equity_invested
```

`cashflow_to_equity = SDE - annual_debt_service - capex_reserve`.
Capex reserve default: 5% of revenue (configurable per industry).

Y3 uses base-case growth (default 5% YoY revenue, 60% SDE retention) — these come from `config.yaml` per industry.

## Payback period

```python
def payback_years(equity_invested, annual_cashflow_to_equity):
    if annual_cashflow_to_equity <= 0:
        return None  # Doesn't pay back
    return equity_invested / annual_cashflow_to_equity
```

## SBA eligibility

**SBA 7(a)** — most common, working capital + acquisition:
- Asking price ≤ $5M ✓
- US-based business ✓
- For-profit ✓
- Owner-occupied if real estate involved
- Not on SBA's prohibited list (gambling, lending, speculative real estate, etc.)

**SBA 504** — only if real estate + equipment are part of the deal:
- Real estate or major equipment must be ≥ 51% of total
- 10% equity, 40% CDC debenture, 50% bank

Encode the prohibited-list check as a function `is_sba_eligible(business_type) -> tuple[bool, str]` returning `(eligible, reason_if_not)`.

## self_financing_score (0–100)

Heuristic, additive, capped at 100:
- DSCR ≥ 1.5 → +30; 1.25 ≤ DSCR < 1.5 → +20; DSCR < 1.25 → 0
- Seller financing available → +25
- SBA eligible → +25
- Equity required ≤ 15% of price → +20

This score is the input to RankingAgent's `self_financing_score` weight.

## financial_score (0–100)

Weighted blend:
- DSCR bucket (≥1.5 → 30, ≥1.25 → 22, ≥1.1 → 12, else 0)
- Cash-on-cash Y1 (≥25% → 25, ≥15% → 18, ≥8% → 10, else 0)
- Payback (≤3y → 20, ≤4y → 15, ≤5y → 10, else 0)
- Multiple (P/SDE ≤ 2.5 → 15, ≤ 3.5 → 10, ≤ 4.5 → 5, else 0)
- SDE confidence (high → 10, medium → 5, low → 0)

Threshold: `financial_score > 55` activates StrategyAgent (Sonnet).

## Output JSON contract — what FinancialAgent persists

See the `deal_financials` schema. All numeric fields come from these formulas; the LLM only writes `plain_summary` and `risk_flags`.
