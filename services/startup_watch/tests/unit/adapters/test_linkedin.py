from startup_watch.adapters.linkedin import LinkedInAdapter


def test_fetch_returns_list_when_disabled() -> None:
    adapter = LinkedInAdapter({"enabled": False})
    assert adapter.fetch() == []
