"""Системні промпти ролей: rules/rules.md (спільні правила) + sub-agents/<Роль>.md.

Файли — вхідні матеріали власника в корені репозиторію; код їх лише читає.
У Docker-образ вони копіюються поряд з apps/ (див. apps/api/Dockerfile).
"""

from functools import lru_cache
from pathlib import Path
from typing import Literal

Role = Literal["Query-Parser", "Flight-Deal-Advisor", "Stay-Analyst"]
RULES = Path("rules") / "rules.md"
_HERE = Path(__file__).resolve()


def find_prompts_dir(start: Path = _HERE) -> Path:
    """Перший батьківський каталог, де є rules/rules.md (корінь репозиторію чи /app)."""
    for parent in start.parents:
        if (parent / RULES).is_file():
            return parent
    raise FileNotFoundError("rules/rules.md не знайдено — задайте LLM_PROMPTS_DIR")


@lru_cache
def system_prompt(role: Role, prompts_dir: Path | None = None) -> str:
    root = prompts_dir or find_prompts_dir()
    rules = (root / RULES).read_text(encoding="utf-8").strip()
    role_text = (root / "sub-agents" / f"{role}.md").read_text(encoding="utf-8").strip()
    return f"{rules}\n\n{role_text}"
