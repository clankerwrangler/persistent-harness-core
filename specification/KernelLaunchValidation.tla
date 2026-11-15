-------------------- MODULE KernelLaunchValidation --------------------
\* Sources:
\*   src/python-launch.mjs sha256:94f072c9d2a8dc1a8b048a4bfb840c61daf73990c8164716283f3aebb3b651e1
\*   src/python-runtime-layout.mjs sha256:97b21d1ea5c77f195b76805883d37fd7bd77187a845fcfb120e8bc3b5c852fcd
\*   src/python-runtime.mjs sha256:f6655f5ca478197e78b8744a7f3c62bca66cd17d25d5f7ee8e565c3f7a5003fb
\*   src/kernel.mjs sha256:b3a52680c0e061db087bd674a0874fcb87e1793b532cd494b58d9631c88c2063
\*   src/core-worker.mjs sha256:6a68d2aa971379810b37268a216ff90ee0d023e4f805432aa3c5e1da788a1925
\*   python-runtime/kernel.py sha256:d4aa99006f90d531b546686f6208dc48f77609f4faa00dabb91e7a81f80bc361
\*   python-runtime/_persistent_harness.py sha256:c9bfdef5351102e88de2a6806b355ff3d6f4638516a7165d3bd779682042f9fb

\* Two owners. The supervisor installs a session's managed Python runtime: it takes the
\* install lock, asks for consent, builds, validates the build, and only then publishes its
\* completion record (python-runtime.mjs). A session starts its kernel only in runtimes
\* already published, the exact one first, then compatible ones (python-launch.mjs); it never
\* installs, and with none usable its start fails. The supervisor may publish while a session
\* is choosing; the session works from the list it read. A candidate whose interpreter is
\* missing or wrong is retired before the next is tried; any other failure ends the start.
\* An override interpreter is the only candidate. Concurrent callers share one start
\* (core-worker.mjs); a ready kernel can later be replaced by a second generation.
\* Fault: "cwd"/"ambiguous"/"metadata" treat a startup failure as a runtime rejection;
\* "fresh" accepts a cached import check; "pins" accepts wrong managed pins; "fallback" moves
\* on after a failed restore; "expose" shows a kernel before it is ready; "unpublished" lets a
\* session use a runtime that was not published when it read the list; "earlyPublish"
\* publishes a build before it is validated.
EXTENDS Naturals, FiniteSets, TLC
CONSTANT Fault
VARIABLE s, inst, pub
vars == <<s, inst, pub>>
MaxPub == 2
Init == /\ pub \in 0..1
        /\ inst = [phase |-> "idle", lock |-> FALSE, consent |-> FALSE, validated |-> FALSE,
                   badCompletion |-> FALSE]
        /\ \E o \in BOOLEAN:
             s = [generation |-> 1, override |-> o, phase |-> "read", cand |-> 1, listed |-> 0,
                  active |-> FALSE, retired |-> TRUE, proof |-> 0, cached |-> FALSE,
                  managed |-> ~o, importsOK |-> TRUE, pinsOK |-> TRUE,
                  ready |-> FALSE, waiters |-> 1, kind |-> "none", badClassification |-> FALSE,
                  badFresh |-> FALSE, badPins |-> FALSE, badFallback |-> FALSE, badExpose |-> FALSE,
                  badRetire |-> FALSE, badUnpublished |-> FALSE]

\* ---- the supervisor's installer ----
ILock == /\ inst.phase="idle" /\ pub=0
         /\ inst'=[inst EXCEPT !.phase="locked", !.lock=TRUE] /\ UNCHANGED <<s, pub>>
IConsent == /\ inst.phase="locked"
            /\ inst'=[inst EXCEPT !.phase="consented", !.consent=TRUE] /\ UNCHANGED <<s, pub>>
IBuild == /\ inst.phase="consented"
          /\ inst'=[inst EXCEPT !.phase="built"] /\ UNCHANGED <<s, pub>>
IValidate == /\ inst.phase="built"
             /\ \E ok \in BOOLEAN: inst'=[inst EXCEPT !.phase=IF ok THEN "validated" ELSE "failed",
                                                      !.validated=ok]
             /\ UNCHANGED <<s, pub>>
IPublish == /\ inst.phase="validated" \/ (Fault="earlyPublish" /\ inst.phase="built")
            /\ pub < MaxPub /\ pub'=pub+1
            /\ inst'=[inst EXCEPT !.phase="published",
                                  !.badCompletion=(inst.badCompletion \/ ~inst.validated)]
            /\ UNCHANGED s
IRelease == /\ inst.phase \in {"published","failed"} /\ inst.lock
            /\ inst'=[inst EXCEPT !.lock=FALSE, !.consent=FALSE] /\ UNCHANGED <<s, pub>>

\* ---- the session's start ----
SUnchanged == UNCHANGED <<inst, pub>>
Join == /\ s.waiters=1 /\ s.phase # "done"
        /\ s'=[s EXCEPT !.waiters=2] /\ SUnchanged
ReadList == /\ s.phase="read"
            /\ s'=[s EXCEPT !.phase="select", !.listed=IF s.override THEN 1 ELSE pub] /\ SUnchanged
NotInstalled == /\ s.phase="select" /\ s.cand > s.listed /\ Fault # "unpublished"
                /\ s'=[s EXCEPT !.phase="done"] /\ SUnchanged
Spawn(i,p,k) ==
  /\ s.phase="select" /\ (s.cand <= s.listed \/ (Fault="unpublished" /\ s.cand <= pub))
  /\ s'=[s EXCEPT !.phase="launch", !.kind=k, !.active=TRUE, !.retired=FALSE,
                  !.importsOK=i, !.pinsOK=p, !.proof=0,
                  !.badRetire=(s.badRetire \/ ~s.retired),
                  !.badUnpublished=(s.badUnpublished \/ (~s.override /\ s.cand > s.listed))]
  /\ SUnchanged
HostLaunch ==
  /\ s.phase="launch"
  /\ LET configFailure == s.kind \in {"cwd","ambiguous"}
         wrong == configFailure /\ Fault=s.kind
     IN s'=[s EXCEPT !.phase=IF wrong \/ s.kind="executable" THEN "rejected"
                            ELSE IF configFailure THEN "startup-failed" ELSE "imports",
                    !.badClassification=(s.badClassification \/ wrong)]
  /\ SUnchanged
Imports ==
  /\ s.phase="imports"
  /\ LET fresh == ~(Fault="fresh" /\ s.cached)
         accept == (IF fresh THEN s.importsOK ELSE TRUE)
                   /\ (~s.managed \/ s.pinsOK \/ Fault="pins")
     IN s'=[s EXCEPT !.phase=IF accept THEN "metadata" ELSE "rejected",
                    !.proof=IF fresh /\ accept THEN s.generation ELSE 0,
                    !.cached=s.cached \/ accept,
                    !.badFresh=(s.badFresh \/ (accept /\ ~fresh)),
                    !.badPins=(s.badPins \/ (accept /\ s.managed /\ ~s.pinsOK))]
  /\ SUnchanged
Metadata ==
  /\ s.phase="metadata"
  /\ LET wrong == s.kind="metadata" /\ Fault="metadata"
     IN s'=[s EXCEPT !.phase=IF wrong THEN "rejected"
                            ELSE IF s.kind="metadata" THEN "startup-failed" ELSE "restore",
                    !.badClassification=(s.badClassification \/ wrong)]
  /\ SUnchanged
RestoreOK == /\ s.phase="restore" /\ s'=[s EXCEPT !.phase="final-ready"] /\ SUnchanged
RestoreFailure == /\ s.phase="restore"
                  /\ s'=[s EXCEPT !.phase=IF Fault="fallback" THEN "rejected" ELSE "startup-failed",
                                  !.badFallback=(s.badFallback \/ Fault="fallback")]
                  /\ SUnchanged
Expose == /\ (s.phase="final-ready" \/ (Fault="expose" /\ s.phase="restore"))
          /\ s'=[s EXCEPT !.ready=TRUE, !.phase="ready",
                          !.badExpose=(s.badExpose \/ s.phase#"final-ready")]
          /\ SUnchanged
Retire == /\ s.phase \in {"rejected","startup-failed","ready"}
          /\ s'=[s EXCEPT !.active=FALSE, !.retired=TRUE, !.ready=FALSE,
                          !.phase=CASE s.phase="rejected" -> "retry"
                                  [] s.phase="ready" -> "replace"
                                  [] OTHER -> "done"]
          /\ SUnchanged
Retry == /\ s.phase="retry"
         /\ s'=[s EXCEPT !.cand=s.cand+1, !.phase=IF s.override THEN "done" ELSE "select"]
         /\ SUnchanged
Replacement == /\ s.phase="replace" /\ s.generation=1
               /\ s'=[s EXCEPT !.generation=2, !.cand=1, !.phase="read", !.proof=0]
               /\ SUnchanged

Next == ILock \/ IConsent \/ IBuild \/ IValidate \/ IPublish \/ IRelease
        \/ Join \/ ReadList \/ NotInstalled
        \/ (\E i,p \in BOOLEAN, k \in {"none","cwd","ambiguous","executable","metadata"}: Spawn(i,p,k))
        \/ HostLaunch \/ Imports \/ Metadata \/ RestoreOK \/ RestoreFailure
        \/ Expose \/ Retire \/ Retry \/ Replacement
OnlyRuntimeRepair == ~s.badClassification
FreshProcess == ~s.badFresh
ManagedPins == ~s.badPins
NoRestoreFallback == ~s.badFallback
FinalReadyOnly == ~s.badExpose /\ (s.ready => s.phase="ready")
RetireBeforeSuccessor == ~s.badRetire
EnvironmentCompletion == ~inst.badCompletion
\* The lock is released only after the build was published or failed.
LockAndConsent == inst.phase \in {"built","validated"} => inst.lock /\ inst.consent
PublishedOnly == ~s.badUnpublished
CoalescedStart == s.waiters \in 1..2 /\ s.active \in BOOLEAN
Spec == Init /\ [][Next]_vars
=============================================================================
