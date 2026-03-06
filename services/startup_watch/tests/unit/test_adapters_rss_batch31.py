from types import SimpleNamespace

from startup_watch.adapters.maddyness import MaddynessAdapter
from startup_watch.adapters.startupnewsasia import StartupnewsasiaAdapter
from startup_watch.adapters.techfundingasia import TechfundingasiaAdapter


def _fake_feed() -> SimpleNamespace:
    return SimpleNamespace(
        entries=[
            SimpleNamespace(
                title="Example startup raises round",
                link="https://example.com/funding",
                summary="Company building AI software for industrial operations.",
            )
        ]
    )


def test_maddyness_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.maddyness.feedparser.parse", lambda _url: _fake_feed())
    adapter = MaddynessAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "maddyness"


def test_techfundingasia_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.techfundingasia.feedparser.parse", lambda _url: _fake_feed())
    adapter = TechfundingasiaAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "techfundingasia"


def test_startupnewsasia_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.startupnewsasia.feedparser.parse", lambda _url: _fake_feed())
    adapter = StartupnewsasiaAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "startupnewsasia"
