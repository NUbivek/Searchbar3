from startup_watch.adapters.masschallenge import MasschallengeAdapter


class _Resp:
    def __init__(self, code: int, text: str):
        self.status_code = code
        self.text = text


def test_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.masschallenge.requests.get", lambda *a, **k: _Resp(200, "<h2>LineAI</h2>"))
    adapter = MasschallengeAdapter({"enabled": True, "url": "https://example.com"})
    signals = adapter.fetch()
    assert signals and signals[0].source_name == "masschallenge"
