------------------------- MODULE VisibleInputProofs -------------------------
\* Sources:
\*   src/core-transcript-reader.mjs
\*   src/conversation-projection.mjs
\*   src/supervisor.mjs
\*   src/session-records.mjs
\*   bin/session-records.mjs

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
