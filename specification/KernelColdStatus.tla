------------------------- MODULE KernelColdStatus -------------------------
\* Sources:
\*   src/host-handlers.mjs sha256:8571f6ec6f51d4ce085843d02ecdfe30d775a54ba2dceb21d67d5c230c9c5b8a
\*   src/kernel.mjs sha256:086b1e9aa5ca892fa4035a67abab043dad664b5f95ea829a01dab28f3bd525b6

EXTENDS Naturals
CONSTANT Fault
VARIABLES capability, valid, observed, field, payload, bounded, identity
vars == <<capability, valid, observed, field, payload, bounded, identity>>
Init == /\ capability \in {0,1,2} /\ valid \in BOOLEAN
        /\ observed=FALSE /\ field="absent" /\ payload=FALSE /\ bounded=TRUE /\ identity=42
Observe == /\ ~observed /\ observed'=TRUE
           /\ field'=IF capability=1 \/ Fault="legacy" THEN "fixed" ELSE "absent"
           /\ payload'=(Fault="payload")
           /\ bounded'=(valid \/ Fault#"bounds")
           /\ identity'=IF Fault="mutation" THEN 0 ELSE identity
           /\ UNCHANGED <<capability,valid>>
Spec == Init /\ [][Observe]_vars
LegacyUnchanged == observed /\ capability#1 => field="absent"
FixedProjection == ~payload /\ bounded
NoNamespaceMutation == identity=42
=============================================================================
