# Temporary expert review snapshot

This public repository is a deliberately limited, non-deployable code snapshot
from Unified Messenger. It contains the current shared desktop UI plus the
server-side media/MAX paths needed for an external error review. It intentionally
excludes Git history, production configuration, credentials, device secrets,
provider sessions, databases, logs, customer content and media files.

Start with the review packet matching the area you inspect:

- [Shared UI and MAX/server review](docs/expert-ui-max-server-review.md)
- [Telegram streaming-media review](docs/expert-telegram-media-review.md)
- [Telegram video presentation update](docs/expert-telegram-video-presentation.md)

Please do not run, deploy or modify production from this snapshot. Return
findings as a written recommendation or a small diff against these files.
