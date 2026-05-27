from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml
from pydantic_settings import BaseSettings, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CONFIG_YAML = PROJECT_ROOT / "config.yaml"
DATA_DIR = PROJECT_ROOT / "data"


class Settings(BaseSettings):
    """Secrets only — anything that varies per environment or must not be committed."""

    model_config = SettingsConfigDict(
        env_file=PROJECT_ROOT / ".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # BizScout requires authentication. Either email+password or a pre-extracted session cookie.
    BIZSCOUT_EMAIL: str = ""
    BIZSCOUT_PASSWORD: str = ""
    BIZSCOUT_COOKIE: str = ""

    # Used by the routine when committing data updates back to GitHub.
    GITHUB_TOKEN: str = ""

    LOG_LEVEL: str = "INFO"


class YamlConfig:
    """Domain config from config.yaml — committed to the repo, no secrets."""

    def __init__(self, path: Path = CONFIG_YAML) -> None:
        with path.open("r", encoding="utf-8") as f:
            self._data: dict[str, Any] = yaml.safe_load(f)
        self._validate()

    def _validate(self) -> None:
        weights = self._data["scoring_weights"]
        total = sum(weights.values())
        if abs(total - 1.0) > 1e-6:
            raise ValueError(f"scoring_weights must sum to 1.0, got {total}")

    @property
    def acquisition(self) -> dict[str, Any]:
        return self._data["acquisition"]

    @property
    def scoring_weights(self) -> dict[str, float]:
        return self._data["scoring_weights"]

    @property
    def priority_thresholds(self) -> dict[str, int]:
        return self._data["priority_thresholds"]

    @property
    def auto_analyze_filter_score_threshold(self) -> int:
        return self._data["auto_analyze_filter_score_threshold"]

    @property
    def strategy_activation_threshold(self) -> int:
        return self._data["strategy_activation_threshold"]

    @property
    def scraping_sources(self) -> list[dict[str, Any]]:
        return self._data["scraping"]["sources"]

    @property
    def default_user_agents(self) -> list[str]:
        return self._data["scraping"]["default_user_agents"]

    @property
    def blacklist_categories(self) -> list[str]:
        return self._data["blacklist_categories"]

    @property
    def ai_upside_industries(self) -> list[str]:
        return self._data["ai_upside_high_potential_industries"]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


@lru_cache(maxsize=1)
def get_yaml_config() -> YamlConfig:
    return YamlConfig()
