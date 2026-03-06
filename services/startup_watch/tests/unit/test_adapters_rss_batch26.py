from types import SimpleNamespace

from startup_watch.adapters.techweez import TechweezAdapter
from startup_watch.adapters.ventureburn import VentureburnAdapter
from startup_watch.adapters.venturesafrica import VenturesafricaAdapter


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


def test_techweez_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.techweez.feedparser.parse", lambda _url: _fake_feed())
    adapter = TechweezAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "techweez"


def test_ventureburn_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.ventureburn.feedparser.parse", lambda _url: _fake_feed())
    adapter = VentureburnAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "ventureburn"


def test_venturesafrica_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.venturesafrica.feedparser.parse", lambda _url: _fake_feed())
    adapter = VenturesafricaAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "venturesafrica"
