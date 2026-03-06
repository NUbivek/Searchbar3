from types import SimpleNamespace

from startup_watch.adapters.memeburn import MemeburnAdapter
from startup_watch.adapters.techmoran import TechmoranAdapter
from startup_watch.adapters.weetracker import WeetrackerAdapter


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


def test_techmoran_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.techmoran.feedparser.parse", lambda _url: _fake_feed())
    adapter = TechmoranAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "techmoran"


def test_memeburn_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.memeburn.feedparser.parse", lambda _url: _fake_feed())
    adapter = MemeburnAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "memeburn"


def test_weetracker_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.weetracker.feedparser.parse", lambda _url: _fake_feed())
    adapter = WeetrackerAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "weetracker"
