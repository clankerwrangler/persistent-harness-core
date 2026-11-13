-------------------- MODULE ChildTurnFailure --------------------
\* Sources:
\*   src/core-worker.mjs sha256:9d4cc1e0957a339276306c7aaffe806593ca2315ad0bb65c7b57731160433bfe
\*   src/child-turn-failure.mjs sha256:3e70906dd488214003d4693ea887b959357b5fb2b7ee18074e6b90f5fc381fc9
\*   src/store.mjs sha256:d98357b843f4e0e5317f3bb219dd4692078eb55ecb29f02a27a974c21e844bcf

\* A session's failed turn is saved in its history first (the journal), then reported
\* to the supervisor until a receipt comes back; an ordered witness records how far
\* receipts reach. The boundary says how far the turn got: a failed request
\* preparation is before dispatch; a failure after the provider produced a tool call
\* (admitted or run) may have had effects; otherwise dispatch is unknown.
EXTENDS Naturals, FiniteSets
CONSTANT DurableJournal, AccountAdmitted
Turns == 1..2
VARIABLES turn, phase, provider, tools, journal, receipts, inFlight, effects, admitted, acceptedThrough
vars == <<turn, phase, provider, tools, journal, receipts, inFlight, effects, admitted, acceptedThrough>>
Init == /\ turn = 1 /\ phase = "prepare" /\ provider = FALSE /\ tools = FALSE
        /\ journal = [t \in Turns |-> "none"] /\ receipts = {} /\ inFlight = FALSE
        /\ effects = {} /\ admitted = FALSE /\ acceptedThrough = 0
Dispatch == /\ phase = "prepare" /\ phase' = "inference" /\ provider' = TRUE
            /\ UNCHANGED <<turn,tools,journal,receipts,inFlight,effects,admitted,acceptedThrough>>
Admit == /\ phase = "inference" /\ ~tools /\ ~admitted /\ admitted' = TRUE
         /\ UNCHANGED <<turn,phase,provider,tools,journal,receipts,inFlight,effects,acceptedThrough>>
Tool == /\ phase \in {"inference", "failed", "settled"} /\ admitted /\ ~tools /\ tools' = TRUE /\ admitted' = FALSE
        /\ effects' = effects \cup {turn}
        /\ UNCHANGED <<turn,phase,provider,journal,receipts,inFlight,acceptedThrough>>
Boundary == IF tools \/ (AccountAdmitted /\ admitted) THEN "tool_effects_possible" ELSE IF provider THEN "provider_dispatch_unknown" ELSE "before_provider_dispatch"
Fail == /\ phase \in {"prepare", "inference"} /\ phase' = "failed"
        /\ journal' = IF DurableJournal /\ journal[turn] = "none" THEN [journal EXCEPT ![turn] = Boundary] ELSE journal
        /\ UNCHANGED <<turn,provider,tools,receipts,inFlight,effects,admitted,acceptedThrough>>
SettleFailure == /\ phase = "failed" /\ phase' = "settled"
                 /\ UNCHANGED <<turn,provider,tools,journal,receipts,inFlight,effects,admitted,acceptedThrough>>
SuccessOrCancel == /\ phase \in {"prepare", "inference"} /\ phase' = "settled"
                   /\ UNCHANGED <<turn,provider,tools,journal,receipts,inFlight,effects,admitted,acceptedThrough>>
NewInput == /\ phase = "settled" /\ ~admitted /\ turn < 2
            /\ turn' = turn + 1 /\ phase' = "prepare" /\ provider' = FALSE /\ tools' = FALSE
            /\ UNCHANGED <<journal,receipts,inFlight,effects,admitted,acceptedThrough>>
Send == /\ ~inFlight /\ \E t \in Turns: journal[t] # "none" /\ t > acceptedThrough
        /\ inFlight' = TRUE /\ UNCHANGED <<turn,phase,provider,tools,journal,receipts,effects,admitted,acceptedThrough>>
Accept(t) == /\ inFlight /\ journal[t] # "none" /\ t > acceptedThrough /\ receipts' = receipts \cup {t}
             /\ inFlight' = FALSE /\ UNCHANGED <<turn,phase,provider,tools,journal,effects,admitted,acceptedThrough>>
Witness(t) == /\ t \in receipts /\ t > acceptedThrough
              /\ \A prior \in 1..t: journal[prior] # "none" => prior \in receipts
              /\ acceptedThrough' = t
              /\ UNCHANGED <<turn,phase,provider,tools,journal,receipts,inFlight,effects,admitted>>
RestartOrReject == /\ inFlight' = FALSE
                   /\ UNCHANGED <<turn,phase,provider,tools,journal,receipts,effects,admitted,acceptedThrough>>
Next == Dispatch \/ Admit \/ Tool \/ Fail \/ SuccessOrCancel \/ SettleFailure \/ NewInput \/ Send \/ RestartOrReject
        \/ (\E t \in Turns: Accept(t) \/ Witness(t))
Spec == Init /\ [][Next]_vars
Safety == /\ (phase = "failed" => journal[turn] # "none")
          /\ (\A t \in 1..acceptedThrough: journal[t] # "none" => t \in receipts)
          /\ receipts \subseteq {t \in Turns: journal[t] # "none"}
          /\ (phase = "failed" => journal[turn] = Boundary)
          /\ (\A t \in Turns: journal[t] = "before_provider_dispatch" => t \notin effects)
NoticeOnly == [][(inFlight # inFlight' \/ receipts # receipts') => UNCHANGED <<turn,phase,provider,tools,effects>>]_vars
=================================================================
