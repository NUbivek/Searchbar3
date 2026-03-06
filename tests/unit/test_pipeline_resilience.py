from types import SimpleNamespace

from startup_watch.pipeline import fetch_with_resilience
from startup_watch.schema import StartupSignal


class _FlakyAdapter:
    source_name = "flaky"

    def __init__(self) -> None:
        self.calls = 0

    def fetch(self) -> list[StartupSignal]:
        self.calls += 1
        if self.calls < 2:
            raise RuntimeError("temporary")
        return [
            StartupSignal(
                company_name="Acme",
                description="desc",
                stage="seed",
                categories=["industrial software"],
                source_name=self.source_name,
                source_url="https://example.com",
            )
        ]


class _BrokenAdapter:
    source_name = "broken"

    def fetch(self) -> list[StartupSignal]:
        raise RuntimeError("always fails")


def test_fetch_with_resilience_retries_and_succeeds(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.pipeline.time.sleep", lambda _s: None)
    adapter = _FlakyAdapter()
    logger = SimpleNamespace(info=lambda *a, **k: None, warning=lambda *a, **k: None)

    signals = fetch_with_resilience(adapter, logger, retries=2, backoff_seconds=0.1)

    assert len(signals) == 1
    assert adapter.calls == 2


def test_fetch_with_resilience_returns_empty_after_failures(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.pipeline.time.sleep", lambda _s: None)
    adapter = _BrokenAdapter()
    logger = SimpleNamespace(info=lambda *a, **k: None, warning=lambda *a, **k: None)

    signals = fetch_with_resilience(adapter, logger, retries=2, backoff_seconds=0.1)

    assert signals == []
