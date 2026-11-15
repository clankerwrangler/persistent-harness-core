------------------------- MODULE FixtureActorClose -------------------------
\* Sources:
\*   test/fixtures/notification-supervisor.mjs sha256:b5eddf898a2c58753714b1584665bd8f0f6a76207aa931380ddc353a9bee1720
\*   src/supervisor.mjs sha256:399af6a6b9ea4c75e9000de91f0ccc9af6e25d8dcf9477400229cb69d060af4e

EXTENDS Naturals, TLC
CONSTANT JoinClose
VARIABLES running, tracked, lifecycle, stopPhase, cleanupPhase, exited
vars == <<running, tracked, lifecycle, stopPhase, cleanupPhase, exited>>
Init == /\ running = TRUE /\ tracked = TRUE /\ lifecycle = "resident"
        /\ stopPhase = "new" /\ cleanupPhase = "new" /\ exited = FALSE
BeginStop == /\ stopPhase = "new" /\ stopPhase' = "waiting" /\ running' = FALSE
             /\ UNCHANGED <<tracked, lifecycle, cleanupPhase, exited>>
CleanupClose == /\ stopPhase = "waiting" /\ cleanupPhase = "new"
                /\ cleanupPhase' = IF JoinClose THEN "waiting" ELSE "returned"
                /\ UNCHANGED <<running, tracked, lifecycle, stopPhase, exited>>
ForgetRecord == /\ cleanupPhase = "returned" /\ ~running /\ tracked
                /\ tracked' = FALSE
                /\ UNCHANGED <<running, lifecycle, stopPhase, cleanupPhase, exited>>
Exit == /\ stopPhase = "waiting" /\ ~exited /\ exited' = TRUE
        /\ lifecycle' = IF tracked THEN "stopped" ELSE lifecycle
        /\ tracked' = FALSE
        /\ UNCHANGED <<running, stopPhase, cleanupPhase>>
ReturnCleanup == /\ cleanupPhase = "waiting" /\ exited /\ cleanupPhase' = "returned"
                 /\ UNCHANGED <<running, tracked, lifecycle, stopPhase, exited>>
ReturnStop == /\ stopPhase = "waiting" /\ exited /\ stopPhase' = "returned"
              /\ UNCHANGED <<running, tracked, lifecycle, cleanupPhase, exited>>
Next == BeginStop \/ CleanupClose \/ ForgetRecord \/ Exit \/ ReturnCleanup \/ ReturnStop
Spec == Init /\ [][Next]_vars
TypeOK == /\ running \in BOOLEAN /\ tracked \in BOOLEAN /\ exited \in BOOLEAN
          /\ lifecycle \in {"resident", "stopped"}
          /\ stopPhase \in {"new", "waiting", "returned"}
          /\ cleanupPhase \in {"new", "waiting", "returned"}
ExitOwnsRetirement == ~tracked => lifecycle = "stopped"
StopIsDurable == stopPhase = "returned" => lifecycle = "stopped"
=============================================================================
