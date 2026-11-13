---- MODULE PythonRecoveryGuard ----
\* Sources:
\*   src/python-recovery.mjs sha256:f1e11b571ead1b69c05593a41c4cbb4840b9f2c56155adc46ca41da239a620b2
\*   src/core-worker.mjs sha256:1600668c3a25dfd8d336a7eccb59928b5cb80d1ab424c0b9b1746e9bf2cf4a2e

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
