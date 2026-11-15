-------------------- MODULE MemoryDiagnostics --------------------
\* Sources:
\*   src/kernel.mjs sha256:b3a52680c0e061db087bd674a0874fcb87e1793b532cd494b58d9631c88c2063
\*   src/core-worker.mjs sha256:45e0bff2f093ae99c979e1e9407168ec197e16ead5751a4082d7be6ff46ba91a
\*   src/supervisor.mjs sha256:399af6a6b9ea4c75e9000de91f0ccc9af6e25d8dcf9477400229cb69d060af4e
\*   src/protocol.mjs sha256:48b40e0384b3a637d65b909782657e23c29d57f069e09d083fb6d666306128d6
EXTENDS Naturals, TLC
CONSTANT IgnoreBusy, StartMissing, SkipReserve, MutateRead, BypassAuth
VARIABLES worker, kernel, queued, draining, phase, allowed, sends, unsafe,
          startedByRead, changedByRead, acceptedIdle, reserved
vars == <<worker,kernel,queued,draining,phase,allowed,sends,unsafe,
          startedByRead,changedByRead,acceptedIdle,reserved>>
Init == /\ worker \in BOOLEAN /\ kernel \in {"absent","idle","tool","host","snapshot"}
        /\ queued \in BOOLEAN /\ draining = FALSE /\ allowed \in BOOLEAN
        /\ phase = "new" /\ sends = 0 /\ unsafe = FALSE
        /\ startedByRead = FALSE /\ changedByRead = FALSE
        /\ acceptedIdle = TRUE /\ reserved = FALSE
Forward == /\ phase = "new" /\ phase' = "forwarded"
           /\ UNCHANGED <<worker,kernel,queued,draining,allowed,sends,unsafe,
                           startedByRead,changedByRead,acceptedIdle,reserved>>
Receive == /\ phase = "forwarded"
           /\ LET eligible == (allowed \/ BypassAuth) /\ ~draining /\ (worker \/ StartMissing)
                               /\ (kernel = "idle" \/ (IgnoreBusy /\ kernel \in {"tool","host","snapshot"}) \/ (kernel = "absent" /\ StartMissing))
                               /\ (~queued \/ IgnoreBusy)
              IN /\ phase' = IF eligible THEN "reading" ELSE "done"
                 /\ sends' = IF eligible THEN sends + 1 ELSE sends
                 /\ unsafe' = (unsafe \/ (eligible /\ (~allowed \/ kernel \in {"tool","host","snapshot"})))
                 /\ acceptedIdle' = (~eligible \/ (kernel = "idle" /\ ~queued /\ ~draining))
                 /\ startedByRead' = (startedByRead \/ (eligible /\ (~worker \/ kernel = "absent")))
                 /\ changedByRead' = (changedByRead \/ (eligible /\ MutateRead))
                 /\ reserved' = (eligible /\ ~SkipReserve)
                 /\ kernel' = IF eligible /\ ~SkipReserve THEN "diagnostic" ELSE kernel
           /\ UNCHANGED <<worker,queued,draining,allowed>>
Wake == /\ ~queued /\ queued' = TRUE
        /\ UNCHANGED <<worker,kernel,draining,phase,allowed,sends,unsafe,startedByRead,changedByRead,acceptedIdle,reserved>>
BeginWork == /\ queued /\ kernel = "idle" /\ ~draining
             /\ kernel' = "tool" /\ queued' = FALSE
             /\ unsafe' = (unsafe \/ (phase = "reading"))
             /\ UNCHANGED <<worker,draining,phase,allowed,sends,startedByRead,changedByRead,acceptedIdle,reserved>>
Drain == /\ ~draining /\ draining' = TRUE
         /\ UNCHANGED <<worker,kernel,queued,phase,allowed,sends,unsafe,startedByRead,changedByRead,acceptedIdle,reserved>>
Complete == /\ phase = "reading" /\ phase' = "done"
            /\ kernel' = (IF reserved THEN "idle" ELSE kernel) /\ reserved' = FALSE
            /\ UNCHANGED <<worker,queued,draining,allowed,sends,unsafe,startedByRead,changedByRead,acceptedIdle>>
Next == Forward \/ Receive \/ Wake \/ BeginWork \/ Drain \/ Complete
Spec == Init /\ [][Next]_vars
SafePipeAndScope == ~unsafe
NoStart == ~startedByRead
NoMutation == ~changedByRead
ImmediateBusy == phase = "reading" => acceptedIdle
=============================================================================
