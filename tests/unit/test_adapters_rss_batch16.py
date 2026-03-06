from types import SimpleNamespace

from startup_watch.adapters.latitud import LatitudAdapter
from startup_watch.adapters.refreshmiami import RefreshmiamiAdapter
from startup_watch.adapters.startupnewsfyi import StartupnewsfyiAdapter


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


def test_startupnewsfyi_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.startupnewsfyi.feedparser.parse", lambda _url: _fake_feed())
    adapter = StartupnewsfyiAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "startupnewsfyi"


def test_latitud_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.latitud.feedparser.parse", lambda _url: _fake_feed())
    adapter = LatitudAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "latitud"


def test_refreshmiami_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.refreshmiami.feedparser.parse", lambda _url: _fake_feed())
    adapter = RefreshmiamiAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "refreshmiami"
