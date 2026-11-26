#!/bin/sh
# Run this branch's installer in a Linux container and check its libc
# detection. Run it from the repository root, as root.
#
# EXPECTED_LIBC=glibc: on a glibc distro, install the musl package, which adds
#   the musl loader, and check the installer still installs a working binary.
# EXPECTED_LIBC=musl: check the installer names the C++ runtime libraries the
#   musl binary needs, then installs them and checks it installs the binary.
set -eu

expected="${EXPECTED_LIBC:?set EXPECTED_LIBC to glibc or musl}"

if command -v apt-get >/dev/null 2>&1; then
  apt-get update
  # Slim images lack libatomic1, which the released binary links against.
  apt-get install -y --no-install-recommends \
    bash ca-certificates curl gzip libatomic1 musl
elif command -v pacman >/dev/null 2>&1; then
  pacman -Syu --noconfirm --needed bash curl gzip musl
elif command -v apk >/dev/null 2>&1; then
  apk add --no-cache bash curl
else
  echo "No supported package manager in this image" >&2
  exit 1
fi

machine=$(uname -m)
loader="/lib/ld-musl-${machine}.so.1"
if [ ! -e "$loader" ]; then
  echo "Expected $loader to exist; the check would not cover the musl loader" >&2
  exit 1
fi

log=$(mktemp)
# Sets status, and log to the installer's output.
run_installer() {
  SENTRY_INSTALL_DIR=$(mktemp -d)
  export SENTRY_INSTALL_DIR
  status=0
  bash packages/cli/install --no-modify-path >"$log" 2>&1 || status=$?
  cat "$log"
}

case "$expected" in
  glibc)
    run_installer
    if [ "$status" -ne 0 ]; then
      echo "Installer exited $status on glibc with $loader present" >&2
      exit 1
    fi
    "$SENTRY_INSTALL_DIR/sentry" --version
    ;;
  musl)
    run_installer
    if [ "$status" -eq 0 ]; then
      echo "Installer installed a binary on musl without its C++ runtime libraries" >&2
      exit 1
    fi
    if ! grep -q "apk add libstdc++ libatomic" "$log"; then
      echo "Installer did not name the libraries the musl binary needs" >&2
      exit 1
    fi

    apk add --no-cache libstdc++ libatomic
    run_installer
    if [ "$status" -eq 0 ]; then
      "$SENTRY_INSTALL_DIR/sentry" --version
    elif ! grep -q "has no sentry-linux-x64-musl build" "$log"; then
      # Releases before the first musl build have none to install.
      echo "Installer exited $status on musl with the libraries installed" >&2
      exit 1
    fi
    ;;
  *)
    echo "Unknown EXPECTED_LIBC: $expected" >&2
    exit 1
    ;;
esac
