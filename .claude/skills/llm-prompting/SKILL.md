---
name: llm-prompting
description: Token-efficient patterns for calling Anthropic Claude (Haiku for cheap classifications, Sonnet for deep analysis). Covers strict-JSON output, prompt caching strategy, schema validation with Pydantic, token tracking, retry/backoff, and the budget tripwires that prevent runaway cost.
---

# LLM-prompting skill

## The token rule (project-wide)

**An LLM call must be justified by a gate the deal already passed.** No call for deals in DESCARTADO. No Sonnet call without a Haiku-derived `financial_score > 55`. No re-call when cached output is still valid.

If you write code that calls an LLM, document in a comment which gate the deal crossed to deserve this call.

## Model selection

| Use case | Model | Why |
|---|---|---|
| Financial narrative (`plain_summary`, risk flags) | `claude-haiku-4-5` | Cheap, fast, good at structured narrative |
| Strategy analysis, AI-upside thesis | `claude-sonnet-4-6` | Worth the cost only when financial gate passed |

Model IDs come from `config.yaml` → loaded into `core/config.py`. **Never hardcode a model ID in agent code.**

## Token budgets

| Agent | Input cap | Output cap |
|---|---|---|
| FinancialAgent (Haiku) | 400 tokens | 600 tokens |
| StrategyAgent (Sonnet) | 600 tokens | 800 tokens |

Enforce with `max_tokens` on the response and a `len(tiktoken.encode(prompt)) <= cap` assert before sending. If the assert fails, summarize the input — don't silently exceed the budget.

## Prompt structure

System prompts live in `agents/prompts/*.txt`. Never inline. Format:

```
You are <role>. Output strict JSON matching the schema below.
Do not include explanations outside the JSON. If a field is unknown, set it to null.

Schema:
<JSON Schema>

Rules:
- <rule 1>
- <rule 2>
```

User message contains **only the structured inputs** — pre-extracted fields, never raw HTML or the full listing description. If a description is needed, summarize it to one paragraph first.

## Strict-JSON output

Use the Anthropic SDK with `tool_use` or `response_format={"type": "json"}` when supported. Otherwise instruct in the prompt and validate:

```python
import json
from pydantic import ValidationError

try:
    data = json.loads(response.content[0].text)
    parsed = FinancialAnalysisSchema(**data)
except (json.JSONDecodeError, ValidationError) as e:
    # ONE retry with a "your previous response was invalid JSON — fix it" message
    # If second attempt fails, log and surface a `risk_flags += ["LLM no devolvió JSON válido"]`
```

## Caching strategy

Two layers:

**1. Skip-the-call cache (database):** if `deal_financials` exists and `deals` row hasn't changed in the fields the agent uses (price, SDE, description hash), reuse the stored row. No LLM call.

**2. Prompt cache (Anthropic):** for the system prompt + few-shot examples, use Anthropic prompt caching with `cache_control: {"type": "ephemeral"}`. The user-message portion (the deal data) is uncached. This cuts ~70% of repeat input token cost.

## Token tracking

Every call writes a `token_usage` row before returning:

```python
async def call_llm(agent: str, model: str, messages: list, max_tokens: int):
    response = await client.messages.create(model=model, messages=messages, max_tokens=max_tokens)
    await db.execute(insert(TokenUsage).values(
        agent=agent,
        model=model,
        input_tokens=response.usage.input_tokens,
        output_tokens=response.usage.output_tokens,
        cost_usd=compute_cost(model, response.usage),
    ))
    return response
```

Pricing table for `compute_cost` lives in `core/llm_client.py` — update when Anthropic prices change.

## Retry policy

`tenacity`:
- 3 attempts
- Exponential backoff, base 2s, max 30s
- Retry on: `anthropic.APIConnectionError`, `anthropic.APITimeoutError`, `anthropic.RateLimitError`, `anthropic.InternalServerError`
- **Do NOT retry** on `anthropic.BadRequestError` (prompt too long, schema invalid) — those are bugs to fix, not transient.

## Budget tripwires

Read from `config.yaml`:
- `weekly_token_budget_usd`: hard ceiling. If `SUM(cost_usd) WHERE called_at > NOW() - INTERVAL '7 days'` exceeds this, agents refuse to call LLMs and write a `deal_event` of type `budget_exceeded`.
- Dashboard surfaces the week-to-date spend in the Panel de Control.

Default: $50/week. Adjust as the system scales.

## Bad patterns to avoid

- **Asking the LLM to do math.** Compute in Python, ask the LLM to narrate.
- **Passing raw HTML or full descriptions.** Pre-extract and summarize first.
- **Free-text output for downstream parsing.** Always JSON.
- **One giant prompt that does five things.** Split into focused prompts that each pass a gate.
- **Re-analyzing on every Monitor tick.** Cache invalidation is gated by content change, not time.
