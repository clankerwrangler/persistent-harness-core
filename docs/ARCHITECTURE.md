# Architecture and protocol

## Owners

- `HarnessSupervisor` owns admission, actor generations, durable queues, family scope, schedules, process completion, and local client routing.
- Each session worker owns one conversation-core process and the session's Python kernel. It prepares requests, runs the harness's tools, and forwards events. See [The conversation core](#the-conversation-core).
- The core owns the session's history, model requests, provider connections and sign-ins, tool hand-off, and the recovery of interrupted calls.
- `PythonKernel` owns the real interpreter, FIFO execution, and namespace checkpoint tail. A result can be delivered before its background save completes; the next Python operation and graceful shutdown still drain that tail.

Actor residency follows the worker's own settled interval, not its family display.
A resident parent can show `delegating` while its `quietSince` timestamp remains
stable across descendant activity. With no own pending input, task, family message,
tool work, readiness wake, or session mutation, that worker is eligible
for the existing inactivity timeout and capacity eviction. Retirement rechecks the
actor generation and idle interval under the existing mutation owner. Completion
of blocked work reconsiders retirement and optional index preparation. A working
child remains independent; later input or a family message uses normal revival,
canonical history, and kernel snapshot recovery. Family activity and notification
settlement still include descendants.

Managed workers start with `--expose-gc`. After 30 seconds of continuous own-idle,
the same timer can request one memory-reducing collection per idle interval when
RSS exceeds JS heap capacity plus external allocations by at least 192 MiB.
This margin is an eligibility heuristic, not exact cache accounting. Pending work,
index preparation, or an unavailable GC hook skips the optional collection. Wake
and retirement cancel unstarted work; a started collection is not awaited by
input admission or shutdown, and the passivation deadline stays unchanged.
The experimental V8 last-resort hook still pauses the isolate and clears
compilation caches, so later compilation can cost more. Strongly retained session
and namespace values remain intact.

The supervisor lazily owns one disposable Node compile-cache directory shared by
its actors. The actor enables it before importing the worker; tools and the
supervisor do not enable it through this path. Node owns code/source/version
invalidation, while each generation still creates fresh runtime objects and runs
normal resource, model, credential, skill, session, and recovery validation. No
session data or live runtime objects are cached. The first actor populates an empty
cache, normally written at process exit; later actors can reuse compiled code.

The directory is a real, effective-user-owned `0700` temporary directory. Setup,
validation, or cleanup failures leave ordinary startup/shutdown intact. Shutdown
removes only the original owned directory after actors and pending launches drain;
uncertain writer exit leaves it in place. Abrupt supervisor loss can leave an
orphan; there is no orphan sweep, eviction policy, or hard disk quota. A new
supervisor starts with a new directory. Platforms without effective-UID validation
skip this optimization. See [Node cache controls](DEPENDENCIES.md#node-compile-cache).

These are same-user local processes, not a multi-tenant security boundary. The Python and shell capabilities execute with the service account's privileges.

Root scratch ownership is attached to the existing root session row, not to actor generations or shared family labels. Canonical ancestry supplies descendant paths. Root tombstoning and pending cleanup intent share the store transaction; existing process ownership and background-completion monitoring gate later reclamation. Restart preserves the tombstone and retries cleanup, never the deleted actor's input. See [Root session scratch](OPERATIONS.md#root-session-scratch) for bounds and recovery.

## Automatic Python cold residency

Each existing `PythonKernel` owns one optional pressure-maintenance timer,
independent of provider/actor activity. Its 30-second cadence survives small
ordinary cells; execution and scheduled/active checkpoints, host calls and
close pause or cancel advice for priority. A 100 ms safe dwell follows activity.
Only bounded mapping metadata can survive a pause, with process/epoch reply
fencing and fresh ownership, lock and hot-reference checks before each batch.
The existing FIFO owns at most one batch. Actor Node reclamation is unchanged.

On supported Linux kernels, private anonymous mappings can receive `MADV_COLD`,
then `MADV_PAGEOUT` after a one-second reference-observation interval. The helper
uses cache-aware RAM/high-threshold estimates and swap room, never swap as RAM
credit. Normal cells choose no tool, script or memory budget. Work bounds are
1 MiB per syscall, 4 MiB/10 ms cooperative batches, at most 1 GiB per advice phase,
256 mapping descriptors and 512 KiB per metadata scan. A syscall can exceed the
cooperative time target and cannot be preempted. Hot, locked, changed, oversized,
unsupported or unknown ranges/conditions are skipped; normal execution continues.

The private additive ready field `coldResidencyVersion=1` gates this optional
control path and resets with each process. Legacy/unknown peers receive no cold
command. The existing actor-scoped `kernel.status` exposes optional version-1
`coldMemory` metadata through a fixed numeric/state projection; it does not collect
namespace values, names, addresses or another kernel's state. The operation changes neither namespace generation nor checkpoints,
pointers, aliases or object state. Process swap is cold residency, not durable
restart recovery or whole-process graph release. RSS reduction can leave physical
pages in reclaimable swap cache; it is not an equal physical-memory saving or an
OOM guarantee. See [verified boundaries and measurements](validation/kernel-cold-residency.md).

## Python namespace checkpoints

A matching `done` frame retires execution interruption before output draining.
The drain has no interrupt owner. A caller abort during that drain cancels a
synchronous checkpoint before admission; an abort already handled by execution
still permits its checkpoint. A synchronous snapshot has a fresh caller-owned
interrupt phase, while a deferred snapshot is detached from caller cancellation.
Force-kill timers are fenced to their exact handle, active operation, process,
and phase. The FIFO retains checkpoint ownership in every case.

Each eligible top-level binding keeps its own dill serialization, payload file,
SHA-256 digest, and admission check. Payload limits remain 4 MiB per value and
16 MiB per snapshot; the manifest reader accepts at most 1 MiB.

Snapshot format version 2 preserves repeated exact top-level source roots,
including function and class roots. Its fixed-width blob filename is
`SSSSSS-GGGGGGGGGGGG.dill`: the six-digit decimal saved-entry ordinal and the
12-digit hexadecimal ordinal of that root's first successfully admitted entry.
Equal-valued distinct roots are not grouped. Version 1 remains readable with its
original independent restore semantics.

Restore checks every entry's own descriptor-bound regular-file bytes, size, and
hash before alias reuse. A group uses its earliest eligible successfully decoded
entry; a missing, corrupt, protected, or unloadable owner cannot seed it. Invalid
group metadata reports an error and prevents checkpoint attribution, but safe,
healthy payloads still restore independently. Every binding retains an independent
physical payload copy. Sharing within a root remains dill-owned; sharing through
descendants of different roots or private scopes is still unresolved.

## The conversation core

The harness runs no agent loop of its own. Each running session has one worker
(`bin/core-actor.mjs`, `src/core-worker.mjs`) that starts one core process for the
session and talks to it in JSON lines.

The core keeps the session's history in the session folder. Entries are numbered and
only appended: there are no branches, no rewind and no compaction; the model rewrites
its own context when it needs room. One core at a time may write a session
(`writer.lock`). The core builds each model request: the system prompt parts that change
(tools, AGENTS files, skills, working folder), the worker's `harness` section, and the
saved context with a context usage line at the end. It talks to the providers and holds
their sign-ins.

Tool calls are saved as soon as they are complete in the stream and handed to the
worker while the reply keeps streaming; results are saved whenever they arrive. The next
request waits for every normal call; async calls do not block it. A dropped connection
is retried from scratch only when nothing of the reply was saved; otherwise the saved
part stays, a cut-off note is added, and the conversation continues. When a core opens
a session, a saved call without a result gets an interrupted result; nothing is re-run.

The worker prepares each request (depth instructions, skills, the prompt prefix, session
scratch, Python save diagnostics, Fast mode), runs the harness's tools (`ipython`,
`wait_for_ipython`) through the session's `PythonKernel`, and forwards the core's events
to the supervisor. It adds each user message's time and shared location as marked text
blocks, which clients hide. A model or reasoning change waits until the session settles.
Progress headings come from Codex reasoning summaries.

The supervisor reads histories only through the core (`core history`, `core context`),
never by opening its files. Visible pages project the core's entries with the shared
projection functions. A scroll-back cursor is the number of the oldest entry already
shown, and a session's branch id never changes. While a reply streams, each text item
from the provider shows as its own live row, under the id its saved part will have and
at the time its first words arrived.

## Explicit memory diagnostics

Registered operators can request v1 `get_memory_diagnostics({sessionId})`; actors
cannot request another diagnostics scope. This separate path bypasses actor
readiness and session-mutation queues and is never part of status polling. It
returns fixed Node numeric memory/V8 counters and bounded Python output-history
counts/sizes only. There is no GC, heap snapshot, conversation write, namespace
enumeration or diagnostic-driven process start. Unknown peer fields are dropped.

The existing Python FIFO counts queued work as busy before its microtask starts.
An idle diagnostic synchronously reserves that FIFO and control request; a later
tool, snapshot or close drains it. Busy tools, nested host-response waits and
snapshot/drain ownership reject observation immediately rather than enqueueing it.
The collector accepts only exact builtin containers and exact IPython history
owners, deduplicates immutable strings/bytes and containers by identity, and
checks a fixed reference/time budget while walking values without visiting keys.
See [numeric observation limits](OPERATIONS.md#explicit-numeric-memory-observation).

## Session-history retrieval

Actor-authenticated `session_history` list, search, and open use the caller's
existing family scope without starting session workers. List reads registry
metadata. By default search and open query the committed index snapshot through
an independent read-only WAL transaction. They do not ask the core for newer entries before matching. `freshness` reports indexed timestamps and
changed, missing, unavailable, and pending source counts; `complete=false` does
not certify current completeness. Results describe the history as indexed, which can lag the live session. Scope and tombstones are rechecked before returning text.

One supervisor publication owner serializes explicit refresh and coalesced
maintenance. Automatic refresh runs only when its source actor has no current
turn, tool, startup, retirement, or pending input/task/message work.
Busy sources occupy no publication slots: canonical/index coverage records the
deferred work, and startup completion, settlement, and passivation retry it.
Eligibility is rechecked at execution. New actor work cancels only that source's
automatic refresh; the last committed index remains available. Snapshot coverage
can admit up to 20 eligible sources, skipping busy sources before that bound.
`maintenancePendingSources` counts the union of caller-scoped pending coverage
and admitted jobs, including deferred sources beyond the admission bound.
The maintenance queue holds at most 64 sessions, does not activate actors, and
budgets each refresh at 60 seconds. Query discovery does not request a trailing
retry of already-pending work. Failed maintenance records a fixed secret-free
diagnostic and leaves coverage honest rather than retrying in a loop.
`refresh=True` is not gated by actor activity. It refreshes the selected canonical
sources before retrieval, retaining its 25-second budget including queue time and 28-second
client deadline. Default snapshot requests retain those deadlines but do not
wait behind archive maintenance. Disconnect and deadline cancel only that
request. Shutdown aborts and drains both publication and independent snapshot
jobs before closing the index and store. Other RPC deadlines are unchanged.

`SessionHistoryIndex` is a disposable, contentless FTS5 index of the user and
assistant text in core sessions (schema 5; older indexes are rebuilt). A session's
history only grows and every entry has a fixed number, so the index remembers, per
session, the last entry it indexed and asks the core only for the entries after it.
It holds no conversation text, image, tool, or receipt payloads: a result's text and
an opened entry's neighbours are asked of the core by entry number. The directory is
private (`0700`); database, WAL, and shared-memory files are `0600`. Snapshot
queries cannot discard or rebuild a damaged index; recovery belongs to explicit
refresh or maintenance, whose transactions never become a reader's snapshot.
Cancelled requests fail rather than returning an empty successful search.

## Clients

The Unix-socket framing and validation contract is in `src/framing.mjs` and `src/protocol.mjs`. `src/client.mjs` provides `HarnessClient`; terminal commands use the same supervisor requests as other clients.

The protocol retains session creation, subscription, input admission, stop/revive/delete/rename, kernel reload, model selection, family messages, schedules, background process notifications, canonical history, telemetry, dialogs, and output streams. Client-neutral conversation projections remain in this repository even though no browser client or HTTP adapter is included.

Bounded conversation pages use compact per-entry input matching facts and current
receipts to select their ordering, IDs, byte boundary, and cursor. The reader then
physically checks relevant legacy/custom spans against the complete same-input
inventory, including inactive candidates, the byte boundary, and cursor anchor.
Canonical user IDs retain metadata-only UI matching, and pages return no private
delivery proofs. Delivery and retry check their requested canonical spans; image
and family admission reads check their targets without unrelated input payloads.
Full/default and history-index reads retain their complete receipt proof collection.

### Conversation order

Each public assistant text part and progress row has a birth time. The core saves each
reply text block's `startedAt`, the time its first words arrived, and a progress entry
carries the time its heading was recorded. While a reply streams, its live row uses the
same time, so the saved row keeps its place. Already-streamed text can still be lost
before the reply is saved.

Public rows expose the stamp as `createdAt` and optional `timelineSequence`,
including slim deltas and cold history pages. Order is timestamp, then sequence.
At an equal millisecond, unstamped legacy rows and input receipts use sequence
zero before stamped actor rows; unstamped ties retain authoritative history and
neighbor order. Input acceptance and delivery timestamps are unchanged. Existing
live IDs retain their first visible ordering metadata; conflicting later stamps
are reported and ignored without discarding text.

Restart and fork seed the allocator from valid stamps in the session's history. The allocator performs no
I/O. Missing or malformed stamps use the legacy projection. There is no inferred
historical birth, archive rewrite, or new cross-clock synchronization guarantee.

### Input admission

`submit_input` acknowledges a durable receipt after registering supervisor-owned
wake/delivery work. Normal sends do not await actor startup, skill reconciliation,
or worker consumption, and release the session mutation lock at admission. Pending
same-ID retries reuse the receipt and request delivery without repeating admission.

The actor scheduler and readiness path retain skill and generation checks. Wake
failures after acceptance publish the session's error state and a correlated
`delivery.retryableError` on each affected pending input. The fixed
`actor_wake_failed` code and actor generation preserve accepted status without
exposing raw worker errors. A successfully registered new wake clears the annotation;
canonical delivery removes it with the pending payload. Same-ID retries retain the
original receipt and immutable content, images, and location. Stop, deletion, and
supervisor shutdown drain or cancel owned wakes before releasing their state. Restart recovers pending inputs
from gracefully passivated sessions; explicitly stopped sessions remain stopped.
Canonical delivery evidence and ambiguous-input replay guards remain authoritative.

Before submitting pending input, the supervisor reconciles its receipt against the
complete same-input canonical inventory. Resampling
newly admitted IDs after an awaited read requires a fresh scoped reconciliation
before absence can permit submission. Proven incorporation completes the receipt
without replay; ambiguous incorporation remains pending.
Actor startup takes an append cursor instead of querying every historical input
receipt again. Subsequent actor appends still use full historical evidence for
identity resolution and the supervisor verifies the exact entry before delivery.
This avoids duplicate startup work without changing delivery or
provider-request boundaries.

Pending queue snapshots use one joined read in receipt sequence order. Existence
checks do not load payloads. Clearing wake errors reads only inputs whose stored
error changed; an already-clear queue does not hydrate payloads or rewrite rows.
Repeated nonnull wake errors still publish the complete pending queue. Delivery
resamples the queue after asynchronous transcript reconciliation; no queue snapshot
or canonical incorporation decision is cached across that boundary.

Background completions publish accepted input state when their durable receipt is
created. The monitor owns at most 128 concurrent dispatch promises and continues
its existing bounded discovery scans while an owner starts. Actor readiness waits
outside session mutation, so later same-owner inputs can also persist. A completion
marker is written only after dispatch succeeds; failed startup remains retryable.
Stopping the monitor drains its owned dispatches. Background inputs use the existing steering queue while active and an ordinary
turn while idle. They enter canonical context at the next safe checkpoint rather
than waiting for the whole run. Delivery does not itself abort or replay tools.
Legacy receipt behavior/digests remain immutable while pending background inputs
resolve through the current automatic route; already-injected old queues are not
manipulated.

### User location attachment

`submit_input` accepts optional `location` on a genuine user message. It contains
exactly `latitude` (−90 to 90), `longitude` (−180 to 180), nonnegative `accuracy`
in metres, and a nonnegative integer `timestamp` in Unix milliseconds within the
JavaScript Date range. All numbers must be finite. The client owns permission,
freshness and opt-in; the harness treats the attachment as unverified user context.

Validation copies the record and includes it in the existing queue byte limits,
digest and duplicate-request equality. Absence preserves the previous digest.
The additive nullable queue column is removed with the payload on delivery;
the canonical `role: "user"` message retains the structured attachment. Internal cron/background input
cannot acquire a location attachment.

When the worker sends that user message to the core, it adds the location as a
marked text block, so the saved message the model sees carries it. Clients hide the
block. Internal cron/background input never carries one.

Visible/pending messages, event projections and title inputs omit coordinates.
Context forks and family messages do not gain raw structured location propagation.
Previously shared locations can recur in model replay, and model output can quote them. Disabling client sharing affects future acquisition,
not the conversation's existing history.

### Session inference controls

`get_session_inference` returns `selection` (`provider`, `model`, `thinkingLevel`,
`fastMode`), `fastModeRootSessionId`, `fastModeSupported`, available models, busy
state, and telemetry. `selection.fastMode` is the effective root preference;
`fastModeSupported` describes only the selected session's model. Public session
metadata exposes the same values as `launch.fastMode`,
`launch.fastModeRootSessionId`, and `launch.fastModeSupported`. Unknown metadata
stays null; a model label does not establish support.

`set_session_inference` accepts a validated model and reasoning selection during
active work. It saves a revisioned `launch.pendingInference` before acknowledging
it. `selection` and the ordinary launch model/thinking fields remain the last
acknowledged active selection while a change is pending; `pending` reports the desired selection and any
application error. Later accepted choices replace pending intent. Choosing the
active selection also queues a revision, so cancellation remains valid during an
older asynchronous apply.

The worker holds pending intent until the session settles, then applies it through
the core: a model never changes mid-turn, and the whole turn, including requests
between tool steps, runs on the model it started with. Applying it does not replace the
actor, clear input, or recreate Python. Selection changes do not alter saved defaults
for new sessions.

Generation-bound applied receipts update active launch policy and clear only the
matching pending revision. The public picker and its expected-selection check use
that acknowledged policy even during awaited model observers. Without pending
intent, settings reads retain the existing live worker model/effort behavior.
Explicit picker admission captures that live baseline; merely reading or using
idle service setters does not change their existing persistence behavior. Pending intent
survives reconnect and supervisor restart; normal actor revival starts the last
active policy and queues pending intent before input delivery. Existing uncertain
work is not replayed. Failed application retains visible intent and the current
run; a new choice, a settings read after failure, or actor revival retries it.
Revival still requires the last active launch model to be available. Model-only
writes use the current catalog snapshot; opening settings retains catalog refresh.

`set_session_fast_mode` is an authenticated client-only mutation with
`{sessionId, fastMode, expected}`. Its expected selection must include all four
selection fields. Stale selections are rejected. Existing model/thinking mutations
still accept expectations without `fastMode`.

Fast is a durable root-owned family preference, defaulting to false for a new
root. A retained root's valid launch object with no `fastMode` property also
resolves to false, without a migration or backfill. A malformed launch or a
present nonboolean preference remains unknown. Only the root session can change
it, including when its own model does not support Fast. Child-target writes
return `invalid_request`, including no-ops.
Existing child-local flags remain stored but are not used. Fast does not change
model/reasoning identity.

Conversation requests apply Fast only to exact `gpt-6-astra` or `gpt-6.1-sol`
identity with `openai-codex` / `openai-codex-responses` or
`openai` / `openai-responses`. Unsupported descendants keep ordinary inference
while supported descendants use the root preference. Fast requests priority
service, which can use more allowance or incur higher cost; it does not guarantee
latency.

One bounded ancestry resolver follows validated parent edges to the depth-0 root
for controls, session/navigator metadata, and authenticated request preparation.
It never selects a root by `familyId`: independent roots can share that label.
Missing, deleted, cyclic, malformed, or over-64-edge ancestry projects unknown
metadata and blocks preference sampling rather than selecting another root.

The existing authenticated actor queue flush returns one canonical root preference
sample during request preparation. Root changes affect the next request of every
existing, new, retained, or revived descendant, including already resident actors.
Already sampled requests remain immutable. Preference-read failure blocks that
request rather than silently using a cached value. The worker asks the core for
priority service on those requests; the core sends the tier and accounts its cost.

`get_visible_image` reads existing input images and explicit image blocks from root-session `toolResult` messages in the session's history. Tool images are unavailable for child sessions. The reader retains only image availability, rereads hash-checked canonical bytes on demand, and applies the existing PNG/JPEG limits: at most four images, 3 MiB total encoded bytes, bounded dimensions and decoded size, and a 5 MiB tool-result source line. Tool text, details, arguments, reasoning, and filesystem paths are not image sources. Tool results remain absent from visible message history; a frontend can use its existing image URL in an assistant Markdown response.

Input acceptance, canonical delivery, tool execution, result persistence, namespace save, and settlement are distinct events. In particular, `tool_execution_end` is an execution event, not proof of a completed namespace save; use canonical result and checkpoint evidence for their respective boundaries.

## Capability catalog

A skill's `SKILL.md` supplies procedure text. Optional `pyproject.toml` metadata binds its import name, alias, dependencies, entry point, and allowed host requests. The Python bridge loads the selected catalog; it does not require unpublished personal helpers. Children receive scoped grants rather than ambient access to every catalog item.

Retained-child context forking starts the child from a copy of the parent's current
context: what the parent's next request would send, less tool calls that have no result
yet. The copy becomes the start of the child's own history. It does not share a Python
namespace or replay tools. Normal children and family messages remain separately
retained by the supervisor.
