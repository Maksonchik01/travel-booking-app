"""Назви авіакомпаній за IATA-кодом (знімок airlines.json, scripts/update_reference_data.py)."""

import json
from functools import lru_cache
from pathlib import Path

DATA_PATH = Path(__file__).with_name("airlines.json")


@lru_cache
def default_airline_names() -> dict[str, str]:
    names: dict[str, str] = json.loads(DATA_PATH.read_text())
    return names
