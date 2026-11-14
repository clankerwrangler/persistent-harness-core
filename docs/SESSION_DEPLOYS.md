# Session-only deploys

The supervisor loads its code once, when it starts, and keeps it. Each session process
(`bin/core-actor.mjs`) loads its code from the checkout every time the session starts,
and a quiet session stops after `actorInactivityMs` (ten minutes by default).

So a change that touches only session code can be deployed without restarting the
supervisor: move the checkout to the new commit, and every session runs the new code
from its next start. A session already running finishes on the code it loaded.

`node bin/deploy-scope.mjs <running-commit> [<new-commit>]` says which deploy a change
needs:

- `none`: only tests, documents or models changed.
- `session`: every changed file is loaded only by session processes. Move the checkout;
  do not restart the supervisor.
- `full`: something the supervisor loads changed (its own code, anything shared with
  sessions such as `src/protocol.mjs`, dependencies, skills, the Python runtime files),
  or a file not known to be session-only. Deploy as usual, with the restart.

The check reads both commits' import graphs (static and dynamic imports, and workers
started by URL), so a file the supervisor loads before or after the change counts as
the supervisor's.

The two halves check `PROTOCOL_VERSION` on every message. A change to the messages
between them belongs in `src/protocol.mjs`, which makes it a full deploy; bump
`PROTOCOL_VERSION` when old and new halves could misread each other, so a session
process that does not match is refused instead of half-working.
