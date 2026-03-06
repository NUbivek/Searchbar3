from types import SimpleNamespace

from startup_watch.adapters.agfunder_pod import AgfunderPodAdapter
from startup_watch.adapters.manufacturing_net import ManufacturingNetAdapter
from startup_watch.adapters.venturebeat_ai import VenturebeatAiAdapter


def _fake_feed() -> SimpleNamespace:
    return SimpleNamespace(
        entries=[
            SimpleNamespace(
                title="Example startup raises seed",
                link="https://example.com/item",
                summary="A startup building software for operations.",
            )
        ]
    )


def test_manufacturing_net_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr(
        "startup_watch.adapters.manufacturing_net.feedparser.parse",
        lambda _url: _fake_feed(),
    )
    adapter = ManufacturingNetAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "manufacturing_net"


def test_venturebeat_ai_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr(
        "startup_watch.adapters.venturebeat_ai.feedparser.parse",
        lambda _url: _fake_feed(),
    )
    adapter = VenturebeatAiAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "venturebeat_ai"


def test_agfunder_pod_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr(
        "startup_watch.adapters.agfunder_pod.feedparser.parse",
        lambda _url: _fake_feed(),
    )
    adapter = AgfunderPodAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "agfunder_pod"
