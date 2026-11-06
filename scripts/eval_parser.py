"""Оцінка якості розбору запитів на 30 тестових запитах — НАЖИВО (витрачає кошти DeepSeek).

    uv run python scripts/eval_parser.py            # звіт: точність, помилки, вартість
    uv run python scripts/eval_parser.py --record   # + перезаписати відповіді для pytest

Потрібні DEEPSEEK_API_KEY у .env. Модель — LLM_MODEL_PARSER.
"""

import argparse
import asyncio
import json
from decimal import Decimal

import httpx

from tickets_api.ai.evaluation import (
    RECORDED_DIR,
    RecordingClient,
    check,
    dump_responses,
    load_cases,
    stub_cheapest_day,
)
from tickets_api.ai.parser import QueryParser
from tickets_api.core.config import Settings
from tickets_api.llm.deepseek import DeepSeekClient
from tickets_api.llm.metered import MeteredLLM
from tickets_api.llm.pricing import default_pricing
from tickets_api.reference.airports import default_airport_directory


async def main(record: bool) -> None:
    settings = Settings()
    if settings.deepseek_api_key is None:
        raise SystemExit("Потрібен DEEPSEEK_API_KEY у .env")
    cases, known = load_cases()
    parser = QueryParser(
        default_airport_directory(),
        model=settings.llm_model_parser,
        cheapest_day=stub_cheapest_day,
        prompts_dir=settings.llm_prompts_dir,
    )
    total_cost = Decimal(0)
    failed: list[str] = []
    async with httpx.AsyncClient() as http:
        client = DeepSeekClient(
            http,
            settings.deepseek_api_key.get_secret_value(),
            base_url=settings.deepseek_base_url,
            timeout_s=settings.llm_timeout_s,
        )

        async def run(case_index: int) -> None:
            nonlocal total_cost
            case = cases[case_index]
            recorder = RecordingClient(client)
            llm = MeteredLLM(
                recorder,
                purpose="eval",
                pricing=default_pricing(),
                max_calls=settings.llm_max_calls_per_search,
            )
            result = await parser.parse(case.message, case.context, llm)
            errors = check(result, case.expected)
            total_cost += llm.cost_usd or Decimal(0)
            mark = "✓" if not errors else ("~" if case.id in known else "✗")
            print(f"{mark} {case.id:24} {result.status:11} calls={llm.calls} ${llm.cost_usd}")
            for e in errors:
                print(f"      {e}")
            if errors:
                failed.append(case.id)
            if record:
                RECORDED_DIR.mkdir(exist_ok=True)
                (RECORDED_DIR / f"{case.id}.json").write_text(
                    json.dumps(dump_responses(recorder.responses), ensure_ascii=False, indent=1)
                    + "\n"
                )

        # Невеликими пачками: швидше, але без сплеску запитів.
        for start in range(0, len(cases), 5):
            await asyncio.gather(*(run(i) for i in range(start, min(start + 5, len(cases)))))

    passed = len(cases) - len(failed)
    print(f"\nТочність: {passed}/{len(cases)} ({passed / len(cases):.0%}), вартість ${total_cost}")
    if failed:
        print("Не пройшли:", ", ".join(failed))


if __name__ == "__main__":
    args = argparse.ArgumentParser()
    args.add_argument("--record", action="store_true", help="записати відповіді для pytest")
    asyncio.run(main(args.parse_args().record))
