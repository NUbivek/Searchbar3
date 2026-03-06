from types import SimpleNamespace

from startup_watch.adapters.agweb import AgwebAdapter
from startup_watch.adapters.logisticsmgmt import LogisticsmgmtAdapter
from startup_watch.adapters.supplychainbrain import SupplychainbrainAdapter


def _fake_feed() -> SimpleNamespace:
    return SimpleNamespace(
        entries=[
            SimpleNamespace(
                title="Example startup update",
                link="https://example.com/news",
                summary="Early-stage startup shipping logistics software.",
            )
        ]
    )


def test_supplychainbrain_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr(
        "startup_watch.adapters.supplychainbrain.feedparser.parse",
        lambda _url: _fake_feed(),
    )
    adapter = SupplychainbrainAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "supplychainbrain"


def test_logisticsmgmt_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr(
        "startup_watch.adapters.logisticsmgmt.feedparser.parse",
        lambda _url: _fake_feed(),
    )
    adapter = LogisticsmgmtAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "logisticsmgmt"


def test_agweb_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr(
        "startup_watch.adapters.agweb.feedparser.parse",
        lambda _url: _fake_feed(),
    )
    adapter = AgwebAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "agweb"
