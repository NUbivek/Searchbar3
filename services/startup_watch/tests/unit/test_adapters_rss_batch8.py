from types import SimpleNamespace

from startup_watch.adapters.agdaily import AgdailyAdapter
from startup_watch.adapters.supplychaindive import SupplychaindiveAdapter
from startup_watch.adapters.therobotreport import TherobotreportAdapter


def _fake_feed() -> SimpleNamespace:
    return SimpleNamespace(
        entries=[
            SimpleNamespace(
                title="Acme Robotics raises seed",
                link="https://example.com/acme",
                summary="Industrial startup for warehouse robotics.",
            )
        ]
    )


def test_supplychaindive_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.supplychaindive.feedparser.parse", lambda _url: _fake_feed())
    adapter = SupplychaindiveAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "supplychaindive"


def test_therobotreport_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.therobotreport.feedparser.parse", lambda _url: _fake_feed())
    adapter = TherobotreportAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "therobotreport"


def test_agdaily_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.agdaily.feedparser.parse", lambda _url: _fake_feed())
    adapter = AgdailyAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "agdaily"
