from types import SimpleNamespace

from startup_watch.adapters.entrepreneurshiplife import EntrepreneurshiplifeAdapter
from startup_watch.adapters.innovationorigins import InnovationoriginsAdapter
from startup_watch.adapters.startupbeat import StartupbeatAdapter


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


def test_startupbeat_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.startupbeat.feedparser.parse", lambda _url: _fake_feed())
    adapter = StartupbeatAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "startupbeat"


def test_entrepreneurshiplife_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.entrepreneurshiplife.feedparser.parse", lambda _url: _fake_feed())
    adapter = EntrepreneurshiplifeAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "entrepreneurshiplife"


def test_innovationorigins_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.innovationorigins.feedparser.parse", lambda _url: _fake_feed())
    adapter = InnovationoriginsAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "innovationorigins"
