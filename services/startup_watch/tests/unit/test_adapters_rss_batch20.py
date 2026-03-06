from types import SimpleNamespace

from startup_watch.adapters.disruptafrica import DisruptafricaAdapter
from startup_watch.adapters.therecursive import TherecursiveAdapter
from startup_watch.adapters.vested import VestedAdapter


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


def test_disruptafrica_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.disruptafrica.feedparser.parse", lambda _url: _fake_feed())
    adapter = DisruptafricaAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "disruptafrica"


def test_vested_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.vested.feedparser.parse", lambda _url: _fake_feed())
    adapter = VestedAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "vested"


def test_therecursive_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.therecursive.feedparser.parse", lambda _url: _fake_feed())
    adapter = TherecursiveAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "therecursive"
