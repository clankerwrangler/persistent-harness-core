---- MODULE PythonRecoveryGuard ----
\* Sources:
\*   src/python-recovery.mjs sha256:6300552c50b7cd56a5af3ced930868c819950aaff55235cd9193448146e2720b
\*   src/core-worker.mjs sha256:bb186881aaf119c4f2575c69f016b0c5c378270770968b36df8b14fe5cae1410

\* A request can be prepared, sent, then the kernel can be replaced before a
\* Python call from that request arrives. Only a diagnostic for the current
\* kernel in a sent request makes the planned call safe to run.
EXTENDS Naturals, FiniteSets
CONSTANTS MaxGeneration, SkipGuard
VARIABLES generation, prepared, sent, visible, ranUnseen, blocked
vars == <<generation, prepared, sent, visible, ranUnseen, blocked>>
Init == /\ generation = 1 /\ prepared = 0 /\ sent = FALSE
        /\ visible = {} /\ ranUnseen = FALSE /\ blocked = FALSE
Prepare == /\ prepared' = generation /\ sent' = FALSE /\ blocked' = FALSE
           /\ UNCHANGED <<generation, visible, ranUnseen>>
Send == /\ prepared # 0 /\ ~sent
        /\ sent' = TRUE
        /\ visible' = IF prepared = generation THEN visible \cup {generation} ELSE visible
        /\ UNCHANGED <<generation, prepared, ranUnseen, blocked>>
Replace == /\ generation < MaxGeneration /\ generation' = generation + 1
           /\ UNCHANGED <<prepared, sent, visible, ranUnseen, blocked>>
Dispatch == /\ sent /\ ~blocked
            /\ IF generation \in visible \/ SkipGuard
                 THEN /\ ranUnseen' = (ranUnseen \/ generation \notin visible)
                      /\ UNCHANGED blocked
                 ELSE /\ blocked' = TRUE /\ UNCHANGED ranUnseen
            /\ UNCHANGED <<generation, prepared, sent, visible>>
Next == Prepare \/ Send \/ Replace \/ Dispatch
Spec == Init /\ [][Next]_vars
NoUnseenExecution == ~ranUnseen
====
