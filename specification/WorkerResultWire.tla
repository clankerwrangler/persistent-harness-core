------------------------- MODULE WorkerResultWire -------------------------
\* Sources:
\*   src/core-worker.mjs sha256:6a68d2aa971379810b37268a216ff90ee0d023e4f805432aa3c5e1da788a1925
\*   src/supervisor.mjs sha256:834043fd3695b19d1be8dca80a1b0d944d9446874073b48452c29cc7430e53cd
\*   src/live-view.mjs sha256:fa7a8846c1a485bd3f38084cd8ffe77f2c24b5066738f9ae21925d7cedd7dbf8

\* The session's live view (live-view.mjs) passes the core's events on to the supervisor. Tool calls and results
\* lose their bodies on the way: the supervisor needs only which call started or ended.
\* The worker's own handlers see each event whole, and the core saves the tool result
\* whole, whatever is forwarded. Fault "leak" forwards bodies; "mutateCanonical" saves
\* the forwarded copy.
EXTENDS Naturals, Sequences
CONSTANT Fault
VARIABLES step, canonical, hooks, wire, visible, expected
vars == <<step, canonical, hooks, wire, visible, expected>>
Kinds == <<"turnStart", "textDelta", "toolCall", "toolResult", "messageEnd", "turnEnd", "settled">>
Payload(k) == IF k \in {"toolCall", "toolResult"} THEN "full" ELSE "none"
Raw(k) == [kind |-> k, body |-> Payload(k), identity |-> "original", text |-> "original", usage |-> "original"]
Transport(e) == IF Fault = "leak" THEN e ELSE [e EXCEPT !.body = "none"]
\* What the supervisor uses of an event: never a tool body.
Project(e) == [kind |-> e.kind, identity |-> e.identity, text |-> e.text, usage |-> e.usage]
Init == /\ step = 1 /\ canonical = "absent" /\ hooks = <<>>
        /\ wire = <<>> /\ visible = <<>> /\ expected = <<>>
Send == /\ step <= Len(Kinds)
        /\ LET k == Kinds[step]
               raw == Raw(k)
               frame == Transport(raw)
           IN /\ wire' = Append(wire, frame)
              /\ hooks' = Append(hooks, raw)
              /\ visible' = Append(visible, Project(frame))
              /\ expected' = Append(expected, Project(raw))
              /\ canonical' = IF k = "toolResult" THEN
                                (IF Fault = "mutateCanonical" THEN frame.body ELSE raw.body)
                              ELSE canonical
        /\ step' = step + 1
CanonicalPreserved == step > 4 => canonical = "full"
ObserversPreserved == \A i \in 1..Len(hooks): hooks[i] = Raw(hooks[i].kind)
SupervisorEquivalent == visible = expected
NoForwardedBodies == \A i \in 1..Len(wire): wire[i].body = "none"
Spec == Init /\ [][Send]_vars
=============================================================================
