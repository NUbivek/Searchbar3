# TESTING

Current repo has limited/no formal pytest suite for `startup_watch`.

Recommended immediate additions:
- Unit tests for helper functions (`infer_stage`, `extract_funding_amount`, dedupe logic).
- Source smoke tests with mocked HTTP responses.
- Integration test for config-driven pipeline run in dry mode.
