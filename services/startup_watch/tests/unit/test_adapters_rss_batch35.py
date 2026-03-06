from types import SimpleNamespace

from startup_watch.adapters.europeanstartups import EuropeanstartupsAdapter
from startup_watch.adapters.startupobserver import StartupobserverAdapter
from startup_watch.adapters.startupsavant import StartupsavantAdapter
from startup_watch.adapters.techrasa import TechrasaAdapter
from startup_watch.adapters.techgistafrica import TechgistafricaAdapter


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


def test_europeanstartups_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.europeanstartups.feedparser.parse", lambda _url: _fake_feed())
    adapter = EuropeanstartupsAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "europeanstartups"

def test_startupobserver_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.startupobserver.feedparser.parse", lambda _url: _fake_feed())
    adapter = StartupobserverAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "startupobserver"

def test_startupsavant_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.startupsavant.feedparser.parse", lambda _url: _fake_feed())
    adapter = StartupsavantAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "startupsavant"

def test_techrasa_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.techrasa.feedparser.parse", lambda _url: _fake_feed())
    adapter = TechrasaAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "techrasa"

def test_techgistafrica_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.techgistafrica.feedparser.parse", lambda _url: _fake_feed())
    adapter = TechgistafricaAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "techgistafrica"
