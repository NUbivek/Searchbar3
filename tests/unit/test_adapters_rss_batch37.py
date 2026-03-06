from types import SimpleNamespace

from startup_watch.adapters.siliconangle_startups import SiliconangleStartupsAdapter
from startup_watch.adapters.readwrite_startups import ReadwriteStartupsAdapter
from startup_watch.adapters.techinformed import TechinformedAdapter
from startup_watch.adapters.startupdaily_africa import StartupdailyAfricaAdapter
from startup_watch.adapters.techlabari import TechlabariAdapter


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


def test_siliconangle_startups_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.siliconangle_startups.feedparser.parse", lambda _url: _fake_feed())
    adapter = SiliconangleStartupsAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "siliconangle_startups"

def test_readwrite_startups_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.readwrite_startups.feedparser.parse", lambda _url: _fake_feed())
    adapter = ReadwriteStartupsAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "readwrite_startups"

def test_techinformed_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.techinformed.feedparser.parse", lambda _url: _fake_feed())
    adapter = TechinformedAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "techinformed"

def test_startupdaily_africa_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.startupdaily_africa.feedparser.parse", lambda _url: _fake_feed())
    adapter = StartupdailyAfricaAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "startupdaily_africa"

def test_techlabari_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.techlabari.feedparser.parse", lambda _url: _fake_feed())
    adapter = TechlabariAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "techlabari"
