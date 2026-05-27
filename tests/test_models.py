"""Pydantic model tests — pure unit tests, no DB or network required."""
from __future__ import annotations

from decimal import Decimal

import pytest
from pydantic import ValidationError

from core.models import (
    ALLOWED_TRANSITIONS,
    AIUpside,
    CashFlowProjections,
    Deal,
    FinancialAnalysis,
    PipelineStatus,
    Priority,
    SourceName,
    StrategicAnalysis,
    SuggestedStructure,
    can_transition,
)


def _make_deal(**overrides):
    base = dict(
        source=SourceName.BIZBUYSELL,
        source_url="https://bizbuysell.com/listing/12345",
        title="HVAC Services — Houston",
        state="TX",
        city="Houston",
        asking_price=Decimal("450000.00"),
        business_type="HVAC",
        raw_description="A description of the business with enough text to pass validation.",
    )
    base.update(overrides)
    return Deal(**base)


class TestDeal:
    def test_minimum_valid_deal(self):
        deal = _make_deal()
        assert deal.pipeline_status == PipelineStatus.RADAR.value
        assert deal.state == "TX"
        assert deal.seller_financing is False

    def test_rejects_non_target_state(self):
        with pytest.raises(ValidationError):
            _make_deal(state="CA")

    def test_descartado_requires_reason(self):
        with pytest.raises(ValidationError) as exc:
            _make_deal(pipeline_status=PipelineStatus.DESCARTADO)
        assert "discard_reason" in str(exc.value)

    def test_descartado_with_reason_ok(self):
        deal = _make_deal(
            pipeline_status=PipelineStatus.DESCARTADO,
            discard_reason="Price too high",
        )
        assert deal.discard_reason == "Price too high"


class TestPipelineTransitions:
    def test_radar_can_go_to_en_analisis(self):
        assert can_transition(PipelineStatus.RADAR, PipelineStatus.EN_ANALISIS)

    def test_radar_cannot_jump_to_negociacion(self):
        assert not can_transition(PipelineStatus.RADAR, PipelineStatus.EN_NEGOCIACION)

    def test_cierre_cannot_go_back_to_negociacion(self):
        assert not can_transition(PipelineStatus.CIERRE, PipelineStatus.EN_NEGOCIACION)

    def test_descartado_recovery_only_to_radar(self):
        assert can_transition(PipelineStatus.DESCARTADO, PipelineStatus.RADAR)
        assert not can_transition(PipelineStatus.DESCARTADO, PipelineStatus.EN_ANALISIS)

    def test_all_states_have_defined_transitions(self):
        for state in PipelineStatus:
            assert state in ALLOWED_TRANSITIONS

    def test_any_active_state_can_go_to_descartado(self):
        for state in PipelineStatus:
            if state == PipelineStatus.DESCARTADO:
                continue
            assert can_transition(state, PipelineStatus.DESCARTADO)


class TestSuggestedStructure:
    def test_sums_to_100(self):
        s = SuggestedStructure(
            equity_pct=10, sba_loan_pct=80, seller_note_pct=10,
            estimated_monthly_debt_service=Decimal("4200.00"),
        )
        assert s.equity_pct + s.sba_loan_pct + s.seller_note_pct == 100

    def test_rejects_when_sum_off(self):
        with pytest.raises(ValidationError):
            SuggestedStructure(
                equity_pct=10, sba_loan_pct=70, seller_note_pct=10,
                estimated_monthly_debt_service=Decimal("4200.00"),
            )


class TestAIUpside:
    def test_valid_range(self):
        u = AIUpside(
            score=Decimal("82"),
            opportunities=["Automation", "Pricing", "CRM"],
            value_multiplier_low=2.5,
            value_multiplier_high=3.5,
        )
        assert u.value_multiplier_high - u.value_multiplier_low == 1.0

    def test_rejects_inverted_range(self):
        with pytest.raises(ValidationError):
            AIUpside(
                score=Decimal("82"),
                opportunities=["x"],
                value_multiplier_low=3.5,
                value_multiplier_high=2.5,
            )

    def test_rejects_too_wide_spread(self):
        with pytest.raises(ValidationError) as exc:
            AIUpside(
                score=Decimal("82"),
                opportunities=["x"],
                value_multiplier_low=1.5,
                value_multiplier_high=5.0,
            )
        assert "too wide" in str(exc.value)


class TestFinancialAnalysisPlainSummary:
    def _base_kwargs(self):
        return dict(
            reconstructed_sde=Decimal("180000"),
            dscr=1.42,
            cash_on_cash_y1=0.18,
            equity_required=Decimal("45000"),
            seller_financing=True,
            sba_eligible=True,
            suggested_structure=SuggestedStructure(
                equity_pct=10, sba_loan_pct=80, seller_note_pct=10,
                estimated_monthly_debt_service=Decimal("4200"),
            ),
            projections=CashFlowProjections(
                y1_conservative=Decimal("150000"), y1_base=Decimal("180000"), y1_optimistic=Decimal("210000"),
                y3_conservative=Decimal("160000"), y3_base=Decimal("210000"), y3_optimistic=Decimal("260000"),
            ),
            self_financing_score=Decimal("78"),
            financial_score=Decimal("72"),
            risk_flags=[],
        )

    def test_accepts_plain_summary(self):
        fa = FinancialAnalysis(
            **self._base_kwargs(),
            plain_summary="Buen negocio de HVAC. Genera 180 mil al año y se paga su propia deuda con holgura. El dueño lleva la operación solo, hay que planear la transición.",
        )
        assert "HVAC" in fa.plain_summary

    def test_rejects_jargon_dscr(self):
        with pytest.raises(ValidationError) as exc:
            FinancialAnalysis(
                **self._base_kwargs(),
                plain_summary="Strong DSCR of 1.42x indicates the business covers its debt service comfortably.",
            )
        assert "dscr" in str(exc.value).lower()

    def test_rejects_jargon_ebitda(self):
        with pytest.raises(ValidationError) as exc:
            FinancialAnalysis(
                **self._base_kwargs(),
                plain_summary="Healthy EBITDA margins with strong cash conversion.",
            )
        assert "ebitda" in str(exc.value).lower()
