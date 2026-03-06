from types import SimpleNamespace

from startup_watch.adapters.benjamindada import BenjamindadaAdapter
from startup_watch.adapters.techcabal import TechcabalAdapter
from startup_watch.adapters.technext_ng import TechnextNgAdapter


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


def test_techcabal_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.techcabal.feedparser.parse", lambda _url: _fake_feed())
    adapter = TechcabalAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "techcabal"


def test_benjamindada_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.benjamindada.feedparser.parse", lambda _url: _fake_feed())
    adapter = BenjamindadaAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "benjamindada"


def test_technext_ng_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.technext_ng.feedparser.parse", lambda _url: _fake_feed())
    adapter = TechnextNgAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "technext_ng"
