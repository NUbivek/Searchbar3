from types import SimpleNamespace

from startup_watch.adapters.industryweek import IndustryweekAdapter
from startup_watch.adapters.mfg_dive import MfgDiveAdapter
from startup_watch.adapters.mmh import MmhAdapter


def _fake_feed() -> SimpleNamespace:
    return SimpleNamespace(
        entries=[
            SimpleNamespace(
                title="Example industrial startup raises round",
                link="https://example.com/funding",
                summary="Company building automation software for factories.",
            )
        ]
    )


def test_mmh_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.mmh.feedparser.parse", lambda _url: _fake_feed())
    adapter = MmhAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "mmh"


def test_mfg_dive_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.mfg_dive.feedparser.parse", lambda _url: _fake_feed())
    adapter = MfgDiveAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "mfg_dive"


def test_industryweek_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.industryweek.feedparser.parse", lambda _url: _fake_feed())
    adapter = IndustryweekAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "industryweek"
