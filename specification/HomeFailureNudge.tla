---- MODULE HomeFailureNudge ----
\* Sources:
\*   src/home-failure-nudge.mjs sha256:d733501fa1eb47724afcce40fd5d09a9011f3b448f35d95efbfed7be25ac62b0
\*   src/supervisor.mjs sha256:399af6a6b9ea4c75e9000de91f0ccc9af6e25d8dcf9477400229cb69d060af4e
\*   src/core-worker.mjs sha256:45e0bff2f093ae99c979e1e9407168ec197e16ead5751a4082d7be6ff46ba91a
\*   src/live-view.mjs sha256:fa7a8846c1a485bd3f38084cd8ffe77f2c24b5066738f9ae21925d7cedd7dbf8

\* Nobody observes Home's own failed run, so the supervisor nudges it later.
\* Its failure report travels on the control socket, its settle on the event
\* stream. The core worker sends the report when the turn fails, without holding the
\* settle, so the report can arrive before the settle or after it (as it does after a
\* lost connection). A settle cancels the
\* nudge only when no failure arrived since the previous settle. The nudge waits
\* while it is running. Home must never sit idle after a failed run with no
\* nudge pending, queued, or still to be armed by a report in flight.
EXTENDS Naturals
CONSTANTS MaxRuns, CancelEverySettle
VARIABLES run, outcome, lastRun, runs, inflight, settling,
          pending, failedSinceSettled, queued

vars == <<run, outcome, lastRun, runs, inflight, settling, pending, failedSinceSettled, queued>>

Init == /\ run = "idle" /\ outcome = "none" /\ lastRun = "ok" /\ runs = 0
        /\ inflight = 0 /\ settling = FALSE
        /\ pending = FALSE /\ failedSinceSettled = FALSE /\ queued = FALSE

\* HomeFailureNudge.failed: arm unless already pending.
Failed == /\ pending' = TRUE /\ failedSinceSettled' = TRUE

\* The user's input or a delivered nudge starts a run; the provider decides its outcome.
Start == /\ run = "idle" /\ ~settling /\ runs < MaxRuns
         /\ run' = "running" /\ runs' = runs + 1 /\ queued' = FALSE
         /\ outcome' \in {"ok", "failed"}
         /\ UNCHANGED <<lastRun, inflight, settling, pending, failedSinceSettled>>

\* The report arrives first: the supervisor records it before the settle.
EndConnected == /\ run = "running" /\ run' = "ended" /\ settling' = TRUE
  /\ (IF outcome = "failed" THEN Failed ELSE UNCHANGED <<pending, failedSinceSettled>>)
  /\ UNCHANGED <<outcome, lastRun, runs, inflight, queued>>

\* The report arrives after the settle: still in flight, or journaled and delivered on reconnection.
EndDisconnected == /\ run = "running" /\ outcome = "failed" /\ run' = "ended" /\ settling' = TRUE
  /\ inflight' = inflight + 1
  /\ UNCHANGED <<outcome, lastRun, runs, pending, failedSinceSettled, queued>>

\* The supervisor handles agent_settled: HomeFailureNudge.settled, and activity becomes idle.
Settle == /\ settling /\ settling' = FALSE /\ run' = "idle" /\ lastRun' = outcome
  /\ pending' = (IF CancelEverySettle \/ ~failedSinceSettled THEN FALSE ELSE pending)
  /\ failedSinceSettled' = FALSE
  /\ UNCHANGED <<outcome, runs, inflight, queued>>

LateReport == /\ inflight > 0 /\ inflight' = inflight - 1 /\ Failed
  /\ UNCHANGED <<run, outcome, lastRun, runs, settling, queued>>

\* The tick queues a due nudge only while Home's activity is not working.
Nudge == /\ pending /\ run = "idle" /\ ~settling
  /\ queued' = TRUE /\ pending' = FALSE
  /\ UNCHANGED <<run, outcome, lastRun, runs, inflight, settling, failedSinceSettled>>

\* The run bound ends exploration; it is not a deadlock in the modeled system.
Done == runs = MaxRuns /\ UNCHANGED vars
Next == Start \/ EndConnected \/ EndDisconnected \/ Settle \/ LateReport \/ Nudge \/ Done
Spec == Init /\ [][Next]_vars

NeverStranded == (run = "idle" /\ ~settling /\ lastRun = "failed")
  => (pending \/ queued \/ inflight > 0)
====
