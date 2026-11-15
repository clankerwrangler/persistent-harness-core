# Dependencies and installation

## Conversation core

Each session runs on [conversation-core](https://github.com/clankerwrangler/conversation-core),
a separate program. The core keeps the session's history, builds model requests, talks to
providers, and manages provider sign-ins. The harness starts one core per running session
through `bin/core-actor.mjs` and reads histories by asking the core. The core also has
built-in file tools, but the harness disables them for sessions; persistent Python is the
execution tool.

### Build and install

Build the core with a Rust toolchain that supports the 2024 edition. Install the binary
and `js/core.mjs` from the same core checkout. If you set `PI_CODING_AGENT_DIR` or
`PI_HARNESS_CORE_HOME`, use the same absolute path for these commands and the supervisor.
From a directory where you want the core source, run:

```sh
git clone https://github.com/clankerwrangler/conversation-core.git
cd conversation-core
cargo build --release --locked
CORE_HOME="${PI_HARNESS_CORE_HOME:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/core}"
mkdir -p "$CORE_HOME/bin" "$CORE_HOME/js"
install -m 755 target/release/core "$CORE_HOME/bin/core"
install -m 644 js/core.mjs "$CORE_HOME/js/core.mjs"
```

To use the core repository's model definitions and fallback lists, copy its `models.json`
without replacing an existing configuration:

```sh
if [ ! -e "$CORE_HOME/models.json" ]; then
  cp models.json "$CORE_HOME/models.json"
fi
```

The core's files for harness sessions live together under `core/` in the agent folder
(`PI_CODING_AGENT_DIR`, default `~/.pi/agent`):

- `core/bin/core` and `core/js/core.mjs`: the installed core.
- `core/auth.json`: the provider sign-ins.
- `core/catalog/`: cached provider model lists.
- `core/models.json`: optional model definitions and fallback metadata.
- `core/sessions/`: one folder per session.

Every core the harness starts gets `--agent-dir` set to the agent folder, so the global
`AGENTS.md` and depth instructions there apply. It also gets `--auth`, `--catalog`, and
(when the file exists) `--models` from `core/`. The WebUI uses the same `--auth` file when
it asks the core for remaining usage or runs a sign-in.

Optional settings, mainly for tests or custom installations:

- `PI_HARNESS_CORE_HOME`: another folder in place of `<agent folder>/core`.
- `PI_HARNESS_CORE_BIN`, `PI_HARNESS_CORE_JS`: another core binary or `js/core.mjs`.
  If these are set, use those paths instead of the default install paths.
- `PI_HARNESS_CORE_ARGS`: a JSON array of flags passed to every core, after the defaults.
  A flag given here, such as `--auth`, replaces its default.
- `PI_HARNESS_CORE_SESSIONS`: another folder for session folders.

### Provider sign-in

Use the same agent and core settings for sign-in and for the harness. For example, to sign
in to Codex with a device code, run:

```sh
CORE_HOME="${PI_HARNESS_CORE_HOME:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/core}"
"${PI_HARNESS_CORE_BIN:-$CORE_HOME/bin/core}" login openai-codex device --auth "$CORE_HOME/auth.json"
```

If `PI_HARNESS_CORE_ARGS` supplies `--auth`, use that file instead. The core's standalone
credential default is separate from the harness default. The core writes sign-ins with
owner-only permissions and renews them under a lock; the harness does not read the
credentials. See the core's
[sign-in methods and credential handling](https://github.com/clankerwrangler/conversation-core/blob/main/docs/configuration.md#sign-in).

## Python and skills

Managed provisioning on Linux x64 uses checksum-verified uv 0.12.3 and version-pinned
CPython 3.12.12, IPython 9.10.0, and dill 0.3.8. From the harness checkout, review the
skill catalog and approve provisioning before starting sessions:

```sh
node bin/provision-skills.mjs --yes
```

Alternatively, a connected client can request `get_skill_runtime_plan` from the supervisor,
review the packages and skills, and approve the exact returned fingerprint with
`provision_skill_runtime`. The supervisor rejects a stale fingerprint. Sessions start an
installed runtime; they do not install one or prompt for installation. If no usable runtime
is installed, session Python startup fails until provisioning is complete.

`PI_HARNESS_AUTO_INSTALL=1` permits managed runtime installation without a separate
approval, including when requesting a runtime plan. Leave it unset to require approval.
Managed environments are selected by dependencies and skill manifests. A completed
environment with matching dependencies can be reused, including after a source-only skill
change. Provision a compatible environment before starting sessions if none exists.

Kernel launch validates imports and all three versions in the process that runs cells,
before snapshot recovery or deserialization. Each replacement validates again. Managed
launches require the exact pins; an explicit interpreter reports its observed versions
without pinning them. Standalone provisioning and changed-catalog admission retain their
disposable import checks. A catalog fingerprint or an earlier provision result does not
validate a new process.

During a managed session launch, an import, version, or executable rejection can select
another compatible completed environment. An explicit interpreter is the only candidate
when `PI_HARNESS_PYTHON` is set. Configuration, control, and restore failures do not
trigger runtime repair. A newly built runtime publishes its completion record after
import/version validation, even if later namespace restoration fails.

For an existing compatible interpreter with IPython, dill, and the catalog's Python
dependencies already installed:

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
credentials out of source, examples, and committed environment files. Node, the core, and
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
