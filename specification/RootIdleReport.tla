--------------------- MODULE RootIdleReport ---------------------
\* Sources:
\*   src/store.mjs
\*   src/supervisor.mjs
\*   src/core-worker.mjs
\*   src/worker-rpc.mjs

\* Home hears once a root's family (the root and its children) has gone quiet.
\* A message is stored, sent to the member's worker, handed to its core and taken
\* (admitted) there. The core keeps the member busy from the hand-off until a settle
\* that covers it. Two channels reach the supervisor: the session channel carries,
\* in order, "taken", "start" and "end";
\* the request socket carries the acknowledgement, stamped with the number of frames
\* published before it. The model checks that
\*   - no report goes out while a member's core has work or a message is on its way
\*     to a core (no early report), and
\*   - once everything has settled, the family's last work has been reported.
\*
\* An end clears the member even when the worker has written newer ops: those are not
\* yet taken, so their messages still count as waiting, and their own "taken" makes the
\* member busy again.
\*
\* Rule: "gotit" is the implementation. Controls: "ackends" (work ends at the ack, as
\* in the old rule), "nodefer" (acks
\* applied as they arrive), "nocover" (taken work stays pending until its ack, so a late
\* ack leaves a settled family unreported).

EXTENDS Naturals, Sequences
CONSTANTS Rule, MaxMessages

Members == {"root", "child"}

VARIABLES
  stored, atWorker, handed, open, running,  \* truth, per member
  frames, published, seen, acks,            \* the two channels
  streaming, untaken, taken, covered,       \* what the supervisor knows
  sent, owed, falseReport

vars == <<stored, atWorker, handed, open, running, frames, published, seen, acks,
          streaming, untaken, taken, covered, sent, owed, falseReport>>

Zero == [m \in Members |-> 0]
Init ==
  /\ stored = Zero /\ atWorker = Zero /\ handed = Zero /\ open = Zero
  /\ running = [m \in Members |-> FALSE]
  /\ frames = [m \in Members |-> <<>>] /\ published = Zero /\ seen = Zero
  /\ acks = [m \in Members |-> <<>>]
  /\ streaming = [m \in Members |-> FALSE]
  /\ untaken = Zero /\ taken = Zero /\ covered = Zero
  /\ sent = 0 /\ owed = FALSE /\ falseReport = FALSE

Busy(n) == stored[n] + atWorker[n] + handed[n] + open[n] > 0 \/ running[n]

Report ==
  /\ owed' = FALSE
  /\ falseReport' = (falseReport \/ \E n \in Members : Busy(n))
NoReport == UNCHANGED <<owed, falseReport>>

Publish(m, f) ==
  /\ frames' = [frames EXCEPT ![m] = Append(@, f)]
  /\ published' = [published EXCEPT ![m] = @ + 1]

\* An external sender writes to the root; a member in a turn may write to either.
Store(t) ==
  /\ sent < MaxMessages /\ (t = "root" \/ running["root"] \/ running["child"])
  /\ sent' = sent + 1
  /\ stored' = [stored EXCEPT ![t] = @ + 1]
  /\ untaken' = [untaken EXCEPT ![t] = @ + 1]
  /\ UNCHANGED <<atWorker, handed, open, running, frames, published, seen, acks, streaming, taken, covered, owed, falseReport>>

Deliver(m) ==
  /\ stored[m] > 0
  /\ stored' = [stored EXCEPT ![m] = @ - 1] /\ atWorker' = [atWorker EXCEPT ![m] = @ + 1]
  /\ UNCHANGED <<handed, open, running, frames, published, seen, acks, streaming, untaken, taken, covered, sent, owed, falseReport>>

\* The worker writes the op; from here core.busy is true until a settle covers it.
Hand(m) ==
  /\ atWorker[m] > 0
  /\ atWorker' = [atWorker EXCEPT ![m] = @ - 1] /\ handed' = [handed EXCEPT ![m] = @ + 1]
  /\ UNCHANGED <<stored, open, running, frames, published, seen, acks, streaming, untaken, taken, covered, sent, owed, falseReport>>

\* The core admits it ("added"): the worker publishes "taken" at once, then sends the ack.
Admit(m) ==
  /\ handed[m] > 0
  /\ handed' = [handed EXCEPT ![m] = @ - 1] /\ open' = [open EXCEPT ![m] = @ + 1]
  /\ Publish(m, [k |-> "taken"])
  /\ acks' = [acks EXCEPT ![m] = Append(@, published[m] + 1)]
  /\ UNCHANGED <<stored, atWorker, running, seen, streaming, untaken, taken, covered, sent, owed, falseReport>>

\* An idle core starts a turn for what it admitted ("turn_start" comes after "added").
Start(m) ==
  /\ ~running[m] /\ open[m] > 0
  /\ running' = [running EXCEPT ![m] = TRUE]
  /\ Publish(m, [k |-> "start"])
  /\ UNCHANGED <<stored, atWorker, handed, open, acks, seen, streaming, untaken, taken, covered, sent, owed, falseReport>>

\* The turn settles, covering everything admitted. Ops written but not yet admitted wait.
Finish(m) ==
  /\ running[m]
  /\ running' = [running EXCEPT ![m] = FALSE] /\ open' = [open EXCEPT ![m] = 0]
  /\ Publish(m, [k |-> "end"])
  /\ UNCHANGED <<stored, atWorker, handed, acks, seen, streaming, untaken, taken, covered, sent, owed, falseReport>>

FamilyQuiet(st, ta) == \A n \in Members : ~st[n] /\ untaken[n] + ta[n] = 0

SeeFrame(m) ==
  /\ seen[m] < published[m]
  /\ LET f == frames[m][seen[m] + 1] IN
     /\ seen' = [seen EXCEPT ![m] = @ + 1]
     /\ CASE f.k = "taken" /\ Rule /= "ackends" ->
               /\ untaken' = [untaken EXCEPT ![m] = @ - 1] /\ taken' = [taken EXCEPT ![m] = @ + 1]
               /\ streaming' = [streaming EXCEPT ![m] = TRUE] /\ owed' = TRUE
               /\ UNCHANGED <<covered, falseReport>>
          [] f.k = "taken" -> UNCHANGED <<untaken, taken, streaming, covered, owed, falseReport>>
          [] f.k = "start" ->
               /\ streaming' = [streaming EXCEPT ![m] = TRUE] /\ owed' = TRUE
               /\ UNCHANGED <<untaken, taken, covered, falseReport>>
          [] OTHER ->
               LET st == [streaming EXCEPT ![m] = FALSE]
                   ta == IF Rule = "nocover" THEN taken ELSE [taken EXCEPT ![m] = 0]
               IN /\ streaming' = st /\ taken' = ta
                  /\ covered' = IF Rule = "nocover" THEN covered ELSE [covered EXCEPT ![m] = @ + taken[m]]
                  /\ untaken' = untaken
                  /\ IF FamilyQuiet(st, ta) THEN Report ELSE NoReport
  /\ UNCHANGED <<stored, atWorker, handed, open, running, frames, published, acks, sent>>

\* Applied once the supervisor has seen the frames published before it (unless "nodefer").
\* It changes delivery bookkeeping only; it never ends work or reports.
SeeAck(m) ==
  /\ acks[m] /= <<>>
  /\ Rule = "nodefer" \/ Rule = "ackends" \/ seen[m] >= Head(acks[m])
  /\ acks' = [acks EXCEPT ![m] = Tail(@)]
  /\ IF Rule = "ackends" \/ (taken[m] = 0 /\ covered[m] = 0)
       THEN /\ untaken' = [untaken EXCEPT ![m] = @ - 1] /\ UNCHANGED <<taken, covered>>
     ELSE IF taken[m] > 0
       THEN /\ taken' = [taken EXCEPT ![m] = @ - 1] /\ UNCHANGED <<untaken, covered>>
       ELSE /\ covered' = [covered EXCEPT ![m] = @ - 1] /\ UNCHANGED <<untaken, taken>>
  /\ UNCHANGED <<stored, atWorker, handed, open, running, frames, published, seen, streaming, sent, owed, falseReport>>

Next == \E m \in Members :
  Store(m) \/ Deliver(m) \/ Hand(m) \/ Admit(m) \/ Start(m) \/ Finish(m) \/ SeeFrame(m) \/ SeeAck(m)

Spec == Init /\ [][Next]_vars

Settled == \A m \in Members :
  ~Busy(m) /\ seen[m] = published[m] /\ acks[m] = <<>>

NoFalseReport == ~falseReport
ReportedWhenSettled == Settled => ~owed
Safety == NoFalseReport /\ ReportedWhenSettled
=============================================================================
