from startup_watch.adapters.startupstream import StartupStreamAdapter


def test_fetch_returns_list_when_disabled() -> None:
    adapter = StartupStreamAdapter({"enabled": False})
    assert adapter.fetch() == []
