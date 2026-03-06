from startup_watch.pipeline import run_pipeline


def test_pipeline_smoke_disabled_sources() -> None:
    config = {
        "categories": [],
        "stages": [],
        "filters": {"exclude_companies": []},
        "yc_directory": {"enabled": False},
        "startupstream": {"enabled": False},
        "linkedin": {"enabled": False},
    }
    result = run_pipeline(config)
    assert result == []
