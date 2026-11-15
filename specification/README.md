# Specification sources

Every `.tla` module under `specification/`, including nested and generated modules,
names the repository files whose behavior it models. Put a `Sources` block
immediately after its `MODULE` declaration, one file per line:

```tla
---- MODULE Example ----
\* Sources:
\*   src/example.mjs
EXTENDS Naturals
```

Use canonical repository-relative paths with forward slashes: no absolute paths,
`.` or `..` segments, repeated separators, or backslashes. Real test and helper
source files are valid. Paths must resolve to regular files inside the repository.
Specification directories and modules must be regular directories and files, not
symbolic links. Separate any following comment prose with a blank line. A module
names at least one file; duplicate and malformed entries fail.

## Checks

`npm test` runs `test/specification-sources.test.mjs`, which checks that every
module has a Sources block and that each named file exists. That says nothing about
whether a model still matches its code. To run just this check:

```sh
node bin/run-tests.mjs unit test/specification-sources.test.mjs
```

When a change alters behavior a model covers, review the model against it, update
the model where it no longer matches, and rerun it with TLC; an unrelated edit in a
named file needs no rerun. The runner accepts model-name prefixes, for example
`node bin/check-specs.mjs Example`, and compares outcomes with
`specification/expected-results.json` (`--record` rewrites those outcomes). When
code moves to another file, update the names; when the modeled code is removed or
replaced, delete or merge the model in the same change.

## Model ownership boundaries

`MessageLocation` models the harness pipeline for an already-frozen optional
attachment: durable admission, idempotent replay, canonical commit (the location
saved as a marked block of the message), and private versus public projection. Browser opt-in, acquisition clocks,
send deadlines, and cancellation are not harness guarantees.
