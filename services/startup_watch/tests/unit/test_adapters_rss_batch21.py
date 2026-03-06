from types import SimpleNamespace

from startup_watch.adapters.itweb_africa import ItwebAfricaAdapter
from startup_watch.adapters.siliconrepublic import SiliconrepublicAdapter
from startup_watch.adapters.startupill import StartupillAdapter


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


def test_siliconrepublic_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.siliconrepublic.feedparser.parse", lambda _url: _fake_feed())
    adapter = SiliconrepublicAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "siliconrepublic"


def test_itweb_africa_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.itweb_africa.feedparser.parse", lambda _url: _fake_feed())
    adapter = ItwebAfricaAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "itweb_africa"


def test_startupill_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.startupill.feedparser.parse", lambda _url: _fake_feed())
    adapter = StartupillAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "startupill"
