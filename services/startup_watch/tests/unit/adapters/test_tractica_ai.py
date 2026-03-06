from types import SimpleNamespace

from startup_watch.adapters.tractica_ai import TracticaAiAdapter


def _fake_feed() -> SimpleNamespace:
    return SimpleNamespace(
        entries=[
            SimpleNamespace(
                title="Example industrial AI startup raises round",
                link="https://example.com/ai",
                summary="Startup building AI for plant optimization.",
            )
        ]
    )


def test_tractica_ai_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr(
        "startup_watch.adapters.tractica_ai.feedparser.parse", lambda _url: _fake_feed()
    )
    adapter = TracticaAiAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "tractica_ai"
