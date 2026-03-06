from startup_watch.adapters.startup_genome import StartupGenomeAdapter


class _Resp:
    def __init__(self, code: int, text: str):
        self.status_code = code
        self.text = text


def test_fetch_returns_list(monkeypatch) -> None:
    monkeypatch.setattr(
        "startup_watch.adapters.startup_genome.requests.get",
        lambda *a, **k: _Resp(200, "<h2>EcoOps</h2>"),
    )
    adapter = StartupGenomeAdapter({"enabled": True, "url": "https://example.com"})
    assert isinstance(adapter.fetch(), list)


def test_fetch_handles_404(monkeypatch) -> None:
    monkeypatch.setattr(
        "startup_watch.adapters.startup_genome.requests.get",
        lambda *a, **k: _Resp(404, ""),
    )
    adapter = StartupGenomeAdapter({"enabled": True, "url": "https://example.com"})
    assert adapter.fetch() == []


def test_signal_fields(monkeypatch) -> None:
    monkeypatch.setattr(
        "startup_watch.adapters.startup_genome.requests.get",
        lambda *a, **k: _Resp(200, "<h3>ChainML</h3>"),
    )
    adapter = StartupGenomeAdapter({"enabled": True, "url": "https://example.com"})
    signals = adapter.fetch()
    assert signals
    assert signals[0].company_name
    assert signals[0].source_name == "startup_genome"
