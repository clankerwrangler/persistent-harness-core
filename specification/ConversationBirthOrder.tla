----------------------- MODULE ConversationBirthOrder -----------------------
\* Sources:
\*   src/conversation-projection.mjs sha256:9cff939b4541fb403dd7af8947017d7c013c24e444c1a04c11b40ab9af86e503
\*   src/progress-projection.mjs sha256:221c8cbc55664dc7596e4f9c1538c00e2ce3b7a804a289466f89676854767d43
\*   src/supervisor.mjs sha256:8873880511b6679f9a6b6d0d3d3657c72b54e1512f7f853bbaf7f09b24b49eb9

\* Reply text and progress headings are shown in the order they began, live and after a
\* reload. A reply's request starts first; reasoning shown meanwhile is recorded as
\* headings; each text's first words come later. The core saves a heading with when it
\* was recorded and a text with when its first words arrived (startedAt); the live view
\* times a text row when those words reach the supervisor, before any later row begins.
\* Times only move forward; rows begun in the same millisecond keep history order, which
\* is the order they began. RequestStart = TRUE is the broken control that shows saved
\* text at its request's start.
EXTENDS Integers, Sequences
CONSTANT RequestStart
\* One turn: a heading, the first reply's text, a heading, the second reply's text.
Source == <<"P", "A", "Q", "B">>
Text == {"A", "B"}
Reply(r) == IF r = "A" THEN 1 ELSE 2
Index(r) == CHOOSE i \in 1..Len(Source): Source[i] = r
VARIABLES next, clock, requested, born, live, saved
vars == <<next, clock, requested, born, live, saved>>
Rows == {Source[i]: i \in 1..Len(Source)}
Init == /\ next = 1 /\ clock = 0 /\ requested = <<0, 0>>
        /\ born = [r \in Rows |-> 0] /\ live = {} /\ saved = [r \in Rows |-> -1]
Tick == /\ clock < 4 /\ clock' = clock + 1 /\ UNCHANGED <<next, requested, born, live, saved>>
\* The second reply's request starts after the first reply's text.
Request(n) == /\ requested[n] = 0 /\ (n = 1 \/ born["A"] > 0)
              /\ requested' = [requested EXCEPT ![n] = clock + 1]
              /\ UNCHANGED <<next, clock, born, live, saved>>
\* A row begins: a heading is recorded, or a text's first words arrive.
Begin == /\ next <= Len(Source)
         /\ LET r == Source[next] IN
              /\ (r \in Text => requested[Reply(r)] > 0)
              /\ born' = [born EXCEPT ![r] = clock + 1]
              /\ live' = live \cup {r}
         /\ next' = next + 1
         /\ UNCHANGED <<clock, requested, saved>>
Save(r) == /\ r \in live /\ saved[r] = -1
           /\ saved' = [saved EXCEPT ![r] = IF r \in Text /\ RequestStart THEN requested[Reply(r)] ELSE born[r]]
           /\ UNCHANGED <<next, clock, requested, born, live>>
Next == Tick \/ Begin \/ (\E n \in {1, 2}: Request(n)) \/ (\E r \in Rows: Save(r))
Spec == Init /\ [][Next]_vars
\* Sorted by time, ties in history order (the order rows began): a row that began
\* earlier is never shown after one that began later.
Ordered(time, shown) == \A a, b \in shown: Index(a) < Index(b) => time[a] <= time[b]
LiveChronology == Ordered(born, live)
SavedChronology == Ordered(saved, {r \in Rows: saved[r] # -1})
\* A saved row takes its live row's place.
ReloadKeepsPlace == \A r \in Rows: saved[r] # -1 => saved[r] = born[r]
=============================================================================
