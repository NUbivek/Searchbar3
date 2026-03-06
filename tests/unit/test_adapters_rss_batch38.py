from types import SimpleNamespace

from startup_watch.adapters.innov8tiv import Innov8tivAdapter
from startup_watch.adapters.smesouthafrica import SmesouthafricaAdapter
from startup_watch.adapters.techawkng import TechawkngAdapter
from startup_watch.adapters.technovagh import TechnovaghAdapter
from startup_watch.adapters.afritechie import AfritechieAdapter


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


def test_innov8tiv_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.innov8tiv.feedparser.parse", lambda _url: _fake_feed())
    adapter = Innov8tivAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "innov8tiv"

def test_smesouthafrica_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.smesouthafrica.feedparser.parse", lambda _url: _fake_feed())
    adapter = SmesouthafricaAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "smesouthafrica"

def test_techawkng_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.techawkng.feedparser.parse", lambda _url: _fake_feed())
    adapter = TechawkngAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "techawkng"

def test_technovagh_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.technovagh.feedparser.parse", lambda _url: _fake_feed())
    adapter = TechnovaghAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "technovagh"

def test_afritechie_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.afritechie.feedparser.parse", lambda _url: _fake_feed())
    adapter = AfritechieAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "afritechie"
