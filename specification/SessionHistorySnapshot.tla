--------------------- MODULE SessionHistorySnapshot ---------------------
\* Sources:
\*   src/session-history-index.mjs sha256:3500580c51ec174b689e99fa4c0b8665b6132e9a3abe030fe13c6079ce521f76
\*   src/supervisor.mjs sha256:834043fd3695b19d1be8dca80a1b0d944d9446874073b48452c29cc7430e53cd
\*   src/session-records.mjs sha256:8a3cc7904feac37c8fc8f5bf22f5545dba5b0bbe2851964ab0cc19435264a126
\*   src/core-transcript-reader.mjs sha256:e0f42d64c659fc0ccb74e68c8d6534a938bc4d7c9c16080feecd4014315a3b66
EXTENDS Naturals
CONSTANTS Isolate, ValidateSpans, LabelSnapshot, MaxVersion, HasIndex
VARIABLES source, committed, staged, writing, query, pinned, captured, strict,
          invalidBefore, returned, unsafe, mislabeled, closed
vars == <<source, committed, staged, writing, query, pinned, captured, strict,
          invalidBefore, returned, unsafe, mislabeled, closed>>
Init == /\ source = 1 /\ committed = 1 /\ staged = 0 /\ writing = FALSE
        /\ query = "idle" /\ pinned = 0 /\ captured = 0 /\ strict = FALSE
        /\ invalidBefore = 0 /\ returned = FALSE
        /\ unsafe = FALSE /\ mislabeled = FALSE /\ closed = FALSE
Append == /\ source < MaxVersion /\ source' = source + 1
          /\ UNCHANGED <<committed, staged, writing, query, pinned, captured, strict,
                        invalidBefore, returned, unsafe, mislabeled, closed>>
\* The core's history disagrees with what was indexed (indexed rows are checked
\* against the core when read back, ValidateSpans); the session is then indexed again.
Rewrite == /\ source < MaxVersion /\ source' = source + 1 /\ invalidBefore' = source + 1
           /\ UNCHANGED <<committed, staged, writing, query, pinned, captured, strict,
                         returned, unsafe, mislabeled, closed>>
Ingest == /\ HasIndex /\ ~closed /\ ~writing /\ staged' = source /\ writing' = TRUE
          /\ UNCHANGED <<source, committed, query, pinned, captured, strict, invalidBefore,
                        returned, unsafe, mislabeled, closed>>
Publish == /\ ~closed /\ writing /\ committed' = IF staged = source THEN staged ELSE committed
           /\ writing' = FALSE
           /\ UNCHANGED <<source, staged, query, pinned, captured, strict, invalidBefore,
                         returned, unsafe, mislabeled, closed>>
Take(s) == /\ HasIndex /\ ~closed /\ query = "idle" /\ (~s \/ committed = source)
           /\ pinned' = IF ~Isolate /\ writing THEN staged ELSE committed
           /\ captured' = committed /\ strict' = s /\ query' = "reading"
           /\ UNCHANGED <<source, committed, staged, writing, invalidBefore,
                         returned, unsafe, mislabeled, closed>>
Hydrate == /\ ~closed /\ query = "reading"
           /\ (~strict \/ pinned = source)
           /\ (~ValidateSpans \/ pinned >= invalidBefore)
           /\ returned' = TRUE /\ query' = "done"
           /\ unsafe' = (unsafe \/ pinned < invalidBefore)
           /\ mislabeled' = (mislabeled \/ (~strict /\ ~LabelSnapshot))
           /\ UNCHANGED <<source, committed, staged, writing, pinned, captured, strict,
                         invalidBefore, closed>>
Cancel == /\ query = "reading" /\ query' = "failed"
          /\ UNCHANGED <<source, committed, staged, writing, pinned, captured, strict,
                        invalidBefore, returned, unsafe, mislabeled, closed>>
Stop == /\ ~closed /\ ~writing /\ query # "reading" /\ closed' = TRUE
        /\ UNCHANGED <<source, committed, staged, writing, query, pinned, captured, strict,
                      invalidBefore, returned, unsafe, mislabeled>>
Next == Append \/ Rewrite \/ Ingest \/ Publish \/ Take(FALSE) \/ Take(TRUE) \/ Hydrate \/ Cancel \/ Stop
CommittedSnapshot == pinned <= captured
ValidatedHydration == ~unsafe
HonestFreshness == ~mislabeled
NoDisabledMaintenance == ~HasIndex => ~writing
SnapshotDoesNotWaitForIngest == HasIndex /\ ~closed /\ query = "idle" => ENABLED Take(FALSE)
Spec == Init /\ [][Next]_vars
=============================================================================
