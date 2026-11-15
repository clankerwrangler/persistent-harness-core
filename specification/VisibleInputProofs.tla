------------------------- MODULE VisibleInputProofs -------------------------
\* Sources:
\*   src/core-transcript-reader.mjs sha256:e0f42d64c659fc0ccb74e68c8d6534a938bc4d7c9c16080feecd4014315a3b66
\*   src/conversation-projection.mjs sha256:76d0753210a8c364e3c6b0a22592f9b74cdd18a05f58ebb9f21ba32b6e8d167e
\*   src/supervisor.mjs sha256:399af6a6b9ea4c75e9000de91f0ccc9af6e25d8dcf9477400229cb69d060af4e
\*   src/session-records.mjs sha256:bc1ff9ac4a91b5cd6c7a28a83f84be78b054caf65f6cf8cec48a5ed8018c09f4
\*   bin/session-records.mjs sha256:66a7df9c543922de6bf06bc275fc77265542ccea4bac696cd98294effdeb12f5

\* Input proofs read through the core. Every read asks the core for the session's
\* current chunk; nothing is cached, so a read's evidence is the history as of that
\* read. A page read (what the UI shows) never authorizes delivery: the supervisor
\* discards its proofs. A delivery read proves only the inputs it asked about. A
\* queue read must cover inputs admitted while it was reading before it submits.
EXTENDS FiniteSets
CONSTANTS ReconcileNewPending, DiscardPageProofs
VARIABLES phase, purpose, pending, selected, readIds, inHistory, proven, submitted, authorityIds
vars == <<phase, purpose, pending, selected, readIds, inHistory, proven, submitted, authorityIds>>
Inputs == {"old", "selected", "new"}

Init == /\ phase = "ready" /\ purpose \in {"page", "delivery", "queue"}
        /\ pending = {"selected"} /\ selected = {} /\ readIds = {}
        /\ inHistory \in SUBSET Inputs /\ proven = {} /\ submitted = {} /\ authorityIds = {}

\* The core saves an input, independently of any read.
Incorporate(i) == /\ i \notin inHistory /\ inHistory' = inHistory \cup {i}
                  /\ UNCHANGED <<phase, purpose, pending, selected, readIds, proven, submitted, authorityIds>>
Select == /\ phase = "ready" /\ phase' = "selected"
          /\ selected' = IF purpose = "queue" THEN pending ELSE IF purpose = "page" THEN {} ELSE {"selected"}
          /\ UNCHANGED <<purpose, pending, readIds, inHistory, proven, submitted, authorityIds>>
\* A page read associates every input in the chunk; a proof read only those it names.
Read == /\ phase = "selected" /\ phase' = "read" /\ readIds' = selected
        /\ proven' = IF purpose = "page" THEN inHistory ELSE selected \cap inHistory
        /\ UNCHANGED <<purpose, pending, selected, inHistory, submitted, authorityIds>>
AdmitDuringRead == /\ purpose = "queue" /\ phase \in {"selected", "read"} /\ "new" \notin pending
                   /\ pending' = pending \cup {"new"}
                   /\ UNCHANGED <<phase, purpose, selected, readIds, inHistory, proven, submitted, authorityIds>>
Rescope == /\ purpose = "queue" /\ phase = "read" /\ ~(pending \subseteq readIds)
           /\ phase' = "ready" /\ selected' = {} /\ readIds' = {} /\ proven' = {}
           /\ UNCHANGED <<purpose, pending, inHistory, submitted, authorityIds>>
Return == /\ phase = "read"
          /\ (purpose # "queue" \/ ~ReconcileNewPending \/ pending \subseteq readIds)
          /\ submitted' = IF purpose = "queue" THEN pending ELSE submitted
          /\ authorityIds' = IF purpose = "page" /\ DiscardPageProofs THEN {} ELSE proven
          /\ phase' = "done"
          /\ UNCHANGED <<purpose, pending, selected, readIds, inHistory, proven>>
Next == AdmitDuringRead \/ Rescope \/ Select \/ Read \/ Return \/ (\E i \in Inputs: Incorporate(i))
Spec == Init /\ [][Next]_vars

PageRenderNeverAuthorizesDelivery == purpose = "page" => authorityIds = {}
SubmittedScopeReconciled == submitted \subseteq readIds
ProofsWithinScope == purpose # "page" => authorityIds \subseteq readIds
ProofsAreHistory == authorityIds \subseteq inHistory
=============================================================================
