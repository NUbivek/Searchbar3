from types import SimpleNamespace

from startup_watch.adapters.startupreporter import StartupreporterAdapter
from startup_watch.adapters.foundersradar import FoundersradarAdapter
from startup_watch.adapters.deeptechdigest import DeeptechdigestAdapter
from startup_watch.adapters.futurefoundersnews import FuturefoundersnewsAdapter
from startup_watch.adapters.nextventuredaily import NextventuredailyAdapter
from startup_watch.adapters.startupwireglobal import StartupwireglobalAdapter
from startup_watch.adapters.frontierstartups import FrontierstartupsAdapter
from startup_watch.adapters.climatestartupsnews import ClimatestartupsnewsAdapter
from startup_watch.adapters.industriousventures import IndustriousventuresAdapter
from startup_watch.adapters.logisticstechnews import LogisticstechnewsAdapter


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


def test_startupreporter_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.startupreporter.feedparser.parse", lambda _url: _fake_feed())
    adapter = StartupreporterAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "startupreporter"

def test_foundersradar_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.foundersradar.feedparser.parse", lambda _url: _fake_feed())
    adapter = FoundersradarAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "foundersradar"

def test_deeptechdigest_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.deeptechdigest.feedparser.parse", lambda _url: _fake_feed())
    adapter = DeeptechdigestAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "deeptechdigest"

def test_futurefoundersnews_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.futurefoundersnews.feedparser.parse", lambda _url: _fake_feed())
    adapter = FuturefoundersnewsAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "futurefoundersnews"

def test_nextventuredaily_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.nextventuredaily.feedparser.parse", lambda _url: _fake_feed())
    adapter = NextventuredailyAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "nextventuredaily"

def test_startupwireglobal_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.startupwireglobal.feedparser.parse", lambda _url: _fake_feed())
    adapter = StartupwireglobalAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "startupwireglobal"

def test_frontierstartups_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.frontierstartups.feedparser.parse", lambda _url: _fake_feed())
    adapter = FrontierstartupsAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "frontierstartups"

def test_climatestartupsnews_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.climatestartupsnews.feedparser.parse", lambda _url: _fake_feed())
    adapter = ClimatestartupsnewsAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "climatestartupsnews"

def test_industriousventures_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.industriousventures.feedparser.parse", lambda _url: _fake_feed())
    adapter = IndustriousventuresAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "industriousventures"

def test_logisticstechnews_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.logisticstechnews.feedparser.parse", lambda _url: _fake_feed())
    adapter = LogisticstechnewsAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "logisticstechnews"
