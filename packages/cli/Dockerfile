# The getsentry/sentry-cli image: the standalone Linux binary on a slim
# Debian base. cli-build.yml builds it from this directory after copying in
# dist-bin/sentry-linux-amd64 and dist-bin/sentry-linux-arm64 (the
# `script/build.ts` outputs, renamed from x64 to Docker's amd64).
FROM debian:bookworm-slim

LABEL org.opencontainers.image.source="https://github.com/getsentry/toolkit" \
      org.opencontainers.image.description="Sentry CLI" \
      org.opencontainers.image.licenses="FSL-1.1-Apache-2.0"

# The Node runtime in the binary links libatomic, which slim images leave out.
# `release set-commits --auto`, `release propose-version`, and
# `code-mappings upload` read the mounted checkout with git. A checkout mounted
# from the host belongs to another user, so git must trust every directory.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git libatomic1 \
    && rm -rf /var/lib/apt/lists/* \
    && git config --system --add safe.directory '*'

ARG TARGETARCH
COPY --chmod=555 dist-bin/sentry-linux-$TARGETARCH /usr/local/bin/sentry

# A container can't upgrade its own image; pull a newer tag instead.
ENV SENTRY_CLI_NO_UPDATE_CHECK=1

# Same as the v3 image: mount the project at /work.
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/sentry"]
