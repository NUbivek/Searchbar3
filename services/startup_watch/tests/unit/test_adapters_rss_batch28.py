from types import SimpleNamespace

from startup_watch.adapters.kr_asia import KrAsiaAdapter
from startup_watch.adapters.techloy import TechloyAdapter
from startup_watch.adapters.technode import TechnodeAdapter


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


def test_techloy_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.techloy.feedparser.parse", lambda _url: _fake_feed())
    adapter = TechloyAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "techloy"


def test_kr_asia_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.kr_asia.feedparser.parse", lambda _url: _fake_feed())
    adapter = KrAsiaAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "kr_asia"


def test_technode_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.technode.feedparser.parse", lambda _url: _fake_feed())
    adapter = TechnodeAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "technode"
