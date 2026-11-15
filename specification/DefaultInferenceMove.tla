---------------------- MODULE DefaultInferenceMove ----------------------
\* Sources:
\*   src/default-inference.mjs sha256:de8c3c48ca29dffcd99a2a8c72bc9eb6582a1d4cde55e3551f7ac74978f4cc47
\*   src/store.mjs sha256:a6ecb3526e086a1a4cb6dfab97009a3070f63c5d6ae0f038f2a2424ed6e3d225
\*   src/supervisor.mjs sha256:834043fd3695b19d1be8dca80a1b0d944d9446874073b48452c29cc7430e53cd
EXTENDS Naturals
CONSTANTS Sessions, Pinned, Old, New, SettingsFirst

\* A move commits the sessions, then names the new default. A crash can fall
\* between the two. Repeating the request looks for sessions on the current
\* default, so that default must not change until every session has moved.
VARIABLES model, default, step, crashes
vars == <<model, default, step, crashes>>
Following == Sessions \ Pinned
Moved == [s \in Sessions |-> IF s \in Following THEN New ELSE model[s]]
Init == /\ model = [s \in Sessions |-> Old] /\ default = Old
        /\ step = "idle" /\ crashes = 0
Request == /\ step = "idle" /\ default = Old
           /\ step' = "running" /\ UNCHANGED <<model, default, crashes>>
MoveSessions == /\ ~SettingsFirst /\ step = "running"
                /\ model' = Moved /\ step' = "settings" /\ UNCHANGED <<default, crashes>>
WriteSettings == /\ ~SettingsFirst /\ step = "settings"
                 /\ default' = New /\ step' = "idle" /\ UNCHANGED <<model, crashes>>
EarlySettings == /\ SettingsFirst /\ step = "running"
                 /\ default' = New /\ step' = "settings" /\ UNCHANGED <<model, crashes>>
LateSessions == /\ SettingsFirst /\ step = "settings"
                /\ model' = Moved /\ step' = "idle" /\ UNCHANGED <<default, crashes>>
Crash == /\ step # "idle" /\ crashes = 0
         /\ step' = "idle" /\ crashes' = 1 /\ UNCHANGED <<model, default>>
Next == Request \/ MoveSessions \/ WriteSettings \/ EarlySettings \/ LateSessions \/ Crash
Spec == Init /\ [][Next]_vars

PinnedStay == \A s \in Pinned : model[s] = Old
NoStranded == (step = "idle" /\ default = New) => \A s \in Following : model[s] = New
=============================================================================
