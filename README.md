# Persistent Harness

Persistent Harness runs durable, detachable sessions on the conversation core, with persistent Python execution. A local supervisor owns session workers, input queues, retained child agents, and kernel recovery. Closing a terminal detaches the client; it does not stop the session.

This repository contains the harness and ten capability skills. The conversation core (the program that keeps each session's history and talks to the model providers) is a separate project.

## Install

Requirements:

- Linux with `/proc`, Node.js 24 or newer, Bash, Perl, and standard Unix utilities.
- The conversation core: its `core` binary and its JavaScript library `js/core.mjs`. See [Dependencies](docs/DEPENDENCIES.md#conversation-core).
- CPython 3.12.12, IPython 9.10.0, and dill 0.3.8, either provisioned by the harness or supplied explicitly.

Follow [Dependencies and installation](docs/DEPENDENCIES.md) to point the harness at the core and configure the Python runtime. Then, from this checkout:

```sh
npm ci --ignore-scripts --no-audit --no-fund
node bin/provision-skills.mjs --yes
node bin/persistent-pi.mjs --create
```

The provisioning command approves downloads of pinned uv, Python, IPython, and dill. Set `PI_HARNESS_PYTHON` to a compatible existing interpreter instead if provisioning is not wanted. The nine Python-backed skills declare no additional Python packages; `inbox` is guidance-only.

Provider sign-ins belong to the core: sign in with `core login PROVIDER`, and the core stores and renews the credentials itself. The harness never reads them.

## Use

```sh
node bin/persistent-pi.mjs --list
node bin/persistent-pi.mjs --session SESSION --prompt "Continue the task" --wait
```

The terminal supports `:sessions`, `:attach NAME_OR_ID`, `:new [NAME]`, `:abort`, and `:quit`. In Python, inspect `rlm?`, `agent_message?`, `cron?`, or another bundled capability. The default catalog is this repository's `skills/`; `PI_HARNESS_SKILLS_PATH` selects another complete catalog.

The harness retains child delegation and context forking, durable family messages, scheduled jobs, detached processes, session-history search, model selection, image inputs, checkpoint diagnostics, and client-neutral protocol APIs. A session's history only grows: there is no compaction and no rewind; the model rewrites its own context when it needs room. [Native asynchronous execution](docs/ASYNC_EXECUTION.md) requires explicit provider/model support; ordinary synchronous tool execution remains available without it.

- [Operations and recovery](docs/OPERATIONS.md)
- [Architecture and protocol](docs/ARCHITECTURE.md)
- [Durable attention and notifications](docs/NOTIFICATIONS.md)
- [Validation](docs/VALIDATION.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

Licensed under the [MIT License](LICENSE). Third-party notices apply to their identified materials.
