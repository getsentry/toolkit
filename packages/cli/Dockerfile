# The getsentry/sentry-cli image: the standalone Linux binary on distroless.
# cli-build.yml builds it from this directory after copying in
# dist-bin/sentry-linux-amd64 and dist-bin/sentry-linux-arm64 (the
# `script/build.ts` outputs, renamed from x64 to Docker's amd64).

# distroless has no package manager, so take the extra files from Debian 12,
# which distroless/cc-debian12 is built from. The Node runtime in the binary
# links libatomic. `release set-commits --auto`, `release propose-version`, and
# `code-mappings upload` read the mounted checkout with git, which needs
# libpcre2 and zlib. A checkout mounted from the host belongs to another user,
# so git must trust the /work mount point.
FROM debian:bookworm-slim@sha256:e67eeead736ff7bbe258ef088bff683635c561b1fcfefad0806c1df4ab49ce0e AS deps
RUN apt-get update \
    && apt-get install -y --no-install-recommends git libatomic1 \
    && git config --system --add safe.directory /work \
    && mkdir /deps \
    && cp -L --parents /etc/gitconfig /usr/bin/git \
        /usr/lib/*-linux-gnu/libatomic.so.1 \
        /lib/*-linux-gnu/libpcre2-8.so.0 \
        /lib/*-linux-gnu/libz.so.1 \
        /deps/

FROM gcr.io/distroless/cc-debian12@sha256:e5d81ddde149641e2a9ba55be4545bc125c67de07508b03ba4c22e6eb0ded5aa

LABEL org.opencontainers.image.source="https://github.com/getsentry/toolkit" \
      org.opencontainers.image.description="Sentry CLI" \
      org.opencontainers.image.licenses="FSL-1.1-Apache-2.0"

COPY --from=deps /deps/ /

ARG TARGETARCH
COPY --chmod=555 dist-bin/sentry-linux-$TARGETARCH /usr/local/bin/sentry

# A container can't upgrade its own image; pull a newer tag instead.
ENV SENTRY_CLI_NO_UPDATE_CHECK=1

# Same as the v3 image: mount the project at /work.
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/sentry"]
