---- MODULE PythonRecoveryGuard ----
\* Sources:
\*   src/python-recovery.mjs sha256:4a00d7b21f01b33957713d8ef5107338e2f840147495eadbbd88c27894754275
\*   src/core-worker.mjs sha256:6a68d2aa971379810b37268a216ff90ee0d023e4f805432aa3c5e1da788a1925

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
