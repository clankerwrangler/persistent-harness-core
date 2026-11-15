--------------------- MODULE SessionHistorySnapshot ---------------------
\* Sources:
\*   src/session-history-index.mjs sha256:3500580c51ec174b689e99fa4c0b8665b6132e9a3abe030fe13c6079ce521f76
\*   src/supervisor.mjs sha256:399af6a6b9ea4c75e9000de91f0ccc9af6e25d8dcf9477400229cb69d060af4e
\*   src/session-records.mjs sha256:bc1ff9ac4a91b5cd6c7a28a83f84be78b054caf65f6cf8cec48a5ed8018c09f4
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
