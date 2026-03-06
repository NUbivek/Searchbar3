from types import SimpleNamespace

from startup_watch.adapters.finsmes import FinsmesAdapter
from startup_watch.adapters.greenqueen import GreenqueenAdapter
from startup_watch.adapters.techfundingnews import TechfundingnewsAdapter


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


def test_techfundingnews_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.techfundingnews.feedparser.parse", lambda _url: _fake_feed())
    adapter = TechfundingnewsAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "techfundingnews"


def test_greenqueen_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.greenqueen.feedparser.parse", lambda _url: _fake_feed())
    adapter = GreenqueenAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "greenqueen"


def test_finsmes_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.finsmes.feedparser.parse", lambda _url: _fake_feed())
    adapter = FinsmesAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "finsmes"
