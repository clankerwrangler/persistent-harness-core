# Validation

Install the declared Node dependencies, then run the suite. Tests do not establish live provider compatibility.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test                  # unit, then integration when the core and Python are found
npm run test:unit         # tests that need neither the core nor Python
npm run test:integration  # files listed in test/integration-files.txt
npm run test:specs        # TLC model checks against specification/expected-results.json
```

`bin/run-tests.mjs` gives every run a private temporary `HOME` and
`PI_CODING_AGENT_DIR`, sets `PI_HARNESS_AUTO_INSTALL=0` and `UV_OFFLINE=1`, and
points `PI_HARNESS_SKILLS_PATH` at this checkout unless overridden. It never
downloads a runtime.

- Integration files need the conversation core: set `PI_HARNESS_CORE_BIN` and
  `PI_HARNESS_CORE_JS`. Without them those files are skipped, with the reason.
- Set `PI_HARNESS_PYTHON` to select an interpreter; otherwise discovery checks
  `<agent dir>/harness/kernel-runtime/environments/`.
- For files that read `PI_HARNESS_TEST_MANAGED_SEED`, the runner copies `bin/`,
  `cache/`, and `python/` (never `environments/`) from the managed runtime into
  private temporary state.

The runner uses a 100 ms background-completion scan
(`PI_HARNESS_BACKGROUND_COMPLETION_TICK_MS`) and runs three test files at a time
(`PI_HARNESS_TEST_CONCURRENCY`); each file has its own process and temporary state.

`bin/test-image.sh --core <core checkout>` builds a test image with the core, Python and
the TLA+ tools, and runs the whole suite inside it with no network. `--cpus N --runs N`
repeats the run with fewer CPUs, to check that tests hold up under load; `--specs` also
runs the model checks. Building requires Docker Buildx; each invocation removes its own
builder and cache after loading the image. The last image and runtime-download seed remain
for later runs. A fresh isolated builder cannot reuse earlier build layers.

`bin/check-specs.mjs` runs TLC on every `specification/*.cfg` and compares each outcome (`pass`, `violation`, `error`) with `specification/expected-results.json`; negative controls are recorded as `violation`. Set `TLA2TOOLS` and `JAVA` when the tools are not at `/opt/tla/tla2tools-1.7.4.jar` and on `PATH`. After an intentional model change, rerun the affected configurations with `--record` and review the diff.

The tests use isolated temporary state, fake providers, and local processes. All supervisor tests, including fake-worker tests, need private `HOME` and `PI_CODING_AGENT_DIR`: a temporary database alone does not isolate sessions or background notifications. The default background directory is `$PI_CODING_AGENT_DIR/state/background-jobs` (otherwise `$HOME/.pi/agent/state/background-jobs`); any explicit `backgroundJobsDirectory` must also be test-private. Never point tests at running service state or live credentials. For offline real-worker checks, set `PI_HARNESS_PYTHON` to an existing compatible interpreter and `PI_HARNESS_AUTO_INSTALL=0`.

Real-worker tests run the actual core against local fake providers:
`test/fixtures/core-fake-provider.mjs` speaks Chat Completions, and
`test/fixtures/core-live.mjs` speaks the Codex Responses API over plain HTTP streaming
(the core falls back to it when it cannot open a WebSocket), so progress headings and
held Python calls can be exercised. Tests that only check the supervisor give sessions
`.jsonl` stand-ins for their history (`test/fixtures/isolated-supervisor.mjs`), one
entry per line in the shape the core hands entries out.

Fixtures with literal `harness.presentation.v1` directives require
`PI_HARNESS_PRESENTATION_NAMESPACE=harness` in the test process.

The managed-runtime test explicitly exercises actual managed reuse and dependency rebuild, not the interpreter override. The stock-worker provisioning fixture also clears the override locally to check the real consent path. An optional `PI_HARNESS_TEST_MANAGED_SEED` can contain only cached `bin/uv-0.12.3`, `python/cpython-3.12.12-linux-x86_64-gnu`, and package `cache/` prerequisites. Both fixtures copy only these prerequisites into their temporary runtime; neither copies completed environments. The kernel test denies Node fetch. Set `UV_OFFLINE=1` for both offline runs. Do not supply completed environments, sessions, credentials, or kernel state as the seed. Without cached prerequisites, managed provisioning needs its documented downloads.

Filesystem race fixtures order the adversarial operation at the actual syscall
boundary: parent detachment completes after link/rename and before publication
verification; the real grep worker enumerates a directory before that child is
replaced by a symlink. They retain real filesystem operations and worker resource
limits without relying on inotify delivery or a busy rename loop.

Browser assets, the HTTP adapter, and browser-only tests live in the separate WebUI. Client-neutral protocol/history tests remain here.

The lifecycle test supervisor wrapper supplies test-private scratch and background directories. Run with private `HOME` and `PI_CODING_AGENT_DIR` as required above.

`session-scratch.test.mjs` covers canonical root/child/grandchild propagation, generation revival, child preservation, actor-stop fencing, deferred detached ownership under tombstoned descendants, an orphan writer surviving its leader, restart recovery without replay, unknown metadata, discovery beyond the 128-job presentation cache, unrelated-history reuse, and unowned/traversal/symlink/substituted-path rejection. `kernel-scratch.test.mjs` checks the real Python alias, protected restore behavior, and explicit kernel/host-shell marker propagation. Process-owner tests exercise exact matching and each sample bound. All destructive fixtures are automatically cleaned temporary trees.

## Models

`RootScratch` models canonical family lifetime, tombstone-before-reclaim intent, independent draining tool/background ownership, restart, path substitution, child deletion, and preserved unrelated roots/legacy data. TLC checks 39,103 generated states, 4,360 distinct states, and depth 17. Its six negative controls (skip background, skip tools, drop intent, follow changed paths, child reclamation, and counting the supervisor as root work) must fail. The abstraction does not prove Linux process attribution, filesystem crash atomicity, or same-UID race exclusion.

`ScratchJobIdentity` checks repair of valid-PID/missing-birth, invalid-kind, and out-of-range-PID observations, sticky owner association, and freezing only complete process identities. Its positive model checks 24 generated states, 11 distinct states, and depth 4; its early-freeze negative control violates repair progress. The existing metadata-repair fixture reproduces both failures on old code and checks active replacement identity, retarget rejection, complete-identity pinning, and eventual reclamation after exit.

`OwnIdleRetirement` separates the worker's quiet age from descendant display
activity. It checks safe and available inactivity/capacity retirement, stable
own age, generation/interval expiry fencing, independent children, input/family
wake availability, and optional preparation. Its seven policy negative
configurations must fail their intended invariants. Isolated supervisor fixtures reproduce the
old retained delegating parent, hold preparation during retirement, keep children
working, deliver input and family wakes before and after retirement, and hold
own input, wake, tool, and serialized control work through retirement
attempts. The retirement callback uses its existing mutation owner; that owner
must not reject itself as unrelated pending work. Family notification tests keep
settlement dependent on the child after the parent retires.
`OwnIdleRetirement.Projection.cfg` separately checks fresh five-field local
actor-state reads, the readiness loop's conditional first sample and separate
error sample, deferred preparation/expiry decisions, and omitted family,
ancestry, and JSON work. Its seven projection controls must fail their intended
invariants. Store and public faux fixtures retain missing/deleted rows,
generation/error/activity changes, quiet-age rechecks, full session APIs,
readiness retirement fences, and capacity selection.
`OwnIdleRetirement.GrantContext.cfg` separately checks fresh raw lifecycle,
session-file, kind, and immediate-parent projections at both reconciliation
observations. Its missing, deleted, file, kind, parent, cache, and full-mapper
controls must fail. Store/public fixtures retain early grant promotion and
retained-catalog availability, pre-intent failure, runtime approval, parent
capability bounds, and Stop/delete sidecar drain. These projection models abstract
row values and work, not SQLite isolation, allocation, or wall-clock latency.
`NotificationLifecycle.Snapshot.cfg` separately checks one family projection per
synchronous observation, fresh direct/default and next-call reads, authoritative
null, and equivalent decisions. Its reread, stale, null-fallback, and root-only
controls must fail. The external-write configuration intentionally demonstrates
non-equivalence between the old sample times; neither version guarantees
latest-at-commit family state. SQL isolation and runtime allocation are outside
this finite abstraction. `NotificationLifecycle.Migration.cfg` checks atomic
publication of the close-delivery column and historical initialization through
failure/reopen; its non-atomic control must violate the historical-close invariant.
Real SQLite regressions abort the initialization statement before its first row
and after one row, require schema and row rollback, and then reopen successfully
without claiming historical closures. These checks do not make a pre-upgrade
state snapshot safe to restore after successor writes.

`CronActiveRunProbe` compares a fresh session-specific active-run existence
query with the full-list predicate across all run statuses and two observations.
Its six negative configurations cover wrong-session, null-session, terminal,
claimed-only, stale-result, and full-payload selection. Store regressions check
competing-writer freshness, bounded scalar results, unchanged full lists, and
closed-database errors. The model abstracts SQLite execution and allocation.

TLA+ sources in `specification/` cover bounded scheduler, stream, provider, retry, history, service ownership, and export-dependency assumptions. Obtain Java and `tla2tools.jar` separately. For example:

```sh
java -cp "$TLA2TOOLS" tlc2.TLC -workers 1 -config specification/StockCoordinator.cfg specification/StockCoordinator.tla
java -cp "$TLA2TOOLS" tlc2.TLC -workers 1 -config specification/FirstInputSnapshot.after.cfg specification/FirstInputSnapshot.tla
```

Use each model's matching configuration. Model checks prove only their finite abstraction, not arbitrary provider behavior, filesystem crash atomicity, or remote exactly-once execution. Keep test and model results tied to the source bytes under test.

`GrepLineOwnership` checks synchronous use of completed chunk slices and copied
fragments across reads, with controls for redundant copies, retained borrowed
fragments, and delayed decoding. The focused grep checks cover UTF-8 chunk
boundaries, fresh calls, binary/invalid input, output and source caps, symlink
swaps, and worker deadlines. Completed slices need no copy before synchronous
decode or concatenation; unfinished fragments still require their owned copy.

`HostFileEdit` checks one partition per immutable source, fresh partitions for
later edits, and unchanged UTF-8, missing-match, ambiguity and output-limit error
precedence. Its `Reread`, `Retain` and `Validation` controls must fail their work,
freshness and result invariants. Atomic-file tests check literal replacement,
metadata, symlink rejection, precommit races/cancellation and fixed committed
errors. The model abstracts string splitting and filesystem publication.

`ConcurrencyFixtures` checks publication/detach/verification ordering, a child
symlink replacement after enumeration, and independent callback admission followed
by exactly-once backlog drain under fair scheduling. Its configured backlog is
511. The `NoRendezvous`, `FollowLink`, and `BlockCallback` configurations must fail
their corresponding safety or completion checks. The model abstracts OS timing;
filesystem, worker, and socket tests exercise the actual boundaries.

`MessageLocation` models one submission and one acquisition: separate acquisition
and Send deadlines (including native callbacks before delayed timer delivery),
opt-in epochs, frozen no-location sends, late fixes, and durable
replay. It abstracts the browser and provider serializers. The `input-location`
tests exercise validation/digest equality, restart persistence and the marked
location block using synthetic coordinates. The separate frontend model and browser tests cover
successive sends and stale native callback identities; neither model represents
the entire UI or a live location service.

The `RecursiveSessionDeletion-*.cfg` configurations cover root and direct-child deletion with and without a legacy deleted intermediate. They check subtree completeness, shutdown fencing, retained artifacts, and unrelated actors. The models abstract external stop completion; worker, socket, and history tests verify the implementation boundaries.
`RecursiveSessionDeletion.Preflight.cfg` separately checks pure session-helper
prerequisites, client-close versus host completion, the final parent admission
fence, and denied-candidate cleanup. Its missing-SDK, early-observation, skipped-
fence, and leaked-transient controls must fail. The isolated faux preflight
fixture supplies only an empty-branch context builder and session-file API through
the explicit SDK seam; it does not evaluate a stock SDK, CLI, provider, or worker.

`ChildExitDelivery` models atomic generation-bound failure receipts, silent intentional exits, parent availability/deletion, retransmission after restart, and idempotent recipient incorporation. TLC checked 967 generated states, 181 distinct states, and depth 11 with no errors. It abstracts SQLite durability, fixed payload validation, and the existing family-message transport; it does not prove exactly-once inference or explain heap growth. Store and supervisor regressions exercise actual receipt persistence, worker-exit events, privacy, direct-parent routing, restart/redelivery, and acknowledgement. The native integration kills only a verified synthetic child process group and checks automatic parent inference, one canonical receipt, acknowledgement, and no child revival.

`ChildTurnFailure` checks the resident failed-turn producer feeding that same
lifecycle queue, durable pending reports, the ordered acceptance frontier, lost
report/ACK retries, explicit new input, and conservative admitted/started tool
boundaries. Its operation scopes bind first-cause diagnostics to the rejecting
run through overlap and late old-run callbacks; diagnostic write failure cannot
block the v1 notice or change effects. `NoJournal`, `IgnoreAdmitted`,
`ReplaceFirst`, `SharedOperation`, and `StaleResult` must violate their intended invariants.
The model abstracts canonical durability, exception classification, and the
receipt RPC. Maintained coordinator/result-lifetime tests check both post-result
commit and post-inference threshold failures, preserved results, canonical reopen,
first-cause retention, same Error/primitive reuse across turns, handled inner
errors (including reuse after successful opaque work), late callbacks, a queued
fresh run after a tool-originated drive, and failed diagnostic writes. Classifier fixtures reject
hostile accessors, formatters, and live/revoked proxies without invoking them.
Existing relay/store/supervisor tests retain
parent delivery, cancellation, and safe retry behavior.

`SnapshotRootAliases` checks first successful root admission, original source
serialization attempts, eligible healthy restore ownership, and independent
salvage when group metadata is invalid. Its eight invariants cover exact trusted
root grouping, no false merge, protected/unhealthy exclusion, decoded-owner
selection, and no malformed-group checkpoint attribution. The finite model does
not cover descendant sharing or Python/FD behavior. Snapshot durability and
failure fixtures exercise real serialization, fresh ordinary/durable workers,
independent corruption salvage, legacy restore, and the original payload and
manifest capacities.

`KernelCompletion` checks that failed execution cannot become terminal until the controlled process exits, while successful execution can complete before namespace saving. It abstracts signal delivery and transport errors. `kernel-completion.test.mjs` checks decoder corruption, control-channel failure, queued-call no-replay, and forced close against real Python process exit.

`KernelStreamAccounting` compares normalized per-stream capture with maintained
slice-byte counts, independent limits, discarded-byte totals, progress and callback
errors, text/MIME order, and fresh collectors. Its bounded configuration checks two
operations with integer, fractional, negative, NaN and infinite limits. Accounting
matches encoded retained text while a stream remains open; closed streams no
longer consult that count. `Shared`, `AssumedEnd`, `SkipNormalization` and `Rescan`
controls must fail their intended invariants. The model abstracts rich budgets
and concrete runtime encoding; `kernel-rich-output.test.mjs` checks the public
PythonKernel boundary, including fitting surrogate halves and invalid native bytes.

`SnapshotSaveScope` separates non-certifying prior blob candidates from current-byte reuse verification. It covers unused old state, post-lookup source substitution, rewrite fallback, and unchanged full restore validation. The snapshot regression checks actual bounded reads, malformed old metadata, symlink/corrupt candidates, and recovery. The model does not claim protection against mutation of a hardlinked inode after verification.

`LivenessScope` separates protocol responsiveness from explicit status audits. It covers current and legacy protocol evidence, rechecking under the startup lock, no launch on timeout or invalid protocol, and unchanged heartbeat registration. It also separates helper-local dependency evaluation from the legitimate start child's service graph and memory's client graph. Its `EagerSupervisor`, `EagerClient`, and `MissingStartImport` controls must fail. CLI tests exercise these boundaries against isolated supervisors and bounded private protocol peers. Module fixtures observe genuine ESM evaluation per process, including import-only and argument-error paths; their source-byte counts are not RSS or latency measurements.

`VisibleOutputImages` checks request-time canonical image eligibility, root-only tool output, existing origin/session/branch gates, source integrity, byte validation, and preserved input delivery. It abstracts image parsing and HTTP authorization; reader and supervisor tests exercise their actual boundaries. The separate frontend tests verify exact PNG/JPEG bytes and retained Markdown rendering in isolated Chromium.

`ModelCatalogRefresh` models the catalog call integration: a 15-second abort signal, delegated browsing policy, local-only pin admission, unchanged model selection, and visible cached fallback. Pi owns refresh concurrency, cache, TTL, and transport behavior; this model does not reimplement or prove them. The catalog integration test uses stock Pi with synthetic credentials, isolated metadata, and mocked public catalog responses to check picker/search visibility, stale-actor exact pins, offline use, and safe warnings.

`DescendantTraversal` checks deduplicated expansion over finite parent graphs,
including cycles, deleted intermediates, and working-node subsets. It verifies
termination, at-most-once expansion, and exclusion of the queried session from
its own descendant count. It also compares indexed parent-edge traversal with
a full-scan oracle, retaining deleted edges in the index for subtree deletion.
SQLite owns index maintenance; the model does not prove its query planner or
crash behavior. Store tests verify fresh creation, idempotent migration, covering
index selection, and read-only reopening without an index. A bounded subprocess
regression checks cycle-member
session projections without risking a hung test runner and preserves acyclic and
deleted-intermediate counts.

`PublicRosterProjection` checks the eleven-column live registry projection,
current one-hop relationships, global lineage, fresh descendant counts, and
missing/deleted-caller errors across changes. Its `KeepPayload`, `DropParent`, and
`FilterFamily` controls must fail. The finite model abstracts locale ordering and
SQLite materialization; `public-roster.test.mjs` checks actual selected columns,
ordered fields, cross-family/cyclic ancestry, hidden descendants, deleted bridges,
fresh mutations, and authenticated RPC through the real host consumer without
worker startup or runtime provisioning.

`FamilyFastMode` covers two independent roots sharing a family label, a child and
grandchild, root-only preference writes regardless of root model support,
missing/deleted ancestors, legacy absent-field default-off versus malformed
preference failure, retained/new/resident actors, and immutable request samples.
`SessionFastMode` covers own-model eligibility and matching wire/accounting tiers; its detailed-stream invariant records the pinned stock simple-option
filtering boundary. Store/control tests also check malformed and bounded ancestry,
legacy child-local flags, unknown metadata, navigator refresh, revival, concurrent
expected-selection writes, busy actors, and precommit RPC/persistence failures.
Native and stock adapter tests use synthetic credentials and mocked transport to
check payload, reasoning/option parity, and tier-aware estimated cost; real-worker
loopback tests cover streaming toggles, subsequent requests, reattachment, and
clearing Fast. These are offline checks, not live service-tier eligibility,
latency, or billing guarantees.

`InputAdmission` checks durable admission/publication, independent acknowledgment/readiness,
coalesced wake ownership, overlapping sends, failure visibility, and drained
shutdown/restart. It also checks one finite post-spawn state/steering
handshake deadline, a separate warm RPC deadline, and termination under fair timer
steps. The `CoupleStartup`, `ResetSteering`, and `ExtendWarm` configurations must
violate their corresponding deadline invariants. Queue waiting is distinct from
the handshake clock; ticks abstract time, not archive size or actual latency. It abstracts skill reconciliation, SQLite atomicity, transport,
and worker consumption; it does not prove exactly-once execution. Supervisor
regressions hold startup and close, reject registration/factory/start/submit,
retry the same receipt after reconnect or failure, verify the correlated accepted
error and its clearing on retry, and verify stop/delete/restart. Session-actor
checks use the real worker RPC boot barrier with a synthetic bootstrap to verify
cold and steering work beyond the warm deadline, unchanged warm timeout, one
shared startup budget, late acknowledgement rejection, legacy direct callers,
finite hung-start failure, explicit bootstrap errors, and close during startup.
They do not open private sessions or establish live startup success.

`StockWorkerSetup` checks cleanup ownership before asynchronous setup, the
cancellation fence before worker startup, and cleanup after the owned copy drains.
The stock-worker fixture has a controlled delayed-copy cancellation regression;
normal provisioning/consent and kernel reuse/rebuild assertions remain unchanged.

`BackgroundCommandObservation` checks one UTF-8 encoding per successful adopted
command read, fresh later reads, and unchanged bounded output. Its `Reread`,
`Retain`, and `Truncate` controls must fail. The model abstracts byte encoding and
UTF-8 truncation; the background Python regression checks actual bounded text,
replacement decoding, metadata, and encoding counts with a private process fixture.

`BackgroundCompletions` checks bounded dispatch ownership, acceptance independent
of cold owners, durable publication, sent-after-readiness, retry/idempotence,
owner ordering, safe-checkpoint admission independent of run end, and stop after
dispatch drain. Its `Scan.cfg` projection checks scan-start ownership across a
stale notification read, marker publication, and dispatch retirement, including
retry and fair completion. The `Scan.IgnoreOwners` control must fail. The model
abstracts filesystem polling and process startup latency. Background
notifier/supervisor regressions hold startup across later scans, verify same-owner
and unrelated-owner progress, reject startup then recover without duplicate
canonical entries, and check bounded dispatch and stop drain. The stale-read
regression holds genuine notification absence through marker-rename
acknowledgement and owner retirement. The paired WebUI real-worker browser case
checks live queued rows without reload, model-request receipt before an older
held Python call finishes, exact promotion, and retained-state completion without
replay. Legacy pending/completed receipts keep their original identity/digest.

`SettledWakeOrdering` checks both mutation orderings: a wake registered before Stop
is joined, and a later settled callback cannot reenter readiness after Stop.
Registration leaves the mutation queue before readiness waits. Automatic empty
exited-child intent is revalidated after asynchronous skill reconciliation; a
fresh pending input still wakes it. Its `Activation.cfg` separately covers every
standalone/queued readiness owner, stable retry cancellation, older launch and
grant publication drain, failure cleanup, later activation, resident refresh,
and independent input admission. The five activation controls must fail their
intended invariants. Stop and subtree deletion fence and join these owners;
internal skill-refresh passivation does not join its own readiness. Public faux
fixtures hold runtime readiness, grant rename, and post-validation startup across
retirement, including ancestor sidecars, close failure, and fresh input without
replay. The existing real-writer case separately checks no append after Stop and
explicit later revival. The model abstracts filesystem publication, worker close,
and SQLite; it does not measure memory or establish a live occurrence.

`ActorInputReconciliation` models startup without a historical actor receipt
sweep, retained supervisor reconciliation, receipt loss across actor generations,
and ambiguous evidence. Disabling historical
supervisor reconciliation fails its recovery invariant. Reporter tests cover
appends during registration, complete-history ambiguity, and offline reporting;
a real stock-worker test requires native, legacy, and custom historical pending
receipts to complete through supervisor reconciliation without reinjection.

`VisibleInputProofs` checks operation-scoped physical validation, complete inactive
candidate inventory, render-only page evidence, newly admitted queue IDs, and
metadata-only canonical-ID UI matching. Its authority, inventory, scope, pending,
and modern-page fault configurations must fail. Reader byte counters compare warm
pages and appends against full/default reads, preserve page/cursor parity, and
reject relevant legacy/custom rewrites. Held supervisor reads verify fresh
reconciliation of late proven and ambiguous inputs without duplicate submission.
Image-bearing canonical-ID pages add no payload reads; delivery/retry and image
retrieval retain physical target checks. Full index receipt verification is unchanged.

`PendingInputReads` checks ordered receipt/payload snapshots, one-query pending
reads, payload-free existence and no-op clear, and current queue selection after
an asynchronous boundary. Its `NPlusOne`, `EagerClear`, and `StaleQueue` controls
must fail their corresponding invariants. It abstracts SQLite execution and JSON
hydration. `pending-input-reads.test.mjs` counts actual prepared queries, synthetic
payload parsing, and row updates while checking per-ID value parity, timestamps,
provenance, attachments, repeated failure publication, and affected-only clearing.
The existing input-location and supervisor reconciliation tests retain legacy
read-only, post-await evidence, stop, and no-replay coverage.

`ActorCompileCache` checks one supervisor cache owner, cleanup after pending
launches and writers drain, generation-local runtime identity, unchanged readiness
validation, source-current loads, and disabled/unavailable fallback. Node's cache
format and source/version validation are abstracted, not proved. Helper tests use
real Node processes for unsafe-path rejection, operator controls, same-length
source changes, normal exit writes, and concurrent fresh evaluation. A supervisor
regression holds both worker close and startup to verify disposal ordering; stock
worker, recovery, and Stop tests retain their existing runtime assertions.

`SessionHistory` models independently cancelled callers, serialized history
ownership, verified canonical/receipt dependency versions, atomic publication,
citation-version consistency, and shutdown after drain. Its finite abstraction
does not prove SHA-256 collision resistance, filesystem atomicity, or wall-clock
latency. Reader/index tests cover partial lines, same-inode rewrites with and
without growth, mixed ordinary/history readers, bounded restart
hydration, receipt ambiguity and receipt-only changes, and cancellation during
prefix I/O and FTS transactions. Supervisor tests hold disconnect, deadline,
shutdown, and competing source versions; a real Python skill-to-RPC test crosses
the former three-second deadline without reviving a transcript actor.

`HistoryMaintenance` checks quiescent automatic admission and execution, resume
cancellation, unchanged strict-caller availability, independent snapshots, dirty
coverage retention, and close/drain. The positive finite check covers 388 states;
`Busy` and `Resume` controls fail their intended invariants. Serial synthetic
index/supervisor fixtures verify canonical recovery's full-prefix read bytes,
more than 64 deferred sources without queue starvation, exact pending counts,
strict cancellation isolation, input admission during held maintenance, and
unconditional settlement/passivation retries.

`ConversationBirthOrder` models text/progress births, arbitrary event arrival,
equal-millisecond sequence order, prefix rebase, immutable identity, embedded
commit metadata, restart/fork recovery, and visible text after commit failure.
Run its matching `.cfg`; the eight `ConversationBirthOrder.<flag>.cfg` controls
each disable one required property and must produce an invariant violation.
The model abstracts wall clocks, filtering, hooks, canonical I/O, and transport.
`conversation-birth`, `core-transcript-reader` and `e2e-reply-text-items` tests cover
those boundaries: synthetic births, restart, pagination, and a real core reply whose
text items and progress interleave. The separate WebUI
browser regression checks keyed progress nodes during live text arrival and
completion, then independently checks reload reconstruction.

`LiveConversationAccounting` checks each abstract mutation from every bounded
ordered initial row state: maintained bytes equal retained per-chunk bytes,
reference/candidate rows and truncation agree, byte/row limits hold, and fitting
appends and trimming avoid Buffer creation and a redundant sum, respectively.
The configuration uses three IDs, a three-byte budget, and two retained rows.
It covers replacement, removal, complete-only reconciliation, settlement,
ordered eviction, and the truncation reset. The `BadReplace`, `BadRemove`,
`BadReconcile`, and `BadEviction` controls must violate accounting; `BadOrder`
must violate equivalence; `EagerFit` and `Resum` must violate the work invariant.
Prefix lengths abstract UTF-8 decoding. `provider-message-boundaries` tests cover
actual exact-limit prefixes, fitting and overflowing unpaired surrogates,
per-chunk accounting, replacement after truncation, and 512-row eviction.
`conversation-birth` and `supervisor-input-association`
retain identity and actual supervisor caller coverage with synthetic in-process
actors.

`BoundedReconnectReplay` checks the ordered capped suffix, exact wrapper-byte
subtraction including separators, the singleton budget exception, one full-array
measurement, and serialization-free empty/single selections. Two requests see
changed aliased values without using stored event sizes. Its `Separator`,
`DropLast`, `Stale`, `Rescan`, and `Eager` controls must fail their intended
invariants. Wrapper lengths abstract JSON-plain serialization; the replay
configuration uses three retained items. `supervisor-actor.test.mjs` checks the
public reconnect caller with synthetic workers, 128-item selection,
escaped/multibyte text, both ring append paths, and repeat requests without ring
mutation.

`EventLogTail` compares a reverse nonempty-line scan with the complete forward
log oracle, including malformed-line quota and exact truncation detection. It
checks 6,441 distinct states for the bounded configuration. The model abstracts
segment sampling and byte decoding; `event-log-reader.test.mjs` checks rotated
order, pinned inodes, missing segments, UTF-8 boundaries, large records, short
reads, concurrent truncation, descriptor cleanup, and suffix-only I/O. A log read
remains a best-effort observation of two segments, not an atomic rotation snapshot.

`RecoveryValueLifetime` checks descriptor-bound bytes through restore and release
before readiness, including a reported decode failure. Its early-release and
retained-ready controls must fail. `kernel-recovery-lifetime.test.mjs` executes the
actual startup/restore source with public synthetic serialized values, checking
success, truthful decode errors and final temporary-owner release; it does not
start or inspect a live kernel.

`MemoryDiagnostics` checks operator-only scope, forwarding across drain races,
immediate busy rejection, synchronous pipe reservation before later work, no
process startup and no conversation/checkpoint mutation. Its five controls
(`IgnoreBusy`, `StartMissing`, `SkipReserve`, `MutateRead`, `BypassAuth`) must fail.
The finite model abstracts numeric collection and OS scheduling. Focused
`memory-diagnostics.test.mjs` fixtures exercise real isolated kernel history,
queued tools/snapshots, a nested host-response wait, close after an admitted read,
fixed peer-field projection, exact-type/subclass/metaclass hook rejection,
deduplicated sizes, count/time truncation, client-only auth, the connect-only CLI,
and a held unrelated supervisor mutation without actor start or state changes.

## Automatic kernel cold residency

`kernel-cold-memory.test.mjs` exercises the real ordinary `PythonKernel` path with
a private opaque SQLite transaction, aliases and a touched 32 MiB native mapping.
A fake Node clock and private pressure stub control eligibility; Linux advice,
RSS/swap observations and next-cell state/use are real. The mixed-work regression
keeps issuing small ordinary cells every one virtual second, exercising real
checkpoint drain without a 30-second quiet interval. Guard fixtures cover queued
and native execution, scheduled/held checkpoints, host replies, snapshot-demand and
diagnostic rearm, close, legacy capability and advertised-unsupported outcomes.
Pure helper fixtures cover hot/replaced/locked mappings between batches, UTF-8
paths, missing PSI, unknown/no-swap policy and bounded reads/chunks.

`KernelColdResidency` checks these bounded ownership/state/admission/cadence
invariants. TLC checks 2,095,266 generated states, 257,296 distinct states and depth
31. Its 17 matching fault configurations must fail their intended invariants.
The abstraction does not prove OS timing, physical memory release, Linux advice
semantics, arbitrary thread behavior or durable restart recovery. Exact commands,
model outcomes, swap-cache evidence and latency limitations are in
[the verification record](validation/kernel-cold-residency.md).

`KernelColdStatus` separately checks the existing actor-status observation's fixed
projection, legacy omission, bounded values and lack of namespace mutation. Its
positive configuration checks 12 states at depth 2; `legacy`, `payload`, `bounds`
and `mutation` controls fail. The actual ordinary-kernel fixture calls the existing
Python `kernel.status()` through its real host bridge after automatic advice;
projection fixtures reject invalid numbers, accessors and foreign payload fields.
