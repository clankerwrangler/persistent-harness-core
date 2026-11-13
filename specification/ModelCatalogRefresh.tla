-------------------------- MODULE ModelCatalogRefresh --------------------------
\* Sources:
\*   src/core-worker.mjs sha256:1600668c3a25dfd8d336a7eccb59928b5cb80d1ab424c0b9b1746e9bf2cf4a2e
\*   src/host-handlers.mjs sha256:8571f6ec6f51d4ce085843d02ecdfe30d775a54ba2dceb21d67d5c230c9c5b8a
EXTENDS Naturals
CONSTANT Requests
VARIABLES phase, operation, outcome, result, warning, networkPolicy, deadline, selection
vars == <<phase, operation, outcome, result, warning, networkPolicy, deadline, selection>>
Init == /\ phase = [r \in Requests |-> "new"]
        /\ operation \in [Requests -> {"picker", "search", "pin"}]
        /\ outcome \in [Requests -> {"fresh", "failure", "timeout"}]
        /\ result = [r \in Requests |-> {}]
        /\ warning = [r \in Requests |-> FALSE]
        /\ networkPolicy = [r \in Requests |-> "unset"]
        /\ deadline = [r \in Requests |-> 0] /\ selection = "current"
Call(r) == /\ phase[r] = "new" /\ phase' = [phase EXCEPT ![r] = "refreshing"]
           /\ networkPolicy' = [networkPolicy EXCEPT ![r] = "local"]
           /\ deadline' = [deadline EXCEPT ![r] = 15000]
           /\ UNCHANGED <<operation, outcome, result, warning, selection>>
\* The core's model list is read locally, never from the network. A failed or timed-out
\* reload keeps the last list and says so; the caller reads the list only after the
\* reload settles and never selects a model.
Return(r) == /\ phase[r] = "refreshing" /\ phase' = [phase EXCEPT ![r] = "done"]
             /\ result' = [result EXCEPT ![r] = IF outcome[r] = "fresh" THEN {"cached", "new"} ELSE {"cached"}]
             /\ warning' = [warning EXCEPT ![r] = (outcome[r] # "fresh")]
             /\ UNCHANGED <<operation, outcome, networkPolicy, deadline, selection>>
Next == (\E r \in Requests: Call(r) \/ Return(r))
        \/ ((\A r \in Requests: phase[r] = "done") /\ UNCHANGED vars)
NoNetwork == \A r \in Requests: phase[r] # "new" => networkPolicy[r] = "local"
BoundPassed == \A r \in Requests: phase[r] # "new" => deadline[r] = 15000
NoDefaultChange == selection = "current"
FallbackVisible == \A r \in Requests: phase[r] = "done" => "cached" \in result[r]
FailureVisible == \A r \in Requests: phase[r] = "done" => warning[r] = (outcome[r] # "fresh")
Spec == Init /\ [][Next]_vars
===============================================================================
