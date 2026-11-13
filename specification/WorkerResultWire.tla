------------------------- MODULE WorkerResultWire -------------------------
\* Sources:
\*   src/core-worker.mjs sha256:1600668c3a25dfd8d336a7eccb59928b5cb80d1ab424c0b9b1746e9bf2cf4a2e
\*   src/supervisor.mjs sha256:8873880511b6679f9a6b6d0d3d3657c72b54e1512f7f853bbaf7f09b24b49eb9

\* The core worker forwards the core's events to the supervisor. Tool calls and results
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
