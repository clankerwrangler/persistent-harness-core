# The harness's test environment, built from this checkout and the core's repository:
# Node with the harness's packages, the managed Python runtime, and the conversation core.
# Tests run in it with no network and no live state (bin/test-image.sh).
#
#   docker build -f test/image/Dockerfile --build-context core-src=<core repo> --build-context runtime-seed=<dir> .
#
# runtime-seed: the runtime's earlier downloads (bin, cache, python), possibly empty;
# bin/test-image.sh keeps them from the last image.

FROM rust:1.99.1-slim-bookworm AS core
COPY --from=core-src . /core
WORKDIR /core
RUN cargo build --release --locked && install -m 755 target/release/core /usr/local/bin/core

FROM node:24.22.2-bookworm-slim
# python3: a plain interpreter some tests use for helper scripts (the kernel uses the managed one).
# A Java runtime and the TLA+ tools for the model checks (bin/check-specs.mjs).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git openjdk-17-jre-headless procps python3 \
  && rm -rf /var/lib/apt/lists/*
RUN mkdir /opt/tla && curl -fsSL -o /opt/tla/tla2tools-1.7.4.jar https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar \
  && echo "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88  /opt/tla/tla2tools-1.7.4.jar" | sha256sum -c -

# The harness's packages, outside the checkout that is copied in at test time.
WORKDIR /opt/harness
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# The managed Python runtime the kernel uses, installed now (with network) for the skills
# in this checkout. Tests use it as it is; its prerequisites (uv, its cache, the interpreter;
# no environments) are the offline seed for tests that install one from scratch.
COPY src ./src
COPY python-runtime ./python-runtime
COPY skills ./skills
COPY test/image/provision-runtime.mjs ./
COPY --from=runtime-seed . /opt/kernel-runtime/
RUN node provision-runtime.mjs /opt/kernel-runtime \
  && mkdir /opt/kernel-seed && cp -a /opt/kernel-runtime/bin /opt/kernel-runtime/cache /opt/kernel-runtime/python /opt/kernel-seed/ \
  && chown -R node:node /opt/kernel-runtime /opt/kernel-seed

COPY --from=core /usr/local/bin/core /usr/local/bin/core
COPY --from=core /core/js /opt/core/js
COPY --from=core /core/models.json /opt/core/models.json

ENV PI_HARNESS_CORE_BIN=/usr/local/bin/core \
    PI_HARNESS_CORE_JS=/opt/core/js/core.mjs \
    PI_HARNESS_CORE_MODELS=/opt/core/models.json \
    PI_HARNESS_PYTHON=/opt/kernel-runtime/test-python \
    PI_HARNESS_TEST_MANAGED_SEED=/opt/kernel-seed
USER node
WORKDIR /home/node
