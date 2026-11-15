------------------------- MODULE ActorCompileCache -------------------------
\* Sources:
\*   src/actor-compile-cache.mjs
\*   src/supervisor.mjs
\*   bin/core-actor.mjs
\*   src/session-process.mjs
\*   src/session-records.mjs

EXTENDS Naturals, FiniteSets
\* One disposable code cache per supervisor, used by each session process it starts and by
\* its one-off records reader. Node checks a cached entry against the source it compiles
\* (CheckSource). On stop the supervisor refuses new reads, ends the reader that is running
\* and waits until it can no longer write, then removes the cache once no session process
\* writes to it either. A reader whose spawn failed never exits; it has ended once its spawn
\* error came (FailedSpawnEnds), or stopping waits for it forever.
CONSTANTS Actors, MaxGeneration, WaitForWriters, CheckSource, FailedSpawnEnds
VARIABLES daemon, cache, setupCount, mode, phase, generation, source, compiled,
          loaded, selected, runtimeIdentity, usesCache, removedWithWriters, reader, refusing
vars == <<daemon, cache, setupCount, mode, phase, generation, source, compiled,
          loaded, selected, runtimeIdentity, usesCache, removedWithWriters, reader, refusing>>
actorVars == <<cache, setupCount, mode, phase, generation, source, compiled,
               loaded, selected, runtimeIdentity, usesCache>>
Inactive(a) == phase[a] \in {"idle", "exited"}
Writers == {a \in Actors: ~Inactive(a)}
\* A reader being spawned or running may load code through the cache.
ReaderWrites == reader \in {"spawning", "running"}
ReaderEnded == reader \in {"none", "ended"}
Init == /\ daemon = "running" /\ cache = "absent" /\ setupCount = 0
        /\ mode \in {"default", "disabled", "external"}
        /\ phase = [a \in Actors |-> "idle"] /\ generation = [a \in Actors |-> 0]
        /\ source = 1 /\ compiled = {} /\ loaded = [a \in Actors |-> 0]
        /\ selected = [a \in Actors |-> 0]
        /\ runtimeIdentity = [a \in Actors |-> <<a, 0>>]
        /\ usesCache = [a \in Actors |-> FALSE] /\ removedWithWriters = FALSE
        /\ reader = "none" /\ refusing = FALSE
Launch(a) == /\ daemon = "running" /\ Inactive(a) /\ generation[a] < MaxGeneration
             /\ generation' = [generation EXCEPT ![a] = @ + 1]
             /\ phase' = [phase EXCEPT ![a] = "waiting"]
             /\ usesCache' = [usesCache EXCEPT ![a] = FALSE]
             /\ cache' = IF cache = "absent" THEN (IF mode = "default" THEN "creating" ELSE "off") ELSE cache
             /\ setupCount' = IF cache = "absent" /\ mode = "default" THEN setupCount + 1 ELSE setupCount
             /\ UNCHANGED <<daemon, mode, source, compiled, loaded, selected, runtimeIdentity, removedWithWriters, reader, refusing>>
Setup == /\ cache = "creating" /\ cache' \in {"private", "unavailable"}
         /\ UNCHANGED <<daemon, setupCount, mode, phase, generation, source, compiled,
                        loaded, selected, runtimeIdentity, usesCache, removedWithWriters, reader, refusing>>
Load(a) == /\ phase[a] = "waiting" /\ cache \in {"private", "unavailable", "off", "replaced"}
           /\ phase' = [phase EXCEPT ![a] = "loaded"]
           /\ selected' = [selected EXCEPT ![a] = source]
           /\ loaded' = [loaded EXCEPT ![a] = IF ~CheckSource /\ compiled # {} THEN 1 ELSE source]
           /\ runtimeIdentity' = [runtimeIdentity EXCEPT ![a] = <<a, generation[a]>>]
           /\ usesCache' = [usesCache EXCEPT ![a] = cache = "private"]
           /\ UNCHANGED <<daemon, cache, setupCount, mode, generation, source, compiled, removedWithWriters, reader, refusing>>
Ready(a) == /\ daemon = "running" /\ phase[a] = "loaded"
            /\ phase' = [phase EXCEPT ![a] = "ready"]
            /\ UNCHANGED <<daemon, cache, setupCount, mode, generation, source, compiled,
                           loaded, selected, runtimeIdentity, usesCache, removedWithWriters, reader, refusing>>
Exit(a) == /\ phase[a] \in {"loaded", "ready"}
           /\ phase' = [phase EXCEPT ![a] = "exited"]
           /\ compiled' = IF usesCache[a] /\ cache = "private" THEN compiled \cup {loaded[a]} ELSE compiled
           /\ UNCHANGED <<daemon, cache, setupCount, mode, generation, source,
                          loaded, selected, runtimeIdentity, usesCache, removedWithWriters, reader, refusing>>
ChangeSource == /\ source = 1 /\ source' = 2
                /\ UNCHANGED <<daemon, cache, setupCount, mode, phase, generation, compiled,
                               loaded, selected, runtimeIdentity, usesCache, removedWithWriters, reader, refusing>>
ReplaceDirectory == /\ cache = "private" /\ cache' = "replaced"
                    /\ UNCHANGED <<daemon, setupCount, mode, phase, generation, source, compiled,
                                   loaded, selected, runtimeIdentity, usesCache, removedWithWriters, reader, refusing>>
\* ---- the records reader (one at a time is enough to show the ordering) ----
ReaderSpawn == /\ ~refusing /\ ReaderEnded /\ reader' = "spawning"
               /\ UNCHANGED <<daemon, actorVars, removedWithWriters, refusing>>
ReaderStarted == /\ reader = "spawning" /\ reader' = "running"
                 /\ UNCHANGED <<daemon, actorVars, removedWithWriters, refusing>>
ReaderSpawnFailed == /\ reader = "spawning" /\ reader' = "failed"
                     /\ UNCHANGED <<daemon, actorVars, removedWithWriters, refusing>>
ReaderFailureSeen == /\ reader = "failed" /\ FailedSpawnEnds /\ reader' = "ended"
                     /\ UNCHANGED <<daemon, actorVars, removedWithWriters, refusing>>
\* Its own exit, or the kill that stopping sends.
ReaderExit == /\ reader = "running" /\ reader' = "ended"
              /\ UNCHANGED <<daemon, actorVars, removedWithWriters, refusing>>
\* ---- stopping ----
Stop == /\ daemon = "running" /\ daemon' = "stopping" /\ refusing' = TRUE
        /\ UNCHANGED <<actorVars, removedWithWriters, reader>>
Dispose == /\ daemon = "stopping" /\ cache # "creating" /\ ReaderEnded
           /\ (~WaitForWriters \/ Writers = {})
           /\ daemon' = "stopped"
           /\ cache' = IF cache = "private" THEN "removed" ELSE cache
           /\ removedWithWriters' = (cache = "private" /\ (Writers # {} \/ ReaderWrites))
           /\ UNCHANGED <<setupCount, mode, phase, generation, source, compiled,
                          loaded, selected, runtimeIdentity, usesCache, reader, refusing>>
Next == Setup \/ ChangeSource \/ ReplaceDirectory \/ Stop \/ Dispose
        \/ ReaderSpawn \/ ReaderStarted \/ ReaderSpawnFailed \/ ReaderFailureSeen \/ ReaderExit
        \/ (\E a \in Actors: Launch(a) \/ Load(a) \/ Ready(a) \/ Exit(a))
\* Stopping stops the session processes and the reader; Node finishes what it started.
Fairness == /\ WF_vars(Setup) /\ WF_vars(Dispose) /\ WF_vars(ReaderStarted \/ ReaderSpawnFailed)
            /\ WF_vars(ReaderFailureSeen) /\ WF_vars(ReaderExit)
            /\ \A a \in Actors: WF_vars(Load(a)) /\ WF_vars(Exit(a))
OneCacheOwner == setupCount <= 1 /\ (mode # "default" => setupCount = 0)
CacheOutlivesWriters == ~removedWithWriters
FreshRuntime == \A a \in Actors: phase[a] \in {"loaded", "ready"} => runtimeIdentity[a] = <<a, generation[a]>>
CurrentSource == \A a \in Actors: phase[a] \in {"loaded", "ready"} => loaded[a] = selected[a]
FallbackCanLoad == \A a \in Actors: phase[a] = "waiting" /\ cache \in {"unavailable", "off", "replaced"} => ENABLED Load(a)
StopFinishes == daemon = "stopping" ~> daemon = "stopped"
Spec == Init /\ [][Next]_vars
LiveSpec == Spec /\ Fairness
=============================================================================
