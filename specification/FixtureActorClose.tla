------------------------- MODULE FixtureActorClose -------------------------
\* Sources:
\*   test/fixtures/notification-supervisor.mjs sha256:e9e1f991f5422504aa85ae1ab75ea16702db03da8c082446a328fe277157c483
\*   src/supervisor.mjs sha256:8873880511b6679f9a6b6d0d3d3657c72b54e1512f7f853bbaf7f09b24b49eb9

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
