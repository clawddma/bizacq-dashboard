---
name: plain-language
description: Translation rules to turn rigorous financial output (SDE, DSCR, IRR, EBITDA, cash-on-cash) into plain-Spanish summaries readable in 10 seconds. Applied to every `plain_summary` field that reaches the dashboard. Required for FinancialAgent, StrategyAgent, and any UI copy.
---

# Plain-language skill

## The rule

**Inside the agents: rigorous. In the dashboard: human.** Never let a technical term reach the user without translation.

## Required translations

| Internal term | What the user reads |
|---|---|
| `SDE = $180K` | "el negocio genera $180 mil al año limpio" |
| `DSCR 1.42x` | "el negocio genera $1.42 por cada $1 de deuda — bien cubierto" |
| `DSCR 1.10x` | "el negocio apenas cubre la deuda — riesgo si baja el ingreso" |
| `Precio/SDE 2.8x` | "pagas 2.8 años de ganancias por el negocio" |
| `Cash-on-cash 18%` | "recuperas 18% de lo que pones de tu bolsillo en el primer año" |
| `Seller financing` | "el vendedor te financia parte del precio" |
| `SBA 7(a) eligible` | "califica para crédito SBA (hasta 90% del precio)" |
| `SBA 504` | "califica para crédito SBA con garantía del inmueble" |
| `AI upside score 82` | "alto potencial de mejora con tecnología" |
| `EBITDA` | "ganancia operativa antes de impuestos" |
| `Payback 4.2 años` | "recuperas tu inversión en ~4 años" |
| `IRR 28%` | "retorno total de tu dinero: 28% anual" |
| `Equity 10%` | "10% de tu bolsillo" |
| `Concentration risk` | "el negocio depende mucho de pocos clientes" |
| `Key-person dependency` | "si el dueño se va, el negocio puede caer" |

## Format rules for `plain_summary`

1. **Max 3 sentences.** A 10-second read.
2. **Concrete numbers.** "$180K al año" beats "ingresos saludables".
3. **No jargon, no acronyms.** If you must reference SBA, say "crédito SBA" with what it means in the same sentence the first time.
4. **Lead with the answer.** Sentence 1 = "vale la pena mirar / no vale la pena". Sentences 2–3 = el porqué.
5. **Name the risk.** End with the biggest specific risk in plain words — never "manageable risks remain".

## Examples — good vs bad

**Bad:**
> "HVAC business with strong fundamentals. DSCR of 1.42x and reasonable multiple at 2.8x. Manageable concentration risk."

**Good:**
> "Buen negocio de HVAC en Houston: genera $180 mil limpios al año y se paga su propia deuda con holgura. Pagas 2.8 años de ganancias, lo cual es razonable. El riesgo: el dueño lleva la operación solo, hay que planear cómo lo reemplazas."

**Bad:**
> "Strategic acquisition with synergistic AI integration potential, projecting 2.5–3.5x value multiplier through workflow automation."

**Good:**
> "Si automatizas el agendamiento y los recordatorios de mantenimiento, este negocio puede valer entre 2.5 y 3.5 veces lo que pagas en 3 años. La mayoría del trabajo manual se puede mover a software. El riesgo: tiene pocos técnicos y son difíciles de reemplazar."

## What never reaches the user

- Field names like `dscr`, `cash_on_cash_y1`, `multiple`, `score`
- Three-letter acronyms without expansion
- "Synergies", "leverage", "scalable", "transformation", "ecosystem"
- Hedge language ("may potentially", "could possibly") — pick a stance
- Numbers without units ("score of 82" → "82 sobre 100" or just the human version)

## Validation before persist

Before writing a `plain_summary` to the DB, the agent should self-check:
- [ ] ≤ 3 sentences
- [ ] No financial acronyms remain
- [ ] At least one concrete number
- [ ] Risk named in plain words

If any check fails, regenerate. The agent does this in Python with regex against a stop-list (`dscr`, `sde`, `ebitda`, `irr`, `roi`, etc.).
