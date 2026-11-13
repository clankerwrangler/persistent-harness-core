------------------------ MODULE MessageLocation ------------------------
\* Sources:
\*   src/store.mjs sha256:a6ecb3526e086a1a4cb6dfab97009a3070f63c5d6ae0f038f2a2424ed6e3d225
\*   src/core-worker.mjs sha256:9d4cc1e0957a339276306c7aaffe806593ca2315ad0bb65c7b57731160433bfe
\*   src/supervisor.mjs sha256:384e8e6655a82ea78b01116cc9d51f6c6e473bff34407eb7eaf7d45da2aca48b
\*   src/core-transcript-reader.mjs sha256:4b2487304c758a1ac8b3a2026aa3430d95a6de56274b724272ae37316be68fa4
\*   src/input-location.mjs sha256:31cfde8719cf706fbd6266f1002783eaf127a9ee35e6cf57a2062db91a140a04
\*   src/conversation-projection.mjs sha256:9cff939b4541fb403dd7af8947017d7c013c24e444c1a04c11b40ab9af86e503
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
