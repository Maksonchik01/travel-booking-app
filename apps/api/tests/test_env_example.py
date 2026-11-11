"""Безпечне розгортання (V3, етап 11): кожна змінна `Settings` описана в `.env.example`.

Нова змінна без рядка в прикладі — легко забути в Render/Vercel. Винятки — технічні адреси й
тайм-аути, які змінюють лише тести й локальні фейкові джерела.
"""

import re
from pathlib import Path

from tickets_api.core.config import Settings

EXAMPLE = Path(__file__).resolve().parents[3] / ".env.example"
TECHNICAL = {
    "READINESS_TIMEOUT_S",
    "DEEPSEEK_BASE_URL",
    "TRAVELPAYOUTS_BASE_URL",
    "TELEGRAM_BASE_URL",
    "SERPAPI_BASE_URL",
    "SERPAPI_REQUEST_TIMEOUT_S",
    "SCRAPEDO_BASE_URL",
    "SCRAPEDO_REQUEST_TIMEOUT_S",
}


def test_every_setting_is_documented_in_env_example() -> None:
    documented = set(re.findall(r"^#?\s*([A-Z][A-Z0-9_]+)=", EXAMPLE.read_text(), re.MULTILINE))
    names = {name.upper() for name in Settings.model_fields}

    assert sorted(names - documented - TECHNICAL) == []
    assert sorted(TECHNICAL - names) == []  # винятки не застарівають
