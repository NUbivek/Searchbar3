from types import SimpleNamespace

from startup_watch.adapters.future_ag import FutureAgAdapter


def _fake_feed() -> SimpleNamespace:
    return SimpleNamespace(
        entries=[
            SimpleNamespace(
                title="Example ag startup raises round",
                link="https://example.com/funding",
                summary="Company building precision ag platform.",
            )
        ]
    )


def test_future_ag_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.future_ag.feedparser.parse", lambda _url: _fake_feed())
    adapter = FutureAgAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "future_ag"
