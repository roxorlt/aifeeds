#!/usr/bin/python3 -I
"""Narrow compatibility wrapper for one systemd is-enabled result.

This file is copied to a private, transient PATH directory as ``systemctl``.
Every invocation except the exact timer query is replaced by the real systemctl
process.  The exact query is captured only so systemd's rc=4/not-found result can
be represented as the rc=1/not-found result understood by the frozen recovery
helper.
"""

import os
import subprocess
import sys


REAL_SYSTEMCTL = "/usr/bin/systemctl"
TARGET_ARGS = ("is-enabled", "aifeeds-performance-logrotate.timer")


def main(
    argv=None,
    *,
    real_systemctl=REAL_SYSTEMCTL,
    stdout=None,
    stderr=None,
    environment=None,
    execve=os.execve,
):
    args = list(sys.argv[1:] if argv is None else argv)
    process_environment = os.environ if environment is None else environment

    if tuple(args) != TARGET_ARGS:
        execve(real_systemctl, [real_systemctl, *args], process_environment)
        raise RuntimeError("execve returned unexpectedly")

    output_stream = sys.stdout.buffer if stdout is None else stdout
    error_stream = sys.stderr.buffer if stderr is None else stderr
    completed = subprocess.run(
        [real_systemctl, *args],
        check=False,
        env=process_environment,
        stderr=subprocess.PIPE,
        stdout=subprocess.PIPE,
    )
    output_stream.write(completed.stdout)
    error_stream.write(completed.stderr)
    output_stream.flush()
    error_stream.flush()

    if (
        completed.returncode == 4
        and completed.stdout == b"not-found\n"
        and completed.stderr == b""
    ):
        return 1
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())
