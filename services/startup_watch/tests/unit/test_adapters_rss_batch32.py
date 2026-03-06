from types import SimpleNamespace

from startup_watch.adapters.africanbusiness_tech import AfricanbusinessTechAdapter
from startup_watch.adapters.bloomingstartup import BloomingstartupAdapter
from startup_watch.adapters.vietcetera import VietceteraAdapter


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


def test_vietcetera_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.vietcetera.feedparser.parse", lambda _url: _fake_feed())
    adapter = VietceteraAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "vietcetera"


def test_bloomingstartup_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.bloomingstartup.feedparser.parse", lambda _url: _fake_feed())
    adapter = BloomingstartupAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "bloomingstartup"


def test_africanbusiness_tech_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.africanbusiness_tech.feedparser.parse", lambda _url: _fake_feed())
    adapter = AfricanbusinessTechAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "africanbusiness_tech"
