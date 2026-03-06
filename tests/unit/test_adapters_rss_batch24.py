from types import SimpleNamespace

from startup_watch.adapters.tech_ish import TechIshAdapter
from startup_watch.adapters.techafricanews import TechafricanewsAdapter
from startup_watch.adapters.techtrendske import TechtrendskeAdapter


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


def test_techafricanews_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.techafricanews.feedparser.parse", lambda _url: _fake_feed())
    adapter = TechafricanewsAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "techafricanews"


def test_techtrendske_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.techtrendske.feedparser.parse", lambda _url: _fake_feed())
    adapter = TechtrendskeAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "techtrendske"


def test_tech_ish_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.tech_ish.feedparser.parse", lambda _url: _fake_feed())
    adapter = TechIshAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "tech_ish"
