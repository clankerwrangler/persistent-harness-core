------------------------ MODULE MessageLocation ------------------------
\* Sources:
\*   src/store.mjs
\*   src/core-worker.mjs
\*   src/supervisor.mjs
\*   src/core-transcript-reader.mjs
\*   src/input-location.mjs
\*   src/conversation-projection.mjs
\*   src/session-records.mjs
\*   bin/session-records.mjs
EXTENDS Naturals, Sequences, FiniteSets
\* The caller supplies an already-frozen optional attachment. Browser consent,
\* acquisition deadlines, and cancellation are not harness guarantees. The worker sends
\* the location to the core as a marked text block of the message, so the saved
\* (canonical) message holds it and the model sees it; public views leave it out.
CONSTANT None
VARIABLES frozen, dispatched, durable, canonical
vars == <<frozen, dispatched, durable, canonical>>
Range(seq) == {seq[i] : i \in 1..Len(seq)}
Locations == {"A", "B"}
Records == [text : {"genuine text"}, location : Locations \cup {None}]
Init == /\ frozen \in Records /\ dispatched = <<frozen>>
        /\ durable = <<>> /\ canonical = <<>>
Admit == /\ Len(dispatched) = 1 /\ Len(durable) = 0 /\ Len(canonical) = 0
         /\ durable' = dispatched
         /\ UNCHANGED <<frozen, dispatched, canonical>>
Replay == /\ Len(dispatched) = 1 /\ UNCHANGED vars
Commit == /\ Len(durable) = 1 /\ Len(canonical) = 0
          /\ canonical' = durable /\ durable' = <<>>
          /\ UNCHANGED <<frozen, dispatched>>
Next == Admit \/ Replay \/ Commit
TypeOK == /\ frozen \in Records
          /\ \A records \in {dispatched, durable, canonical}:
               records \in Seq(Records) /\ Len(records) <= 1
ExactMessage == \A record \in {frozen} \cup Range(dispatched) \cup Range(durable)
                                \cup Range(canonical): record.text = "genuine text"
\* Equality covers the complete payload, including the optional location.
Immutable == /\ dispatched = <<frozen>>
             /\ (Len(durable) = 1 => durable = dispatched)
             /\ (Len(canonical) = 1 => canonical = dispatched)
\* These views abstract information availability, not exact wire text. The model is
\* sent the saved message with its location block; public projection omits it.
Provider(record) == [role |-> "user", text |-> record.text, location |-> record.location]
Public(record) == [role |-> "user", text |-> record.text]
ProjectionBoundary == \A record \in Range(canonical):
                         /\ Provider(record).role = "user"
                         /\ Provider(record).text = Public(record).text
                         /\ Provider(record).location = record.location
                         /\ ~("location" \in DOMAIN Public(record))
Spec == Init /\ [][Next]_vars
=============================================================================
