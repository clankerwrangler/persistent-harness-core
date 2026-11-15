--------------------- MODULE ActorInputReconciliation ---------------------
\* Sources:
\*   src/core-worker.mjs sha256:45e0bff2f093ae99c979e1e9407168ec197e16ead5751a4082d7be6ff46ba91a
\*   src/supervisor.mjs sha256:399af6a6b9ea4c75e9000de91f0ccc9af6e25d8dcf9477400229cb69d060af4e
\*   src/core-transcript-reader.mjs sha256:e0f42d64c659fc0ccb74e68c8d6534a938bc4d7c9c16080feecd4014315a3b66
\*   src/session-records.mjs sha256:bc1ff9ac4a91b5cd6c7a28a83f84be78b054caf65f6cf8cec48a5ed8018c09f4
\*   bin/session-records.mjs sha256:66a7df9c543922de6bf06bc275fc77265542ccea4bac696cd98294effdeb12f5

EXTENDS Naturals, FiniteSets
CONSTANTS ReconcileHistory, SingleFlightReports
VARIABLES ready, generation, pending, proof, accepted, writes, delivered,
          incremental, admitted, stopped, startupQueries, reporting, callers, reportEpoch, reportFault
vars == <<ready, generation, pending, proof, accepted, writes, delivered,
          incremental, admitted, stopped, startupQueries, reporting, callers, reportEpoch, reportFault>>
Inputs == {"old", "new", "completed"}
\* The core worker reports saved inputs when a turn starts, when it settles, and after
\* adding a cron or background input; all share one report owner per input.
Callers == {"flush1", "flush2", "handle"}
Init == /\ ready = FALSE /\ generation = 1 /\ pending = {"old"}
        /\ proof \in [Inputs -> {"absent", "proven", "ambiguous"}]
        /\ proof["completed"] = "proven" /\ proof["new"] = "absent"
        /\ accepted = [i \in Inputs |-> 0] /\ writes = [i \in Inputs |-> 0]
        /\ delivered = {"completed"} /\ incremental = {} /\ admitted = FALSE
        /\ stopped = FALSE /\ startupQueries = {}
        /\ reporting = {} /\ callers = [c \in Callers |-> "none"]
        /\ reportEpoch = [i \in Inputs |-> 0] /\ reportFault = FALSE

\* Actor startup takes an append cursor (inputs already in history count as reported),
\* not historical receipt RPCs. The supervisor already owns pending reconciliation
\* before every transport submit, reading proofs through the core (VisibleInputProofs).
Start == /\ ~ready /\ ~stopped /\ ready' = TRUE
         /\ UNCHANGED <<generation, pending, proof, accepted, writes, delivered,
                        incremental, admitted, stopped, startupQueries, reporting, callers, reportEpoch, reportFault>>
Admit == /\ ~admitted /\ ~stopped /\ admitted' = TRUE /\ pending' = pending \cup {"new"}
         /\ UNCHANGED <<ready, generation, proof, accepted, writes, delivered,
                        incremental, stopped, startupQueries, reporting, callers, reportEpoch, reportFault>>
Reconcile(i) == /\ ReconcileHistory /\ ready /\ ~stopped /\ i \in pending /\ proof[i] = "proven"
                /\ pending' = pending \ {i} /\ delivered' = delivered \cup {i}
                /\ UNCHANGED <<ready, generation, proof, accepted, writes, incremental,
                               admitted, stopped, startupQueries, reporting, callers, reportEpoch, reportFault>>
Submit(i) == /\ ready /\ ~stopped /\ i \in pending /\ proof[i] = "absent"
             /\ accepted[i] # generation /\ accepted' = [accepted EXCEPT ![i] = generation]
             /\ UNCHANGED <<ready, generation, pending, proof, writes, delivered,
                            incremental, admitted, stopped, startupQueries, reporting, callers, reportEpoch, reportFault>>
Commit(i) == /\ ready /\ ~stopped /\ i \in pending
             /\ accepted[i] = generation /\ proof[i] = "absent"
             /\ proof' = [proof EXCEPT ![i] = "proven"]
             /\ writes' = [writes EXCEPT ![i] = @ + 1] /\ incremental' = incremental \cup {i}
             /\ UNCHANGED <<ready, generation, pending, accepted, delivered, admitted,
                            stopped, startupQueries, reporting, callers, reportEpoch, reportFault>>
\* Both incremental flushes and an already-proven internal command use the same
\* per-input report owner. A waiter validates its own canonical association before
\* sharing that owner's physical proof/receipt; unrelated inputs remain independent.
BeginReport(c, i) == /\ ready /\ ~stopped /\ callers[c] = "none"
                     /\ i \in pending /\ proof[i] = "proven"
                     /\ (c = "handle" \/ i \in incremental)
                     /\ (i \notin reporting \/ reportEpoch[i] = generation)
                     /\ callers' = [callers EXCEPT ![c] = i]
                     /\ reporting' = reporting \cup {i}
                     /\ reportEpoch' = [reportEpoch EXCEPT ![i] = generation]
                     /\ reportFault' = (reportFault \/ (~SingleFlightReports /\ i \in reporting))
                     /\ UNCHANGED <<ready, generation, pending, proof, accepted, writes,
                                    delivered, incremental, admitted, stopped, startupQueries>>
Report(i) == /\ ready /\ ~stopped /\ i \in reporting /\ proof[i] = "proven" /\ reportEpoch[i] = generation
             /\ pending' = pending \ {i} /\ delivered' = delivered \cup {i}
             /\ reporting' = reporting \ {i}
             /\ callers' = [c \in Callers |-> IF callers[c] = i THEN "none" ELSE callers[c]]
             /\ UNCHANGED <<ready, generation, proof, accepted, writes, incremental,
                            admitted, stopped, startupQueries, reportEpoch, reportFault>>
\* A genuine proof/RPC failure rejects all waiters; it does not acknowledge, drop
\* the durable pending input, or prevent a later existing-boundary attempt.
FailReport(i) == /\ i \in reporting
                 /\ reporting' = reporting \ {i}
                 /\ callers' = [c \in Callers |-> IF callers[c] = i THEN "none" ELSE callers[c]]
                 /\ UNCHANGED <<ready, generation, pending, proof, accepted, writes, delivered,
                                incremental, admitted, stopped, startupQueries, reportEpoch, reportFault>>
\* A new generation is a new worker process (Crash): its reports start afresh.
Crash == /\ ready /\ generation = 1 /\ ~stopped /\ ready' = FALSE
         /\ generation' = 2 /\ incremental' = {}
         /\ reporting' = {} /\ callers' = [c \in Callers |-> "none"]
         /\ UNCHANGED <<pending, proof, accepted, writes, delivered, admitted, stopped,
                        startupQueries, reportEpoch, reportFault>>
Stop == /\ ~stopped /\ stopped' = TRUE /\ ready' = FALSE
        /\ reporting' = {} /\ callers' = [c \in Callers |-> "none"]
         /\ UNCHANGED <<generation, pending, proof, accepted, writes, delivered, incremental,
                       admitted, startupQueries, reportEpoch, reportFault>>
Next == Start \/ Admit \/ Crash \/ Stop
        \/ (\E i \in Inputs: Reconcile(i) \/ Submit(i) \/ Commit(i) \/ Report(i) \/ FailReport(i))
        \/ (\E c \in Callers, i \in Inputs: BeginReport(c, i))
Spec == Init /\ [][Next]_vars
ProofBeforeDelivered == \A i \in delivered: proof[i] = "proven"
NoCanonicalReplay == \A i \in Inputs: writes[i] <= 1
CompletedNeverRevalidated == "completed" \notin startupQueries /\ accepted["completed"] = 0
AmbiguousNeverSubmitted == \A i \in Inputs: proof[i] = "ambiguous" => accepted[i] = 0
NoLostPending == pending \cup delivered = {"old", "completed"} \cup (IF admitted THEN {"new"} ELSE {})
HistoricalProofRecoverable == \A i \in pending:
    ready /\ ~stopped /\ proof[i] = "proven" => ENABLED Reconcile(i)
NoOverlappingDeliveryFence == ~reportFault
WaitersHaveOwner == \A c \in Callers: callers[c] # "none" => callers[c] \in reporting
=============================================================================
