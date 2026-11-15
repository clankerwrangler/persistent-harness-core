------------------------- MODULE KernelColdStatus -------------------------
\* Sources:
\*   src/host-handlers.mjs sha256:ad3ecf9ec5c1724dc4aab25ea026d4304753b7a481ca8528542192247be5cdf9
\*   src/kernel.mjs sha256:b3a52680c0e061db087bd674a0874fcb87e1793b532cd494b58d9631c88c2063

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
