#!/usr/bin/env python3
"""Small audited filesystem helper for root snapshot directory transactions.

Production contract (Linux/glibc):
- renameat2(old_parent_fd, old_name, new_parent_fd, new_name,
  RENAME_NOREPLACE). EEXIST is a safe conflict and never overwrites.
- openat(..., O_DIRECTORY|O_NOFOLLOW), fstat(), and fstatat(...,
  AT_SYMLINK_NOFOLLOW) bind every traversed directory to its recorded inode.
- unlinkat(parent_fd, name, 0|AT_REMOVEDIR) removes only entries below held
  directory descriptors. ENOENT is not silently accepted by this helper.

The Darwin renameatx_np branch exists only so the repository's semantic tests
can run on developer machines. The production installer rejects non-Linux
hosts before invoking this helper.
"""

from __future__ import annotations

import argparse
import ctypes
import errno
import os
import stat
import sys
import time


RENAME_NOREPLACE = 1
RENAME_EXCL = 0x00000004
AT_REMOVEDIR = 0x200
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW


class SafetyError(RuntimeError):
    pass


def identity(value: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        value.st_dev,
        value.st_ino,
        value.st_uid,
        value.st_gid,
        stat.S_IMODE(value.st_mode),
    )


def expected_identity(values: list[str]) -> tuple[int, int, int, int, int]:
    parsed = tuple(int(value, 10) for value in values)
    if len(parsed) != 5 or any(value < 0 for value in parsed):
        raise SafetyError("invalid expected directory identity")
    return parsed


def require_directory(value: os.stat_result, expected: tuple[int, ...], label: str) -> None:
    if not stat.S_ISDIR(value.st_mode) or identity(value) != expected:
        raise SafetyError(f"{label} directory identity mismatch")


def open_parent(entry: str) -> tuple[int, bytes]:
    parent, name = os.path.split(os.path.abspath(entry))
    if not parent or not name or name in (".", ".."):
        raise SafetyError("unsafe directory transaction path")
    descriptor = os.open(parent, DIRECTORY_FLAGS)
    return descriptor, os.fsencode(name)


def stat_name(parent_fd: int, name: bytes) -> os.stat_result:
    return os.stat(name, dir_fd=parent_fd, follow_symlinks=False)


def same_opened_name(parent_fd: int, name: bytes, opened_fd: int) -> bool:
    try:
        named = stat_name(parent_fd, name)
    except FileNotFoundError:
        return False
    return identity(named) == identity(os.fstat(opened_fd))


def pause_for_test(args: argparse.Namespace) -> None:
    if args.test_ready is None and args.test_gate is None:
        return
    if (
        os.environ.get("AIFEEDS_LINUX_FS_TEST_MODE") != "1"
        or args.test_ready is None
        or args.test_gate is None
    ):
        raise SafetyError("test pause is forbidden outside test mode")
    with open(args.test_ready, "x", encoding="utf-8") as ready:
        ready.write("ready\n")
        ready.flush()
        os.fsync(ready.fileno())
    while os.path.exists(args.test_gate):
        time.sleep(0.01)


def rename_no_replace(
    old_parent_fd: int,
    old_name: bytes,
    new_parent_fd: int,
    new_name: bytes,
) -> None:
    if (
        os.environ.get("AIFEEDS_LINUX_FS_TEST_MODE") == "1"
        and os.environ.get("AIFEEDS_LINUX_FS_FORCE_UNSUPPORTED") == "1"
    ):
        raise OSError(errno.ENOSYS, "forced unsupported no-replace rename")
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform.startswith("linux"):
        try:
            function = libc.renameat2
        except AttributeError as error:
            raise SafetyError("renameat2 is unavailable") from error
        function.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        function.restype = ctypes.c_int
        result = function(
            old_parent_fd,
            old_name,
            new_parent_fd,
            new_name,
            RENAME_NOREPLACE,
        )
    elif sys.platform == "darwin":
        function = libc.renameatx_np
        function.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        function.restype = ctypes.c_int
        result = function(
            old_parent_fd,
            old_name,
            new_parent_fd,
            new_name,
            RENAME_EXCL,
        )
    else:
        raise SafetyError(f"unsupported no-replace rename platform: {sys.platform}")
    if result != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), os.fsdecode(new_name))


def probe_name(parent_fd: int) -> bytes:
    for _ in range(16):
        name = os.fsencode(f".aifeeds-cc-fs-probe.{os.urandom(16).hex()}")
        try:
            os.mkdir(name, 0o700, dir_fd=parent_fd)
            return name
        except FileExistsError:
            continue
    raise SafetyError("unable to allocate filesystem probe directory")


def remove_named_directory(parent_fd: int, name: bytes) -> None:
    try:
        directory_fd = os.open(name, DIRECTORY_FLAGS, dir_fd=parent_fd)
    except FileNotFoundError:
        return
    try:
        remove_directory_entries(directory_fd)
        if not same_opened_name(parent_fd, name, directory_fd):
            raise SafetyError("filesystem probe directory changed during cleanup")
        os.rmdir(name, dir_fd=parent_fd)
        os.fsync(parent_fd)
    finally:
        os.close(directory_fd)


def probe_filesystem(args: argparse.Namespace) -> None:
    if not os.path.isabs(args.parent):
        raise SafetyError("filesystem probe parent must be absolute")
    expected_uid = int(args.uid, 10)
    expected_gid = int(args.gid, 10)
    if expected_uid < 0 or expected_gid < 0:
        raise SafetyError("invalid filesystem probe owner")
    parent_fd = os.open(args.parent, DIRECTORY_FLAGS)
    operation_name = None
    operation_fd = -1
    source_fd = -1
    published_fd = -1
    try:
        parent_identity = os.fstat(parent_fd)
        if (
            not stat.S_ISDIR(parent_identity.st_mode)
            or parent_identity.st_uid != expected_uid
            or parent_identity.st_gid != expected_gid
            or stat.S_IMODE(parent_identity.st_mode) & 0o022
        ):
            raise SafetyError("filesystem probe parent is unsafe")
        operation_name = probe_name(parent_fd)
        operation_fd = os.open(operation_name, DIRECTORY_FLAGS, dir_fd=parent_fd)
        os.fchown(operation_fd, expected_uid, expected_gid)
        os.fchmod(operation_fd, 0o700)
        os.fsync(operation_fd)
        os.fsync(parent_fd)

        source_name = b"source"
        occupied_name = b"occupied"
        published_name = b"published"
        os.mkdir(source_name, 0o700, dir_fd=operation_fd)
        os.mkdir(occupied_name, 0o700, dir_fd=operation_fd)
        source_fd = os.open(source_name, DIRECTORY_FLAGS, dir_fd=operation_fd)
        nested_name = b"nested"
        os.mkdir(nested_name, 0o700, dir_fd=source_fd)
        nested_fd = os.open(nested_name, DIRECTORY_FLAGS, dir_fd=source_fd)
        try:
            proof_fd = os.open(
                b"proof",
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600,
                dir_fd=nested_fd,
            )
            try:
                os.write(proof_fd, b"probe\n")
                os.fsync(proof_fd)
            finally:
                os.close(proof_fd)
            os.fsync(nested_fd)
        finally:
            os.close(nested_fd)
        os.fsync(source_fd)
        os.fsync(operation_fd)

        try:
            rename_no_replace(
                operation_fd,
                source_name,
                operation_fd,
                occupied_name,
            )
        except OSError as error:
            if error.errno != errno.EEXIST:
                raise
        else:
            raise SafetyError("no-replace rename overwrote an occupied destination")
        if not same_opened_name(operation_fd, source_name, source_fd):
            raise SafetyError("no-replace conflict changed the source directory")

        remove_named_directory(operation_fd, occupied_name)
        rename_no_replace(
            operation_fd,
            source_name,
            operation_fd,
            published_name,
        )
        published_fd = os.open(
            published_name,
            DIRECTORY_FLAGS,
            dir_fd=operation_fd,
        )
        if identity(os.fstat(published_fd)) != identity(os.fstat(source_fd)):
            raise SafetyError("no-replace probe published a different inode")
        remove_directory_entries(published_fd)
        if not same_opened_name(operation_fd, published_name, published_fd):
            raise SafetyError("filesystem probe publication changed during cleanup")
        os.rmdir(published_name, dir_fd=operation_fd)
        os.fsync(operation_fd)
    finally:
        if published_fd >= 0:
            os.close(published_fd)
        if source_fd >= 0:
            os.close(source_fd)
        if operation_fd >= 0:
            os.close(operation_fd)
        if operation_name is not None:
            remove_named_directory(parent_fd, operation_name)
        os.close(parent_fd)


def move_directory_no_replace(args: argparse.Namespace) -> None:
    expected = expected_identity(args.identity)
    source_parent_fd, source_name = open_parent(args.source)
    destination_parent_fd, destination_name = open_parent(args.destination)
    source_fd = -1
    destination_fd = -1
    try:
        source_fd = os.open(source_name, DIRECTORY_FLAGS, dir_fd=source_parent_fd)
        require_directory(os.fstat(source_fd), expected, "source")
        pause_for_test(args)
        if not same_opened_name(source_parent_fd, source_name, source_fd):
            raise SafetyError("source directory changed before no-replace rename")
        rename_no_replace(
            source_parent_fd,
            source_name,
            destination_parent_fd,
            destination_name,
        )
        destination_fd = os.open(
            destination_name,
            DIRECTORY_FLAGS,
            dir_fd=destination_parent_fd,
        )
        require_directory(os.fstat(destination_fd), expected, "published")
        if identity(os.fstat(destination_fd)) != identity(os.fstat(source_fd)):
            raise SafetyError("published directory is not the held source inode")
        os.fsync(source_parent_fd)
        if destination_parent_fd != source_parent_fd:
            os.fsync(destination_parent_fd)
    finally:
        if destination_fd >= 0:
            os.close(destination_fd)
        if source_fd >= 0:
            os.close(source_fd)
        os.close(destination_parent_fd)
        os.close(source_parent_fd)


def remove_directory_entries(directory_fd: int) -> None:
    for name_text in sorted(os.listdir(directory_fd)):
        name = os.fsencode(name_text)
        before = stat_name(directory_fd, name)
        if stat.S_ISDIR(before.st_mode):
            child_fd = os.open(name, DIRECTORY_FLAGS, dir_fd=directory_fd)
            try:
                if identity(os.fstat(child_fd)) != identity(before):
                    raise SafetyError("child directory changed while opening")
                remove_directory_entries(child_fd)
                if not same_opened_name(directory_fd, name, child_fd):
                    raise SafetyError("child directory changed before unlinkat")
                os.rmdir(name, dir_fd=directory_fd)
                os.fsync(directory_fd)
            finally:
                os.close(child_fd)
        elif stat.S_ISREG(before.st_mode):
            child_fd = os.open(name, FILE_FLAGS, dir_fd=directory_fd)
            try:
                if identity(os.fstat(child_fd)) != identity(before):
                    raise SafetyError("child file changed while opening")
                if not same_opened_name(directory_fd, name, child_fd):
                    raise SafetyError("child file changed before unlinkat")
                os.unlink(name, dir_fd=directory_fd)
                os.fsync(directory_fd)
            finally:
                os.close(child_fd)
        elif stat.S_ISLNK(before.st_mode):
            current = stat_name(directory_fd, name)
            if identity(current) != identity(before):
                raise SafetyError("child symlink changed before unlinkat")
            os.unlink(name, dir_fd=directory_fd)
            os.fsync(directory_fd)
        else:
            raise SafetyError("snapshot contains an unsupported filesystem entry")
    os.fsync(directory_fd)


def remove_directory_bound(args: argparse.Namespace) -> None:
    expected = expected_identity(args.identity)
    parent_fd, name = open_parent(args.path)
    directory_fd = -1
    try:
        directory_fd = os.open(name, DIRECTORY_FLAGS, dir_fd=parent_fd)
        require_directory(os.fstat(directory_fd), expected, "cleanup")
        pause_for_test(args)
        if not same_opened_name(parent_fd, name, directory_fd):
            raise SafetyError("cleanup directory changed before descriptor traversal")
        remove_directory_entries(directory_fd)
        if not same_opened_name(parent_fd, name, directory_fd):
            raise SafetyError("cleanup directory changed before final unlinkat")
        os.rmdir(name, dir_fd=parent_fd)
        os.fsync(parent_fd)
    finally:
        if directory_fd >= 0:
            os.close(directory_fd)
        os.close(parent_fd)


def empty_directory_bound(args: argparse.Namespace) -> None:
    expected = expected_identity(args.identity)
    parent_fd, name = open_parent(args.path)
    directory_fd = -1
    try:
        directory_fd = os.open(name, DIRECTORY_FLAGS, dir_fd=parent_fd)
        require_directory(os.fstat(directory_fd), expected, "cleanup")
        if not same_opened_name(parent_fd, name, directory_fd):
            raise SafetyError("cleanup directory changed before descriptor traversal")
        remove_directory_entries(directory_fd)
        if not same_opened_name(parent_fd, name, directory_fd):
            raise SafetyError("cleanup directory changed after descriptor traversal")
    finally:
        if directory_fd >= 0:
            os.close(directory_fd)
        os.close(parent_fd)


def remove_empty_directory_bound(args: argparse.Namespace) -> None:
    expected = expected_identity(args.identity)
    parent_fd, name = open_parent(args.path)
    directory_fd = -1
    try:
        directory_fd = os.open(name, DIRECTORY_FLAGS, dir_fd=parent_fd)
        require_directory(os.fstat(directory_fd), expected, "cleanup")
        if os.listdir(directory_fd):
            raise SafetyError("cleanup directory is not empty")
        if not same_opened_name(parent_fd, name, directory_fd):
            raise SafetyError("cleanup directory changed before final unlinkat")
        os.rmdir(name, dir_fd=parent_fd)
        os.fsync(parent_fd)
    finally:
        if directory_fd >= 0:
            os.close(directory_fd)
        os.close(parent_fd)


def inspect_directory(args: argparse.Namespace) -> None:
    parent_fd, name = open_parent(args.path)
    directory_fd = -1
    try:
        directory_fd = os.open(name, DIRECTORY_FLAGS, dir_fd=parent_fd)
        value = os.fstat(directory_fd)
        if not stat.S_ISDIR(value.st_mode) or not same_opened_name(parent_fd, name, directory_fd):
            raise SafetyError("inspected directory changed")
        print("\t".join(str(part) for part in identity(value)))
    finally:
        if directory_fd >= 0:
            os.close(directory_fd)
        os.close(parent_fd)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(add_help=False)
    subparsers = result.add_subparsers(dest="command", required=True)
    move = subparsers.add_parser("move-directory-no-replace")
    move.add_argument("source")
    move.add_argument("destination")
    move.add_argument("identity", nargs=5)
    cleanup = subparsers.add_parser("remove-directory-bound")
    cleanup.add_argument("path")
    cleanup.add_argument("identity", nargs=5)
    empty = subparsers.add_parser("empty-directory-bound")
    empty.add_argument("path")
    empty.add_argument("identity", nargs=5)
    remove_empty = subparsers.add_parser("remove-empty-directory-bound")
    remove_empty.add_argument("path")
    remove_empty.add_argument("identity", nargs=5)
    inspect = subparsers.add_parser("inspect-directory")
    inspect.add_argument("path")
    probe = subparsers.add_parser("probe")
    probe.add_argument("parent")
    probe.add_argument("uid")
    probe.add_argument("gid")
    for command in (move, cleanup):
        command.add_argument("--test-ready")
        command.add_argument("--test-gate")
    return result


def main() -> int:
    args = parser().parse_args()
    try:
        if args.command == "move-directory-no-replace":
            move_directory_no_replace(args)
        elif args.command == "remove-directory-bound":
            remove_directory_bound(args)
        elif args.command == "empty-directory-bound":
            empty_directory_bound(args)
        elif args.command == "remove-empty-directory-bound":
            remove_empty_directory_bound(args)
        elif args.command == "inspect-directory":
            inspect_directory(args)
        elif args.command == "probe":
            probe_filesystem(args)
        else:
            raise SafetyError("unsupported filesystem helper command")
    except (OSError, SafetyError, ValueError) as error:
        if isinstance(error, OSError) and error.errno == errno.EEXIST:
            print(f"ERROR: no-replace destination already exists: {error}", file=sys.stderr)
        else:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
