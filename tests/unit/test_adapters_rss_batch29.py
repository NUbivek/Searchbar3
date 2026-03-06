from types import SimpleNamespace

from startup_watch.adapters.echelonasia import EchelonasiaAdapter
from startup_watch.adapters.technin_asia import TechninAsiaAdapter
from startup_watch.adapters.techsauce import TechsauceAdapter


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


def test_techsauce_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.techsauce.feedparser.parse", lambda _url: _fake_feed())
    adapter = TechsauceAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "techsauce"


def test_echelonasia_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.echelonasia.feedparser.parse", lambda _url: _fake_feed())
    adapter = EchelonasiaAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "echelonasia"


def test_technin_asia_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.technin_asia.feedparser.parse", lambda _url: _fake_feed())
    adapter = TechninAsiaAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "technin_asia"
