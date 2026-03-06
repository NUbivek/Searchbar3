from startup_watch.adapters.yc import YCombinatorAdapter


def test_fetch_returns_list_when_disabled() -> None:
    adapter = YCombinatorAdapter({"enabled": False})
    assert adapter.fetch() == []
