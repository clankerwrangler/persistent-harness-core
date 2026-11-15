------------------------ MODULE MessageLocation ------------------------
\* Sources:
\*   src/store.mjs sha256:a6ecb3526e086a1a4cb6dfab97009a3070f63c5d6ae0f038f2a2424ed6e3d225
\*   src/core-worker.mjs sha256:6a68d2aa971379810b37268a216ff90ee0d023e4f805432aa3c5e1da788a1925
\*   src/supervisor.mjs sha256:834043fd3695b19d1be8dca80a1b0d944d9446874073b48452c29cc7430e53cd
\*   src/core-transcript-reader.mjs sha256:e0f42d64c659fc0ccb74e68c8d6534a938bc4d7c9c16080feecd4014315a3b66
\*   src/input-location.mjs sha256:31cfde8719cf706fbd6266f1002783eaf127a9ee35e6cf57a2062db91a140a04
\*   src/conversation-projection.mjs sha256:76d0753210a8c364e3c6b0a22592f9b74cdd18a05f58ebb9f21ba32b6e8d167e
\*   src/session-records.mjs sha256:8a3cc7904feac37c8fc8f5bf22f5545dba5b0bbe2851964ab0cc19435264a126
\*   bin/session-records.mjs sha256:66a7df9c543922de6bf06bc275fc77265542ccea4bac696cd98294effdeb12f5
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
