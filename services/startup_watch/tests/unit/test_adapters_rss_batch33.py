from types import SimpleNamespace

from startup_watch.adapters.menabytes import MenabytesAdapter
from startup_watch.adapters.magnitt import MagnittAdapter
from startup_watch.adapters.wadi_mena import WadiMenaAdapter
from startup_watch.adapters.startupbahrain import StartupbahrainAdapter
from startup_watch.adapters.techjuice import TechjuiceAdapter


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


def test_menabytes_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.menabytes.feedparser.parse", lambda _url: _fake_feed())
    adapter = MenabytesAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "menabytes"

def test_magnitt_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.magnitt.feedparser.parse", lambda _url: _fake_feed())
    adapter = MagnittAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "magnitt"

def test_wadi_mena_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.wadi_mena.feedparser.parse", lambda _url: _fake_feed())
    adapter = WadiMenaAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "wadi_mena"

def test_startupbahrain_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.startupbahrain.feedparser.parse", lambda _url: _fake_feed())
    adapter = StartupbahrainAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "startupbahrain"

def test_techjuice_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.techjuice.feedparser.parse", lambda _url: _fake_feed())
    adapter = TechjuiceAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "techjuice"
