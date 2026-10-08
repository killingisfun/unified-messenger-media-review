# Chat modules

BaseChat is the session owner and compatibility facade for provider subclasses.
It creates the API client, shared session state and ChatLifetime, initializes the
chat, and disposes listeners, timers and observers on destroy. It contains no
message rendering, send, history or reaction algorithms.

Each controller receives its owning chat explicitly in its constructor. There
are no global controller instances, prototype patches, copied methods or proxy
objects. Controllers are created once per chat, on first use. All deferred work
continues to use the owning ChatLifetime and active-instance guards.

| Module | Responsibility |
| --- | --- |
| ChatComposer | Drafts, staged attachments, quotes and input event bindings |
| ChatOutbox | Send snapshots, queue, optimistic messages and reconciliation |
| SendJournal | Persisted request outcomes, account scoping and recovery |
| ChatHistory | Initial/older pages, cursors, scroll, dates and read scheduling |
| ChatRealtime | Socket/poll events, reconnects and read boundaries |
| MessageRenderer | Shared safe message markup and incremental DOM updates |
| MessageReceipts | Provider evidence projected into receipt UI |
| ChatAlbums | Album assembly, author boundaries and grouped files |
| MediaLoader | Lazy loading, bounded queues, retries and fallbacks |
| MediaUrls | Media URL normalization and metadata probes |
| MediaGallery | Viewer and downloads |
| mediaArchive | Pure browser ZIP writer |
| ChatReactions | Reaction state, intents, mutations and reconciliation |
| ReactionActors | Participant identity and avatar hydration |
| ChatProfile | Header identity, connected account and capabilities |

## Dependency boundary

Controllers depend on their owner and imported domain/helpers. They do not
import BaseChat or each other. Calls through chat preserve provider overrides
and the old entry points used by adapters; the facade delegates each operation
to exactly one controller. Shared fields remain on the session owner in this
refactor to preserve event ordering and queue semantics. This is an explicit
shared-session boundary, not independent state stores for every controller.

Add behavior to the responsible controller, not to BaseChat. A genuinely new
cross-feature operation belongs in the session coordinator. Keep provider
transport differences in adapters. Do not copy provider implementations into
new UI controllers. Do not move network work into module initialization.

## Verification

Browser fixtures import the real ES module graph and exercise albums, reaction
layout, media, draft/send journal recovery and chat sections. Older VM contracts
use tests/read-chat-source.cjs to load the same controller bodies and facade;
that helper does not rewrite their executable behavior.

The migration compared ASTs of 228 moved methods against the pre-refactor
working copy: only this -> this.chat receiver access changed. A local copy for
that comparison was kept outside Git. No backend deployment is required.
