from startup_watch.adapters.oxford_foundry import OxfordFoundryAdapter


class _Resp:
    def __init__(self, code: int, text: str):
        self.status_code = code
        self.text = text


def test_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.oxford_foundry.requests.get", lambda *a, **k: _Resp(200, "<h2>AgriForge</h2>"))
    adapter = OxfordFoundryAdapter({"enabled": True, "url": "https://example.com"})
    signals = adapter.fetch()
    assert signals and signals[0].source_name == "oxford_foundry"
