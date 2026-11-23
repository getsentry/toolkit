"""Run a command as the foreground job of a new terminal, then interrupt it.

Usage: pty-interrupt.py <ready-file> <ctrl-c|kill> <command> [args...]

Once <ready-file> exists, `ctrl-c` types Ctrl-C into the terminal, which
signals the terminal's whole foreground process group, and `kill` sends
SIGINT to the command's own pid only. Prints the command's exit code as JSON,
or null when it is still running 20 seconds later (it is then killed).
"""

import json
import os
import pty
import select
import signal
import sys
import time

ready, mode, *command = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(command[0], command)

terminal_open = True


def drain(seconds):
    """Read the terminal's output so the command never blocks writing."""
    global terminal_open
    if not terminal_open:
        time.sleep(seconds)
        return
    if select.select([fd], [], [], seconds)[0]:
        try:
            terminal_open = bool(os.read(fd, 4096))
        except OSError:  # EIO once the command closes the terminal
            terminal_open = False


def wait_for_exit(seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            return os.waitstatus_to_exitcode(status)
        drain(0.1)
    return None


deadline = time.monotonic() + 20
while not os.path.exists(ready) and time.monotonic() < deadline:
    drain(0.1)

if mode == "ctrl-c":
    os.write(fd, b"\x03")
else:
    os.kill(pid, signal.SIGINT)

code = wait_for_exit(20)
if code is None:
    os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)
print(json.dumps({"exitCode": code}))
