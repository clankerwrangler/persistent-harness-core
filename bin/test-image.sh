#!/bin/sh
# Build the test image from this checkout and the core's repository, then run the tests in
# it: no network, no live state, the checkout copied in read-only.
#
#   bin/test-image.sh --core <core repo> [--cpus N] [--runs N] [run-tests.mjs arguments...]
#   bin/test-image.sh --core <core repo> --specs [check-specs.mjs arguments...]
#
# --cpus 0.5 --runs 3 is the starved check: tests must also pass on a slow machine.
# --specs runs the TLA+ model checks instead of the tests.
set -eu
cd "$(dirname "$0")/.."
core="" cpus=4 runs=1 runner=bin/run-tests.mjs
while [ $# -gt 0 ]; do
  case "$1" in
    --core) core="$2"; shift 2 ;;
    --cpus) cpus="$2"; shift 2 ;;
    --runs) runs="$2"; shift 2 ;;
    --specs) runner=bin/check-specs.mjs; shift ;;
    *) break ;;
  esac
done
[ -n "$core" ] || { echo "usage: bin/test-image.sh --core <core repo> [--cpus N] [--runs N] [run-tests args...]" >&2; exit 2; }
image=persistent-harness-test:local
# The runtime's downloads (uv, the interpreter, the package cache) are kept from the last
# image built, so a rebuild does not depend on GitHub serving them again.
seed="${HARNESS_RUNTIME_SEED:-$HOME/.cache/persistent-harness/runtime-seed}"
mkdir -p "$seed"
if [ -z "$(ls -A "$seed")" ] && docker image inspect "$image" >/dev/null 2>&1; then
  previous=$(docker create "$image")
  docker cp "$previous:/opt/kernel-seed/." "$seed/" || true
  docker rm "$previous" >/dev/null
fi
# The build has its own disposable builder: removing it drops only this run's
# cache, never the shared Docker builder or another test's work. The loaded image
# and the runtime seed remain available for later runs.
token=$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')
name="harness-test-$$-$token"
builder="$name-builder"
builder_created=0
build_pid=""
remove_builder() {
  if [ "$builder_created" -eq 1 ]; then
    if docker buildx rm "$builder" >/dev/null; then
      builder_created=0
    else
      echo "warning: could not remove task-owned builder $builder" >&2
    fi
  fi
}
cleanup() {
  if [ -n "$build_pid" ]; then
    kill "$build_pid" >/dev/null 2>&1 || true
    wait "$build_pid" >/dev/null 2>&1 || true
  fi
  docker rm -f "$name" >/dev/null 2>&1 || true
  remove_builder
}
trap cleanup EXIT
trap 'exit 143' INT TERM HUP
docker buildx create --name "$builder" --driver docker-container >/dev/null
builder_created=1
# A signal interrupts wait, so cleanup can stop the build and remove its builder.
docker buildx build --builder "$builder" --load -q -f test/image/Dockerfile --build-context core-src="$core" --build-context runtime-seed="$seed" -t "$image" . >/dev/null &
build_pid=$!
if wait "$build_pid"; then build_status=0; else build_status=$?; fi
build_pid=""
[ "$build_status" -eq 0 ] || exit "$build_status"
remove_builder
# The test container goes with this script; the EXIT trap removes it on a signal.
status=0
i=1
while [ "$i" -le "$runs" ]; do
  echo "== run $i of $runs at $cpus CPU"
  docker run --rm --init --name "$name" --network none --cpus "$cpus" --memory 6g -v "$PWD":/src:ro -e RUNNER="$runner" "$image" sh -c '
    cp -a /src /home/node/checkout && cd /home/node/checkout
    rm -rf node_modules && ln -s /opt/harness/node_modules node_modules
    exec node "$RUNNER" "$@"' run-tests "$@" &
  # Waited for in the background, so a signal interrupts the wait (a foreground child would defer it).
  wait $! || status=1
  i=$((i + 1))
done
exit $status
