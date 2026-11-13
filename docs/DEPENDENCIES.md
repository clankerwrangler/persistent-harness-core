# Dependencies and installation

## Conversation core

Each session runs on the conversation core, a separate program. The core keeps the
session's history in its own folder, builds each model request, talks to the providers,
holds the provider sign-ins, and runs its built-in file tools. The harness starts one core
per running session (through the worker, `bin/core-actor.mjs`) and reads histories only
by asking the core, never by opening its files.

The core's files for these sessions live together in the agent folder
(`PI_CODING_AGENT_DIR`, default `~/.pi/agent`), under `core/`:

- `core/bin/core` and `core/js/core.mjs`: the installed core.
- `core/auth.json`: the provider sign-ins.
- `core/catalog/`: the providers' model lists, cached.
- `core/models.json`: optional extra facts about models.
- `core/sessions/`: one folder per session.

Every core the harness starts gets `--agent-dir` set to the agent folder, so the global
`AGENTS.md` and depth instructions there apply. It also gets `--auth`, `--catalog` and
(when the file exists) `--models` from `core/`. The WebUI uses the same `--auth` file when
it asks the core for remaining usage or runs a sign-in.

Optional settings, mainly for tests:

- `PI_HARNESS_CORE_HOME`: another folder in place of `<agent folder>/core`.
- `PI_HARNESS_CORE_BIN`, `PI_HARNESS_CORE_JS`: another core binary or `js/core.mjs`.
- `PI_HARNESS_CORE_ARGS`: a JSON array of flags passed to every core, after the defaults.
  A flag given here, such as `--auth`, replaces its default.
- `PI_HARNESS_CORE_SESSIONS`: another folder for session folders.

Provider sign-ins are the core's: `core login PROVIDER --auth <agent folder>/core/auth.json`
signs in, and the core stores and renews the credentials. Nothing in the harness reads the
credentials file.

## Python and skills

`node bin/provision-skills.mjs --yes` provisions checksum-pinned uv 0.12.3, CPython 3.12.12, IPython 9.10.0, and dill 0.3.8 on Linux x64. Managed environments are selected by dependencies and skill manifests. A compatible completed environment can be reused after a source-only skill change; dependency changes require provisioning.

Kernel launch validates imports and all three versions in the process that runs
cells, before snapshot recovery or deserialization. Each replacement validates
again. Managed launches require the exact pins; an explicit interpreter reports
its observed versions without pinning them. Standalone provisioning and
changed-catalog admission retain their disposable import checks. A catalog
fingerprint or an earlier provision result does not validate a new process.

An import, version, or executable rejection can select another compatible
completed environment or enter the approved provisioning path. Configuration,
control, and restore failures do not trigger runtime repair. A newly built
runtime publishes its completion record after import/version validation, even
if later namespace restoration fails.

For an existing interpreter:

```sh
export PI_HARNESS_PYTHON=/absolute/path/to/python
node bin/provision-skills.mjs
```

The bundled catalog provides `agent-message`, `background`, `cron`, `files`, `inbox`,
`kernel`, `operations`, `rlm`, `session-history`, and `shell`. The nine Python-backed
skills declare empty dependency lists in their `pyproject.toml` files; `inbox` is
guidance-only. No host inventory, SSH wrappers, mail, vault, persona, or standing policy
is installed. Use `PI_HARNESS_SKILLS_PATH` for a different complete catalog and provision
its declared dependencies before admitting work.

## Persistent configuration

Use the same environment for the supervisor and its workers: the core settings above,
and optionally `PI_HARNESS_PYTHON` and `PI_HARNESS_SKILLS_PATH`. Harness state (kernel
runtimes, background jobs) lives under `PI_CODING_AGENT_DIR`, default `~/.pi/agent`. Keep
credentials out of source, examples, and committed environment files. Node, the core and
the Python runtime must remain accessible after restarting your terminal or service.

### Node compile cache

Workers use a supervisor-owned temporary Node compile cache by default; its
[lifetime and fallback](ARCHITECTURE.md#owners) do not change session ownership.
`NODE_DISABLE_COMPILE_CACHE=1` disables it. Use that setting when collecting precise
V8 coverage: Node warns that cached functions can produce less precise coverage.
An explicitly configured `NODE_COMPILE_CACHE` (including an empty value) takes
precedence over the harness default. Node handles that setting normally; the
harness neither repairs nor removes an operator-managed cache. The harness does
not set `NODE_COMPILE_CACHE` for the supervisor or tool subprocesses.

## Clients

A browser or HTTP frontend is a separate client process. Configure its entry point in your service setup and connect it through `HarnessClient` and the selected supervisor socket. Shared protocol and projection modules come from the same published harness checkout; the harness does not import or launch the frontend.
