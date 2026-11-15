-------------------------- MODULE ModelCatalogRefresh --------------------------
\* Sources:
\*   src/core-worker.mjs sha256:45e0bff2f093ae99c979e1e9407168ec197e16ead5751a4082d7be6ff46ba91a
\*   src/host-handlers.mjs sha256:ad3ecf9ec5c1724dc4aab25ea026d4304753b7a481ca8528542192247be5cdf9
\*   src/model-capabilities.mjs sha256:40fe62270e3ad5dc60cc341cdbb4b32a4c1fb8f5ba574c2e7f1e4f38799abbd0
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
