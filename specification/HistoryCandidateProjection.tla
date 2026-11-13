---------------------- MODULE HistoryCandidateProjection ----------------------
\* Sources:
\*   src/store.mjs sha256:a6ecb3526e086a1a4cb6dfab97009a3070f63c5d6ae0f038f2a2424ed6e3d225
\*   src/supervisor.mjs sha256:384e8e6655a82ea78b01116cc9d51f6c6e473bff34407eb7eaf7d45da2aca48b

EXTENDS Naturals
CONSTANTS ResolveHistoryFast, ResolveDefaultFast, PreserveMetadata, PreserveErrors
VARIABLES version, consumer, malformed, phase, sampled, metadata, fast, fastReads
vars == <<version, consumer, malformed, phase, sampled, metadata, fast, fastReads>>
Metadata(v) == [sessionId |-> "child", kind |-> "child", depth |-> 1,
                name |-> <<"child", v>>, lineage |-> <<"parent", "child", v>>,
                lifecycle |-> "retained", sessionFile |-> "canonical",
                shortId |-> "short", createdAt |-> 0, updatedAt |-> v]
Init == /\ version = 0 /\ consumer \in {"history", "default"}
        /\ malformed \in BOOLEAN /\ phase = "before" /\ sampled = 0
        /\ metadata = Metadata(0) /\ fast = 2 /\ fastReads = 0
Change == /\ version = 0 /\ version' = 1
          /\ UNCHANGED <<consumer, malformed, phase, sampled, metadata, fast, fastReads>>
\* Only the unused Fast derivation changes. Registry observation and the original
\* full mapper (including its errors) remain at the same synchronous boundary.
Read == /\ phase = "before"
        /\ LET resolve == IF consumer = "history" THEN ResolveHistoryFast ELSE ResolveDefaultFast
           IN /\ sampled' = version
              /\ metadata' = IF PreserveMetadata THEN Metadata(version) ELSE Metadata(0)
              /\ fast' = IF resolve THEN version ELSE 2
              /\ fastReads' = IF resolve THEN 3 ELSE 0
              /\ phase' = IF malformed /\ PreserveErrors THEN "error" ELSE "returned"
        /\ UNCHANGED <<version, consumer, malformed>>
Next == Change \/ Read \/ /\ phase # "before" /\ UNCHANGED vars
SameMetadata == phase = "returned" => metadata = Metadata(sampled)
DefaultStillFull == consumer = "default" /\ phase = "returned" => fast = sampled
NoUnusedHistoryReads == consumer = "history" /\ phase # "before" => fastReads = 0
SameError == malformed /\ phase # "before" => phase = "error"
Spec == Init /\ [][Next]_vars
===============================================================================
