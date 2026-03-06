from types import SimpleNamespace

from startup_watch.adapters.dealstreetasia import DealstreetasiaAdapter
from startup_watch.adapters.entrackr import EntrackrAdapter
from startup_watch.adapters.inc42 import Inc42Adapter


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


def test_inc42_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.inc42.feedparser.parse", lambda _url: _fake_feed())
    adapter = Inc42Adapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "inc42"


def test_entrackr_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.entrackr.feedparser.parse", lambda _url: _fake_feed())
    adapter = EntrackrAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "entrackr"


def test_dealstreetasia_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.dealstreetasia.feedparser.parse", lambda _url: _fake_feed())
    adapter = DealstreetasiaAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "dealstreetasia"
