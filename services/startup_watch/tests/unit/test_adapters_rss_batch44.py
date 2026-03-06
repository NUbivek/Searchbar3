from types import SimpleNamespace

from startup_watch.adapters.venturecapitaljournal import VenturecapitaljournalAdapter
from startup_watch.adapters.privateequitywire_vc import PrivateequitywireVcAdapter
from startup_watch.adapters.globalventuring import GlobalventuringAdapter
from startup_watch.adapters.thehumancapital import ThehumancapitalAdapter
from startup_watch.adapters.startupsatellite import StartupsatelliteAdapter


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


def test_venturecapitaljournal_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.venturecapitaljournal.feedparser.parse", lambda _url: _fake_feed())
    adapter = VenturecapitaljournalAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "venturecapitaljournal"

def test_privateequitywire_vc_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.privateequitywire_vc.feedparser.parse", lambda _url: _fake_feed())
    adapter = PrivateequitywireVcAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "privateequitywire_vc"

def test_globalventuring_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.globalventuring.feedparser.parse", lambda _url: _fake_feed())
    adapter = GlobalventuringAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "globalventuring"

def test_thehumancapital_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.thehumancapital.feedparser.parse", lambda _url: _fake_feed())
    adapter = ThehumancapitalAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "thehumancapital"

def test_startupsatellite_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.startupsatellite.feedparser.parse", lambda _url: _fake_feed())
    adapter = StartupsatelliteAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "startupsatellite"
