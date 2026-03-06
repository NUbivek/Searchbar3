from types import SimpleNamespace

from startup_watch.adapters.arcticstartup import ArcticstartupAdapter
from startup_watch.adapters.eu_startups_news import EuStartupsNewsAdapter
from startup_watch.adapters.uktechnews import UktechnewsAdapter
from startup_watch.adapters.irishtechnews import IrishtechnewsAdapter
from startup_watch.adapters.techpluto import TechplutoAdapter


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


def test_arcticstartup_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.arcticstartup.feedparser.parse", lambda _url: _fake_feed())
    adapter = ArcticstartupAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "arcticstartup"

def test_eu_startups_news_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.eu_startups_news.feedparser.parse", lambda _url: _fake_feed())
    adapter = EuStartupsNewsAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "eu_startups_news"

def test_uktechnews_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.uktechnews.feedparser.parse", lambda _url: _fake_feed())
    adapter = UktechnewsAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "uktechnews"

def test_irishtechnews_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.irishtechnews.feedparser.parse", lambda _url: _fake_feed())
    adapter = IrishtechnewsAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "irishtechnews"

def test_techpluto_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.techpluto.feedparser.parse", lambda _url: _fake_feed())
    adapter = TechplutoAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "techpluto"
