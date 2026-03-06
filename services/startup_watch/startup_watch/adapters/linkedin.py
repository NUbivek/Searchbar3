from startup_watch.adapters.base import BaseAdapter
from startup_watch.schema import StartupSignal


class LinkedInAdapter(BaseAdapter):
    source_name = "linkedin"
    requires_auth = True

    def fetch(self) -> list[StartupSignal]:
        if not self.config.get("enabled", False):
            return []
        # Intentional local-only stub for CI-safe behavior.
        return []
