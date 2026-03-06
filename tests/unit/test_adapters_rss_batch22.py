from types import SimpleNamespace

from startup_watch.adapters.devdiscourse import DevdiscourseAdapter
from startup_watch.adapters.futurescot import FuturescotAdapter
from startup_watch.adapters.techbuild_africa import TechbuildAfricaAdapter


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


def test_devdiscourse_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.devdiscourse.feedparser.parse", lambda _url: _fake_feed())
    adapter = DevdiscourseAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "devdiscourse"


def test_techbuild_africa_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.techbuild_africa.feedparser.parse", lambda _url: _fake_feed())
    adapter = TechbuildAfricaAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "techbuild_africa"


def test_futurescot_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.futurescot.feedparser.parse", lambda _url: _fake_feed())
    adapter = FuturescotAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "futurescot"
