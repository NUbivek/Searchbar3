from abc import ABC, abstractmethod

from startup_watch.schema import StartupSignal


class BaseAdapter(ABC):
    source_name: str = "base"
    requires_auth: bool = False

    def __init__(self, config: dict):
        self.config = config

    @abstractmethod
    def fetch(self) -> list[StartupSignal]:
        """Return normalized startup signals."""
