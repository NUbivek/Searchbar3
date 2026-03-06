from types import SimpleNamespace

from startup_watch.adapters.builtin import BuiltinAdapter
from startup_watch.adapters.techinasia import TechinasiaAdapter
from startup_watch.adapters.yourstory import YourstoryAdapter


def _fake_feed() -> SimpleNamespace:
    return SimpleNamespace(
        entries=[
            SimpleNamespace(
                title="Example startup raises round",
                link="https://example.com/funding",
                summary="Company building software for industrial operations.",
            )
        ]
    )


def test_techinasia_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.techinasia.feedparser.parse", lambda _url: _fake_feed())
    adapter = TechinasiaAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "techinasia"


def test_yourstory_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.yourstory.feedparser.parse", lambda _url: _fake_feed())
    adapter = YourstoryAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "yourstory"


def test_builtin_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.builtin.feedparser.parse", lambda _url: _fake_feed())
    adapter = BuiltinAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "builtin"
