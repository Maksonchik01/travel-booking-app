from typing import Any

from tickets_worker.settings import WorkerSettings
from tickets_worker.tasks import check_alerts, ping, poll_telegram


class FakeAlerts:
    async def check_all(self) -> int:
        return 2


class FakeBot:
    async def poll(self) -> int:
        return 3


async def test_ping_returns_pong() -> None:
    assert await ping({"job_id": "test"}) == "pong"


async def test_alert_tasks_use_service_from_context() -> None:
    ctx: dict[str, Any] = {"alerts": FakeAlerts(), "bot": FakeBot()}
    assert await check_alerts(ctx) == 2
    assert await poll_telegram(ctx) == 3


def test_tasks_and_schedule_are_registered() -> None:
    assert {ping, check_alerts, poll_telegram} <= set(WorkerSettings.functions)
    scheduled = {job.coroutine for job in WorkerSettings.cron_jobs}
    assert scheduled == {check_alerts, poll_telegram}
