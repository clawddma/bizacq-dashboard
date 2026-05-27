"""
Pydantic models — data validation contracts for LLM outputs, API requests/responses,
and inter-agent message payloads.

Persistence lives in `core.database` (SQLAlchemy ORM). These models do not know about the DB.
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

USState = Literal["TX", "FL"]


class PipelineStatus(str, Enum):
    RADAR = "RADAR"
    EN_ANALISIS = "EN_ANALISIS"
    PARA_CONTACTAR = "PARA_CONTACTAR"
    EN_NEGOCIACION = "EN_NEGOCIACION"
    CIERRE = "CIERRE"
    DESCARTADO = "DESCARTADO"


class Priority(str, Enum):
    ALTA = "ALTA"
    MEDIA = "MEDIA"
    BAJA = "BAJA"


class SourceName(str, Enum):
    BIZBUYSELL = "bizbuysell"
    BIZQUEST = "bizquest"
    FLIPPA = "flippa"
    EMPIRE_FLIPPERS = "empire_flippers"
    BIZSCOUT = "bizscout"
    LOOPNET = "loopnet"


class EventType(str, Enum):
    FILTERED = "filtered"
    DESCARTED = "descarted"
    ANALYZED_FINANCIAL = "analyzed_financial"
    ANALYZED_STRATEGY = "analyzed_strategy"
    RESCORED = "rescored"
    STATUS_CHANGE = "status_change"
    PRICE_DROP = "price_drop"
    LISTING_REMOVED = "listing_removed"
    SELLER_FINANCING_CHANGED = "seller_financing_changed"
    BUDGET_EXCEEDED = "budget_exceeded"


# Allowed pipeline transitions — single source of truth. Enforced in api/routers/pipeline.py.
ALLOWED_TRANSITIONS: dict[PipelineStatus, set[PipelineStatus]] = {
    PipelineStatus.RADAR: {PipelineStatus.EN_ANALISIS, PipelineStatus.DESCARTADO},
    PipelineStatus.EN_ANALISIS: {
        PipelineStatus.RADAR,
        PipelineStatus.PARA_CONTACTAR,
        PipelineStatus.DESCARTADO,
    },
    PipelineStatus.PARA_CONTACTAR: {PipelineStatus.EN_NEGOCIACION, PipelineStatus.DESCARTADO},
    PipelineStatus.EN_NEGOCIACION: {PipelineStatus.CIERRE, PipelineStatus.DESCARTADO},
    PipelineStatus.CIERRE: {PipelineStatus.DESCARTADO},
    PipelineStatus.DESCARTADO: {PipelineStatus.RADAR},
}


def can_transition(from_status: PipelineStatus, to_status: PipelineStatus) -> bool:
    return to_status in ALLOWED_TRANSITIONS[from_status]


Money = Annotated[Decimal, Field(ge=0, decimal_places=2)]
Score = Annotated[Decimal, Field(ge=0, le=100, decimal_places=2)]


# --- Deal: produced by ScoutAgent, consumed by all downstream agents ---

class Deal(BaseModel):
    """Canonical deal payload — what the scraper produces and the DB stores."""

    model_config = ConfigDict(use_enum_values=True, from_attributes=True)

    id: UUID | None = None
    source: SourceName
    source_url: str = Field(min_length=1)
    title: str = Field(min_length=1, max_length=500)
    state: USState
    city: str = Field(min_length=1, max_length=100)
    asking_price: Money
    reported_revenue: Money | None = None
    reported_sde: Money | None = None
    business_type: str = Field(min_length=1, max_length=200)
    years_operation: int | None = Field(default=None, ge=0, le=200)
    seller_financing: bool = False
    sba_prequalified: bool = False
    raw_description: str = Field(min_length=1)
    listing_date: date | None = None

    pipeline_status: PipelineStatus = PipelineStatus.RADAR
    discard_reason: str | None = None

    filter_score: Score | None = None
    overall_score: Score | None = None
    priority: Priority | None = None

    last_seen_at: datetime | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None

    @model_validator(mode="after")
    def _discard_reason_required_when_descartado(self) -> "Deal":
        if self.pipeline_status == PipelineStatus.DESCARTADO and not self.discard_reason:
            raise ValueError("discard_reason is required when pipeline_status is DESCARTADO")
        return self


# --- FinancialAgent output ---

class SuggestedStructure(BaseModel):
    equity_pct: Annotated[float, Field(ge=0, le=100)]
    sba_loan_pct: Annotated[float, Field(ge=0, le=100)]
    seller_note_pct: Annotated[float, Field(ge=0, le=100)]
    bank_loan_pct: Annotated[float, Field(ge=0, le=100)] = 0.0
    estimated_monthly_debt_service: Money

    @model_validator(mode="after")
    def _percentages_sum_to_100(self) -> "SuggestedStructure":
        total = self.equity_pct + self.sba_loan_pct + self.seller_note_pct + self.bank_loan_pct
        if abs(total - 100.0) > 0.5:
            raise ValueError(f"Buy structure percentages must sum to ~100, got {total}")
        return self


class CashFlowProjections(BaseModel):
    """Year-by-year SDE projections under three scenarios."""

    y1_conservative: Money
    y1_base: Money
    y1_optimistic: Money
    y3_conservative: Money
    y3_base: Money
    y3_optimistic: Money


class FinancialAnalysis(BaseModel):
    """Output schema for FinancialAnalystAgent. Validated before persisting to deal_financials."""

    model_config = ConfigDict(use_enum_values=True)

    reconstructed_sde: Money
    dscr: Annotated[float, Field(ge=0)]
    cash_on_cash_y1: Annotated[float, Field(ge=-1, le=10)]
    cash_on_cash_y3: Annotated[float, Field(ge=-1, le=10)] = 0.0
    payback_years: Annotated[float, Field(ge=0)] | None = None
    equity_required: Money
    seller_financing: bool
    sba_eligible: bool
    suggested_structure: SuggestedStructure
    projections: CashFlowProjections
    self_financing_score: Score
    financial_score: Score
    risk_flags: list[str] = Field(default_factory=list)
    plain_summary: str = Field(min_length=10, max_length=500)

    @field_validator("plain_summary")
    @classmethod
    def _no_jargon(cls, v: str) -> str:
        jargon = {"sde ", "dscr", "ebitda", "irr", "roi ", "cash-on-cash"}
        lower = v.lower()
        for term in jargon:
            if term in lower:
                raise ValueError(
                    f"plain_summary contains jargon term '{term.strip()}'. "
                    "Apply the plain-language skill — translate before persisting."
                )
        return v


# --- StrategyAgent output ---

class AIUpside(BaseModel):
    score: Score
    opportunities: list[str] = Field(min_length=1, max_length=5)
    value_multiplier_low: Annotated[float, Field(ge=0.5, le=10)]
    value_multiplier_high: Annotated[float, Field(ge=0.5, le=10)]

    @model_validator(mode="after")
    def _multiplier_range_sensible(self) -> "AIUpside":
        if self.value_multiplier_high < self.value_multiplier_low:
            raise ValueError("value_multiplier_high must be >= value_multiplier_low")
        spread = self.value_multiplier_high - self.value_multiplier_low
        if spread > 2.0:
            raise ValueError(
                f"Multiplier spread {spread:.1f}x is too wide (>2x). "
                "Tighten the estimate or set low/high closer together."
            )
        return self


class StrategicAnalysis(BaseModel):
    """Output schema for StrategyAgent. Validated before persisting to deal_strategy."""

    model_config = ConfigDict(use_enum_values=True)

    buy_thesis: list[str] = Field(min_length=2, max_length=5)
    ai_upside: AIUpside
    exit_profile: str = Field(min_length=10, max_length=200)
    red_flags: list[str] = Field(default_factory=list)
    strategic_score: Score
    plain_summary: str = Field(min_length=10, max_length=500)


# --- Events ---

class DealEvent(BaseModel):
    model_config = ConfigDict(use_enum_values=True)

    deal_id: UUID
    event_type: EventType
    description: str
    old_value: dict | None = None
    new_value: dict | None = None


# --- Token usage tracking ---

class TokenUsageRecord(BaseModel):
    deal_id: UUID | None = None
    agent: str
    model: str
    input_tokens: int = Field(ge=0)
    output_tokens: int = Field(ge=0)
    cost_usd: Annotated[Decimal, Field(ge=0, decimal_places=6)]
