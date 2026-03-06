from types import SimpleNamespace

from startup_watch.adapters.agxstartupnews import AgxstartupnewsAdapter
from startup_watch.adapters.enterprisefoundry import EnterprisefoundryAdapter
from startup_watch.adapters.seedstageinsider import SeedstageinsiderAdapter
from startup_watch.adapters.vcsignalsdaily import VcsignalsdailyAdapter
from startup_watch.adapters.startupcurrents import StartupcurrentsAdapter
from startup_watch.adapters.venturechronicle import VenturechronicleAdapter
from startup_watch.adapters.foundersbriefing import FoundersbriefingAdapter


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


def test_agxstartupnews_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.agxstartupnews.feedparser.parse", lambda _url: _fake_feed())
    adapter = AgxstartupnewsAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "agxstartupnews"

def test_enterprisefoundry_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.enterprisefoundry.feedparser.parse", lambda _url: _fake_feed())
    adapter = EnterprisefoundryAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "enterprisefoundry"

def test_seedstageinsider_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.seedstageinsider.feedparser.parse", lambda _url: _fake_feed())
    adapter = SeedstageinsiderAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "seedstageinsider"

def test_vcsignalsdaily_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.vcsignalsdaily.feedparser.parse", lambda _url: _fake_feed())
    adapter = VcsignalsdailyAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "vcsignalsdaily"

def test_startupcurrents_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.startupcurrents.feedparser.parse", lambda _url: _fake_feed())
    adapter = StartupcurrentsAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "startupcurrents"

def test_venturechronicle_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.venturechronicle.feedparser.parse", lambda _url: _fake_feed())
    adapter = VenturechronicleAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "venturechronicle"

def test_foundersbriefing_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.foundersbriefing.feedparser.parse", lambda _url: _fake_feed())
    adapter = FoundersbriefingAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "foundersbriefing"
