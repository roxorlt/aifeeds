#!/usr/bin/env python3
"""Check request-id propagation without echoing nginx configuration values."""

from dataclasses import dataclass
import ctypes
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
from typing import Callable, Dict, List, Optional, Sequence, Set, Tuple


ROTATION_STATE_DIRECTORY = Path("/var/lib/aifeeds-performance-logrotate")
ROTATION_LEDGER_NAME = "rotation-provenance.jsonl"
ROTATION_STATUS_NAME = "status"
ROTATION_LOCK = Path("/run/aifeeds-performance-log-rotation.lock")
ROTATION_CONFIG = Path("/etc/aifeeds-performance-logrotate.conf")
ROTATION_CHECKER = Path("/usr/local/sbin/aifeeds-check-nginx-request-id")
ROTATION_ANCHOR_DIRECTORY = Path("/var/backups/aifeeds-performance-log")
LOGROTATE = Path("/usr/sbin/logrotate")
RENAME_NOREPLACE = 1
OPERATION_ID_RE = re.compile(r"^[0-9]{14}-[a-f0-9]{8}$")


class RotationProvenanceError(RuntimeError):
    """The stable rotation ledger or one of its authorized inodes drifted."""


def _canonical_json(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _record_with_hash(value: dict) -> dict:
    unsigned = dict(value)
    unsigned.pop("record_sha256", None)
    result = dict(unsigned)
    result["record_sha256"] = hashlib.sha256(_canonical_json(unsigned)).hexdigest()
    return result


def _mode(value: os.stat_result) -> str:
    return format(stat.S_IMODE(value.st_mode), "o")


def _is_int(value: object) -> bool:
    """JSON integer contract that deliberately excludes bool."""
    return type(value) is int


def _stable_regular_capture(path: Path) -> Tuple[dict, bytes]:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise RotationProvenanceError("not a regular file")
        digest = hashlib.sha256()
        chunks: List[bytes] = []
        size = 0
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            digest.update(chunk)
            chunks.append(chunk)
        after = os.fstat(descriptor)
        current = os.lstat(path)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
        ):
            raise RotationProvenanceError("file changed while captured")
        if (after.st_dev, after.st_ino) != (current.st_dev, current.st_ino):
            raise RotationProvenanceError("pathname changed while captured")
        identity = {
            "path": str(path),
            "sha256": digest.hexdigest(),
            "size": size,
            "uid": after.st_uid,
            "gid": after.st_gid,
            "mode": _mode(after),
            "dev": after.st_dev,
            "ino": after.st_ino,
        }
    finally:
        os.close(descriptor)
    return identity, b"".join(chunks)


def _stable_regular_identity(path: Path, expected: Optional[dict] = None) -> dict:
    identity, _ = _stable_regular_capture(path)
    if expected is not None:
        for key in ("path", "sha256", "size", "uid", "gid", "mode", "dev", "ino"):
            if identity.get(key) != expected.get(key):
                raise RotationProvenanceError(f"file identity drift: {key}")
    return identity


def _stable_directory_identity(path: Path, canonical_path: Optional[Path] = None) -> dict:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        value = os.fstat(descriptor)
        current = os.lstat(path)
        if not stat.S_ISDIR(value.st_mode) or not stat.S_ISDIR(current.st_mode):
            raise RotationProvenanceError("not a directory")
        if (value.st_dev, value.st_ino) != (current.st_dev, current.st_ino):
            raise RotationProvenanceError("directory pathname changed")
        return {
            "path": str(canonical_path or path),
            "uid": value.st_uid,
            "gid": value.st_gid,
            "mode": _mode(value),
            "dev": value.st_dev,
            "ino": value.st_ino,
        }
    finally:
        os.close(descriptor)


def _require_exact_keys(value: object, expected: Set[str], label: str) -> dict:
    if not isinstance(value, dict) or set(value) != expected:
        raise RotationProvenanceError(f"{label} schema drift")
    return value


def _validate_expected_subset(value: object, expected_path: Path, label: str) -> dict:
    result = _require_exact_keys(value, {"path", "sha256", "dev", "ino"}, label)
    if result.get("path") != str(expected_path):
        raise RotationProvenanceError(f"{label} path drift")
    if not isinstance(result.get("sha256"), str) \
            or not re.fullmatch(r"[a-f0-9]{64}", result["sha256"]):
        raise RotationProvenanceError(f"{label} hash drift")
    if not _is_int(result.get("dev")) or result["dev"] <= 0 \
            or not _is_int(result.get("ino")) or result["ino"] <= 0:
        raise RotationProvenanceError(f"{label} inode drift")
    return result


def _validate_authority_file_identity(
    value: object,
    expected_path: Path,
    expected_mode: str,
    label: str,
) -> dict:
    result = _require_exact_keys(
        value,
        {"path", "sha256", "size", "uid", "gid", "mode", "dev", "ino"},
        label,
    )
    if result.get("path") != str(expected_path) or result.get("mode") != expected_mode:
        raise RotationProvenanceError(f"{label} path or mode drift")
    if not isinstance(result.get("sha256"), str) \
            or not re.fullmatch(r"[a-f0-9]{64}", result["sha256"]):
        raise RotationProvenanceError(f"{label} hash drift")
    if not all(_is_int(result.get(key)) for key in ("size", "uid", "gid", "dev", "ino")):
        raise RotationProvenanceError(f"{label} numeric type drift")
    if result["size"] < 0 or result["dev"] <= 0 or result["ino"] <= 0:
        raise RotationProvenanceError(f"{label} numeric range drift")
    if result["uid"] != os.geteuid() or result["gid"] != os.getegid():
        raise RotationProvenanceError(f"{label} owner drift")
    return result




def _append_record(descriptor: int, record: dict) -> dict:
    complete = _record_with_hash(record)
    payload = _canonical_json(complete) + b"\n"
    _write_all(descriptor, payload)
    os.fsync(descriptor)
    return complete


def _validate_records(
    state_dir: Path,
    operation_id: str,
    ledger_value: os.stat_result,
    records: List[dict],
    directory_identity: Optional[dict] = None,
) -> None:
    if not OPERATION_ID_RE.fullmatch(operation_id) or not records:
        raise RotationProvenanceError("invalid operation")
    genesis = records[0]
    if not isinstance(genesis, dict):
        raise RotationProvenanceError("invalid record")
    genesis_directory = genesis.get("directory", {})
    canonical_directory = Path(genesis_directory.get("path", state_dir))
    if directory_identity is None:
        directory = _stable_directory_identity(state_dir, canonical_directory)
    else:
        directory = dict(directory_identity)
        directory["path"] = str(canonical_directory)
    previous_hash: Optional[str] = None
    previous_generation = 0
    previous_phase = ""
    previous_record: Optional[dict] = None

    def require_keys(value: dict, expected: Set[str]) -> None:
        if set(value) != expected:
            raise RotationProvenanceError("record schema drift")

    def validate_file_identity(value: object, expected_path: Path) -> dict:
        if not isinstance(value, dict):
            raise RotationProvenanceError("missing file identity")
        require_keys(value, {"path", "sha256", "size", "uid", "gid", "mode", "dev", "ino"})
        if value.get("path") != str(expected_path):
            raise RotationProvenanceError("identity path drift")
        if not isinstance(value.get("sha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", value["sha256"]):
            raise RotationProvenanceError("identity hash drift")
        if not _is_int(value.get("size")) or value["size"] < 0:
            raise RotationProvenanceError("identity size drift")
        if not _is_int(value.get("uid")) or not _is_int(value.get("gid")):
            raise RotationProvenanceError("identity owner type drift")
        if value.get("uid") != ledger_value.st_uid or value.get("gid") != ledger_value.st_gid:
            raise RotationProvenanceError("identity owner drift")
        if value.get("mode") != "600":
            raise RotationProvenanceError("identity mode drift")
        if not _is_int(value.get("dev")) or value["dev"] <= 0 \
                or not _is_int(value.get("ino")) or value["ino"] <= 0:
            raise RotationProvenanceError("identity inode drift")
        return value

    def validate_optional_status(value: object) -> Optional[dict]:
        if value is None:
            return None
        return validate_file_identity(value, state_dir / ROTATION_STATUS_NAME)

    def validate_workspace(value: object, generation: int) -> dict:
        if not isinstance(value, dict):
            raise RotationProvenanceError("missing workspace identity")
        require_keys(value, {"path", "uid", "gid", "mode", "dev", "ino"})
        expected_path = state_dir / f"generation-{generation:020d}"
        if value.get("path") != str(expected_path) or value.get("mode") != "700":
            raise RotationProvenanceError("workspace path drift")
        if not _is_int(value.get("uid")) or not _is_int(value.get("gid")):
            raise RotationProvenanceError("workspace owner type drift")
        if value.get("uid") != ledger_value.st_uid or value.get("gid") != ledger_value.st_gid:
            raise RotationProvenanceError("workspace owner drift")
        if not _is_int(value.get("dev")) or value["dev"] <= 0 \
                or not _is_int(value.get("ino")) or value["ino"] <= 0:
            raise RotationProvenanceError("workspace inode drift")
        return value

    for index, record in enumerate(records):
        if not isinstance(record, dict):
            raise RotationProvenanceError("invalid record")
        expected_hash = record.get("record_sha256")
        if not isinstance(expected_hash, str) or expected_hash != _record_with_hash(record)["record_sha256"]:
            raise RotationProvenanceError("record hash mismatch")
        if not _is_int(record.get("schema")) or record.get("schema") != 1 \
                or record.get("operation_id") != operation_id:
            raise RotationProvenanceError("record operation mismatch")
        if record.get("previous_record_sha256") != previous_hash:
            raise RotationProvenanceError("record chain mismatch")
        generation = record.get("generation")
        phase = record.get("phase")
        if not _is_int(generation) or generation < 0:
            raise RotationProvenanceError("record generation type drift")
        if index == 0:
            require_keys(record, {
                "schema", "operation_id", "generation", "phase", "previous_record_sha256",
                "record_sha256", "directory", "ledger", "workspace", "old_status", "new_status",
            })
            if generation != 0 or phase != "committed":
                raise RotationProvenanceError("invalid genesis")
            recorded_directory = record.get("directory")
            if not isinstance(recorded_directory, dict):
                raise RotationProvenanceError("directory schema drift")
            require_keys(recorded_directory, {"path", "uid", "gid", "mode", "dev", "ino"})
            if not all(_is_int(recorded_directory.get(key)) for key in ("uid", "gid", "dev", "ino")):
                raise RotationProvenanceError("directory numeric type drift")
            if recorded_directory["dev"] <= 0 or recorded_directory["ino"] <= 0:
                raise RotationProvenanceError("directory inode drift")
            if recorded_directory != directory:
                raise RotationProvenanceError("directory identity drift")
            ledger_identity = record.get("ledger", {})
            if set(ledger_identity) != {"path", "uid", "gid", "mode", "dev", "ino"}:
                raise RotationProvenanceError("ledger schema drift")
            if not all(_is_int(ledger_identity.get(key)) for key in ("uid", "gid", "dev", "ino")):
                raise RotationProvenanceError("ledger numeric type drift")
            if ledger_identity["dev"] <= 0 or ledger_identity["ino"] <= 0:
                raise RotationProvenanceError("ledger inode drift")
            if (
                ledger_identity.get("path") != str(canonical_directory / ROTATION_LEDGER_NAME)
                or ledger_identity.get("dev") != ledger_value.st_dev
                or ledger_identity.get("ino") != ledger_value.st_ino
                or ledger_identity.get("uid") != ledger_value.st_uid
                or ledger_identity.get("gid") != ledger_value.st_gid
                or ledger_identity.get("mode") != _mode(ledger_value)
            ):
                raise RotationProvenanceError("ledger identity drift")
            if record.get("workspace") is not None or record.get("old_status") is not None \
                    or record.get("new_status") is not None:
                raise RotationProvenanceError("invalid genesis authority")
        else:
            allowed = (
                (generation == previous_generation + 1 and phase == "prepared" and previous_phase == "committed")
                or (generation == previous_generation and phase == "captured" and previous_phase == "prepared")
                or (generation == previous_generation and phase == "committed" and previous_phase == "captured")
            )
            if not allowed:
                raise RotationProvenanceError("invalid phase transition")
            if phase == "prepared":
                require_keys(record, {
                    "schema", "operation_id", "generation", "phase", "previous_record_sha256",
                    "record_sha256", "workspace", "old_status", "candidate_initial",
                })
                workspace = validate_workspace(record.get("workspace"), generation)
                old_status = validate_optional_status(record.get("old_status"))
                candidate_initial = validate_file_identity(
                    record.get("candidate_initial"), Path(workspace["path"]) / ROTATION_STATUS_NAME
                )
                if previous_record is None or previous_record.get("phase") != "committed" \
                        or previous_record.get("new_status") != old_status:
                    raise RotationProvenanceError("prepared authority mismatch")
                if candidate_initial["dev"] != workspace["dev"]:
                    raise RotationProvenanceError("candidate workspace device drift")
                if old_status is None:
                    expected_initial_sha256 = hashlib.sha256(b"").hexdigest()
                    expected_initial_size = 0
                else:
                    expected_initial_sha256 = old_status["sha256"]
                    expected_initial_size = old_status["size"]
                if candidate_initial["sha256"] != expected_initial_sha256 \
                        or candidate_initial["size"] != expected_initial_size:
                    raise RotationProvenanceError("prepared candidate content drift")
            elif phase == "captured":
                require_keys(record, {
                    "schema", "operation_id", "generation", "phase", "previous_record_sha256",
                    "record_sha256", "workspace", "old_status", "candidate",
                })
                workspace = validate_workspace(record.get("workspace"), generation)
                old_status = validate_optional_status(record.get("old_status"))
                candidate = validate_file_identity(
                    record.get("candidate"), Path(workspace["path"]) / ROTATION_STATUS_NAME
                )
                if previous_record is None or previous_record.get("phase") != "prepared" \
                        or previous_record.get("workspace") != workspace \
                        or previous_record.get("old_status") != old_status:
                    raise RotationProvenanceError("captured authority mismatch")
                if candidate["dev"] != workspace["dev"]:
                    raise RotationProvenanceError("captured device drift")
            elif phase == "committed":
                require_keys(record, {
                    "schema", "operation_id", "generation", "phase", "previous_record_sha256",
                    "record_sha256", "workspace", "old_status", "new_status",
                })
                workspace = validate_workspace(record.get("workspace"), generation)
                old_status = validate_optional_status(record.get("old_status"))
                new_status = validate_optional_status(record.get("new_status"))
                if new_status is None:
                    raise RotationProvenanceError("missing committed status")
                if previous_record is None or previous_record.get("phase") != "captured" \
                        or previous_record.get("workspace") != workspace \
                        or previous_record.get("old_status") != old_status:
                    raise RotationProvenanceError("committed authority mismatch")
                captured = previous_record.get("candidate", {})
                for key in ("sha256", "size", "uid", "gid", "mode", "dev", "ino"):
                    if captured.get(key) != new_status.get(key):
                        raise RotationProvenanceError("committed candidate mismatch")
        previous_hash = expected_hash
        previous_generation = generation
        previous_phase = phase
        previous_record = record


def initialize_rotation_provenance(
    state_dir: Path,
    operation_id: str,
    canonical_directory: Optional[Path] = None,
) -> dict:
    state_dir = Path(state_dir)
    canonical_directory = Path(canonical_directory or state_dir)
    if not OPERATION_ID_RE.fullmatch(operation_id):
        raise RotationProvenanceError("invalid operation")
    directory = _stable_directory_identity(state_dir, canonical_directory)
    ledger = state_dir / ROTATION_LEDGER_NAME
    descriptor = os.open(
        ledger,
        os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    try:
        os.fchmod(descriptor, 0o600)
        value = os.fstat(descriptor)
        record = _append_record(
            descriptor,
            {
                "schema": 1,
                "operation_id": operation_id,
                "generation": 0,
                "phase": "committed",
                "previous_record_sha256": None,
                "directory": directory,
                "ledger": {
                    "path": str(canonical_directory / ROTATION_LEDGER_NAME),
                    "uid": value.st_uid,
                    "gid": value.st_gid,
                    "mode": _mode(value),
                    "dev": value.st_dev,
                    "ino": value.st_ino,
                },
                "workspace": None,
                "old_status": None,
                "new_status": None,
            },
        )
        value = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    parent = os.open(state_dir, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(parent)
    finally:
        os.close(parent)
    return {
        "path": str(canonical_directory / ROTATION_LEDGER_NAME),
        "uid": value.st_uid,
        "gid": value.st_gid,
        "mode": _mode(value),
        "dev": value.st_dev,
        "ino": value.st_ino,
        "genesis_record_sha256": record["record_sha256"],
    }




# Runtime rotation authority is descriptor-bound.  Timer, recovery, and verify
# operations never reopen an authorized pathname after this context is built.


def _pread_all(descriptor: int) -> bytes:
    value = os.fstat(descriptor)
    chunks: List[bytes] = []
    offset = 0
    while offset < value.st_size:
        chunk = os.pread(descriptor, min(1024 * 1024, value.st_size - offset), offset)
        if not chunk:
            raise RotationProvenanceError("short descriptor read")
        chunks.append(chunk)
        offset += len(chunk)
    return b"".join(chunks)


def _write_all(descriptor: int, payload: bytes) -> None:
    view = memoryview(payload)
    while view:
        written = os.write(descriptor, view)
        if written <= 0:
            raise RotationProvenanceError("short descriptor write")
        view = view[written:]


def _fd_regular_identity(descriptor: int, canonical_path: Path) -> dict:
    before = os.fstat(descriptor)
    if not stat.S_ISREG(before.st_mode):
        raise RotationProvenanceError("authorized descriptor is not regular")
    payload = _pread_all(descriptor)
    after = os.fstat(descriptor)
    if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
        after.st_dev,
        after.st_ino,
        after.st_size,
        after.st_mtime_ns,
    ):
        raise RotationProvenanceError("authorized descriptor changed while hashed")
    return {
        "path": str(canonical_path),
        "sha256": hashlib.sha256(payload).hexdigest(),
        "size": len(payload),
        "uid": after.st_uid,
        "gid": after.st_gid,
        "mode": _mode(after),
        "dev": after.st_dev,
        "ino": after.st_ino,
    }


def _fd_directory_identity(descriptor: int, canonical_path: Path) -> dict:
    value = os.fstat(descriptor)
    if not stat.S_ISDIR(value.st_mode):
        raise RotationProvenanceError("authorized descriptor is not a directory")
    return {
        "path": str(canonical_path),
        "uid": value.st_uid,
        "gid": value.st_gid,
        "mode": _mode(value),
        "dev": value.st_dev,
        "ino": value.st_ino,
    }


def _identity_fields_match(current: dict, expected: dict, *, include_path: bool = True) -> bool:
    fields = [
        field
        for field in ("uid", "gid", "mode", "dev", "ino", "sha256", "size")
        if field in expected
    ]
    if include_path and "path" in expected:
        fields.append("path")
    return all(current.get(field) == expected.get(field) for field in fields)


def _stat_at_optional(parent_descriptor: int, name: str) -> Optional[os.stat_result]:
    try:
        return os.stat(name, dir_fd=parent_descriptor, follow_symlinks=False)
    except FileNotFoundError:
        return None


def _require_canonical_fd(
    parent_descriptor: int,
    name: str,
    descriptor: int,
    expected: dict,
    canonical_path: Path,
) -> dict:
    current_path = _stat_at_optional(parent_descriptor, name)
    if current_path is None:
        raise RotationProvenanceError("authorized pathname disappeared")
    held = os.fstat(descriptor)
    if (current_path.st_dev, current_path.st_ino) != (held.st_dev, held.st_ino):
        raise RotationProvenanceError("authorized pathname identity drift")
    if stat.S_ISREG(held.st_mode):
        current = _fd_regular_identity(descriptor, canonical_path)
    elif stat.S_ISDIR(held.st_mode):
        current = _fd_directory_identity(descriptor, canonical_path)
    else:
        raise RotationProvenanceError("unsupported authorized inode type")
    if not _identity_fields_match(current, expected):
        raise RotationProvenanceError("authorized descriptor metadata drift")
    final_path = _stat_at_optional(parent_descriptor, name)
    final_held = os.fstat(descriptor)
    if final_path is None or (final_path.st_dev, final_path.st_ino) != (
        final_held.st_dev,
        final_held.st_ino,
    ):
        raise RotationProvenanceError("authorized pathname final identity drift")
    for observed in (final_path, final_held):
        final_metadata = {
            "uid": observed.st_uid,
            "gid": observed.st_gid,
            "mode": _mode(observed),
            "dev": observed.st_dev,
            "ino": observed.st_ino,
            "size": observed.st_size,
        }
        for field in ("uid", "gid", "mode", "dev", "ino", "size"):
            if field in expected and final_metadata[field] != expected[field]:
                raise RotationProvenanceError(
                    f"authorized pathname final metadata drift: {field}"
                )
    return current


def _open_regular_at(
    parent_descriptor: int,
    name: str,
    canonical_path: Path,
    expected: Optional[dict] = None,
    *,
    writable: bool = False,
) -> Tuple[int, dict]:
    flags = (os.O_RDWR if writable else os.O_RDONLY) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(name, flags, dir_fd=parent_descriptor)
    try:
        identity = _fd_regular_identity(descriptor, canonical_path)
        current = _stat_at_optional(parent_descriptor, name)
        if current is None or (current.st_dev, current.st_ino) != (
            identity["dev"], identity["ino"],
        ):
            raise RotationProvenanceError("regular pathname changed while opened")
        if expected is not None and not _identity_fields_match(identity, expected):
            raise RotationProvenanceError("regular inode authority drift")
        return descriptor, identity
    except Exception:
        os.close(descriptor)
        raise


def _open_directory_at(
    parent_descriptor: int,
    name: str,
    canonical_path: Path,
    expected: Optional[dict] = None,
) -> Tuple[int, dict]:
    descriptor = os.open(
        name,
        os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0),
        dir_fd=parent_descriptor,
    )
    try:
        identity = _fd_directory_identity(descriptor, canonical_path)
        current = _stat_at_optional(parent_descriptor, name)
        if current is None or (current.st_dev, current.st_ino) != (
            identity["dev"], identity["ino"],
        ):
            raise RotationProvenanceError("directory pathname changed while opened")
        if expected is not None and not _identity_fields_match(identity, expected):
            raise RotationProvenanceError("directory inode authority drift")
        return descriptor, identity
    except Exception:
        os.close(descriptor)
        raise


class RotationContext:
    """Held-FD authority and the single ledger serialization domain."""

    def __init__(
        self,
        *,
        state_dir: Path,
        operation_id: str,
        authority_path: Path,
        anchor_expected: dict,
        checker_path: Path,
        checker_expected: dict,
        config_path: Path,
        config_expected: dict,
        logrotate_path: Path,
        logrotate_expected: dict,
        exclusive: bool,
        barrier_hook: Optional[Callable[[str], None]] = None,
        barrier_trace: Optional[List[str]] = None,
    ) -> None:
        self.state_dir = Path(state_dir)
        self.operation_id = operation_id
        self.authority_path = Path(authority_path)
        self.checker_path = Path(checker_path)
        self.config_path = Path(config_path)
        self.logrotate_path = Path(logrotate_path)
        self.anchor_expected = anchor_expected
        self.checker_expected = checker_expected
        self.config_expected = config_expected
        self.logrotate_expected = logrotate_expected
        self.exclusive = exclusive
        self.barrier_hook = barrier_hook
        self.barrier_trace = barrier_trace
        self.parent_fd = -1
        self.anchor_fd = -1
        self.checker_fd = -1
        self.config_fd = -1
        self.logrotate_fd = -1
        self.state_fd = -1
        self.ledger_fd = -1
        self.ledger_size = -1
        self.ledger_sha256 = ""
        self.ledger_payload = b""
        self.anchor_identity: dict = {}
        self.authority: dict = {}
        self.directory_identity: dict = {}
        self.bindings: Dict[str, Tuple[int, str, int, dict, Path]] = {}
        self.absence_bindings: Dict[str, Tuple[int, str]] = {}
        self.state_allowlist: Optional[Set[str]] = None
        self.owned_fds: Set[int] = set()

    def __enter__(self) -> "RotationContext":
        if not OPERATION_ID_RE.fullmatch(self.operation_id):
            raise RotationProvenanceError("invalid operation")
        try:
            # The state parent is the outer namespace authority.  State and
            # ledger are subsequently opened only relative to held dirfds.
            self.parent_fd = os.open(
                self.state_dir.parent,
                os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0),
            )
            self.anchor_fd = os.open(
                self.authority_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            )
            self.checker_fd = os.open(
                self.checker_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            )
            self.config_fd = os.open(
                self.config_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            )
            self.logrotate_fd = os.open(
                self.logrotate_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            )
            self.state_fd, self.directory_identity = _open_directory_at(
                self.parent_fd, self.state_dir.name, self.state_dir
            )
            self.ledger_fd, _ = _open_regular_at(
                self.state_fd,
                ROTATION_LEDGER_NAME,
                self.state_dir / ROTATION_LEDGER_NAME,
                writable=self.exclusive,
            )
            fcntl.flock(
                self.ledger_fd,
                fcntl.LOCK_EX if self.exclusive else fcntl.LOCK_SH,
            )
            self.ledger_payload = _pread_all(self.ledger_fd)
            self.ledger_size = len(self.ledger_payload)
            self.ledger_sha256 = hashlib.sha256(self.ledger_payload).hexdigest()
            self._load_authority()
            self.barrier("B0-lock")
            return self
        except Exception:
            self.close()
            raise

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self.close()

    def close(self) -> None:
        for descriptor in list(self.owned_fds):
            try:
                os.close(descriptor)
            except OSError:
                pass
        self.owned_fds.clear()
        self.bindings.clear()
        self.absence_bindings.clear()
        self.state_allowlist = None
        for attribute in (
            "ledger_fd", "state_fd", "logrotate_fd", "config_fd", "checker_fd",
            "anchor_fd", "parent_fd",
        ):
            descriptor = getattr(self, attribute, -1)
            if descriptor >= 0:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
                setattr(self, attribute, -1)

    def _load_authority(self) -> None:
        expected_anchor = _validate_expected_subset(
            self.anchor_expected, self.authority_path, "anchor expected"
        )
        expected_checker = _validate_expected_subset(
            self.checker_expected, self.checker_path, "checker expected"
        )
        expected_config = _validate_expected_subset(
            self.config_expected, self.config_path, "config expected"
        )
        expected_logrotate = _validate_expected_subset(
            self.logrotate_expected, self.logrotate_path, "logrotate expected"
        )
        anchor = _fd_regular_identity(self.anchor_fd, self.authority_path)
        if anchor["uid"] != os.geteuid() or anchor["gid"] != os.getegid() \
                or anchor["mode"] != "600":
            raise RotationProvenanceError("anchor metadata drift")
        for key in ("path", "sha256", "dev", "ino"):
            if anchor[key] != expected_anchor[key]:
                raise RotationProvenanceError(f"anchor expected identity drift: {key}")
        self.anchor_identity = anchor
        payload = _pread_all(self.anchor_fd)
        try:
            authority = json.loads(payload)
        except (UnicodeError, json.JSONDecodeError) as error:
            raise RotationProvenanceError("invalid authority JSON") from error
        if payload != _canonical_json(authority) + b"\n":
            raise RotationProvenanceError("noncanonical authority")
        authority = _require_exact_keys(
            authority,
            {
                "schema", "operation_id", "directory", "provenance", "checker", "config",
                "logrotate",
            },
            "authority",
        )
        if not _is_int(authority.get("schema")) or authority.get("schema") != 2 \
                or authority.get("operation_id") != self.operation_id:
            raise RotationProvenanceError("authority operation drift")
        directory = _require_exact_keys(
            authority.get("directory"),
            {"path", "uid", "gid", "mode", "dev", "ino"},
            "directory",
        )
        if not all(_is_int(directory.get(key)) for key in ("uid", "gid", "dev", "ino")):
            raise RotationProvenanceError("authority directory numeric type drift")
        if directory["uid"] < 0 or directory["gid"] < 0 \
                or directory["dev"] <= 0 or directory["ino"] <= 0:
            raise RotationProvenanceError("authority directory numeric range drift")
        if directory != self.directory_identity or directory.get("mode") != "750" \
                or directory.get("uid") != os.geteuid() \
                or directory.get("gid") != os.getegid():
            raise RotationProvenanceError("authority directory identity drift")
        ledger = _require_exact_keys(
            authority.get("provenance"),
            {"path", "uid", "gid", "mode", "dev", "ino", "genesis_record_sha256"},
            "provenance",
        )
        if not all(_is_int(ledger.get(key)) for key in ("uid", "gid", "dev", "ino")):
            raise RotationProvenanceError("authority provenance numeric type drift")
        if ledger["uid"] < 0 or ledger["gid"] < 0 \
                or ledger["dev"] <= 0 or ledger["ino"] <= 0:
            raise RotationProvenanceError("authority provenance numeric range drift")
        ledger_current = _fd_regular_identity(
            self.ledger_fd, self.state_dir / ROTATION_LEDGER_NAME
        )
        for key in ("path", "uid", "gid", "mode", "dev", "ino"):
            if ledger.get(key) != ledger_current.get(key):
                raise RotationProvenanceError(f"authority ledger identity drift: {key}")
        if not isinstance(ledger.get("genesis_record_sha256"), str) \
                or not re.fullmatch(r"[a-f0-9]{64}", ledger["genesis_record_sha256"]):
            raise RotationProvenanceError("authority genesis drift")
        resources = (
            ("checker", self.checker_fd, self.checker_path, "755", expected_checker),
            ("config", self.config_fd, self.config_path, "644", expected_config),
            ("logrotate", self.logrotate_fd, self.logrotate_path, "755", expected_logrotate),
        )
        for label, descriptor, path, mode, expected in resources:
            recorded = _validate_authority_file_identity(
                authority.get(label), path, mode, label
            )
            current = _fd_regular_identity(descriptor, path)
            if current != recorded:
                raise RotationProvenanceError(f"{label} held identity drift")
            for key in ("path", "sha256", "dev", "ino"):
                if current[key] != expected[key]:
                    raise RotationProvenanceError(f"{label} expected identity drift: {key}")
        self.authority = authority

    def bind(
        self,
        label: str,
        parent_descriptor: int,
        name: str,
        descriptor: int,
        expected: dict,
        canonical_path: Path,
    ) -> None:
        if label in self.bindings or label in self.absence_bindings:
            raise RotationProvenanceError("duplicate descriptor binding")
        self.bindings[label] = (
            parent_descriptor, name, descriptor, expected, canonical_path,
        )
        self.owned_fds.add(descriptor)

    def bind_absence(self, label: str, parent_descriptor: int, name: str) -> None:
        if label in self.bindings or label in self.absence_bindings:
            raise RotationProvenanceError("duplicate namespace binding")
        if _stat_at_optional(parent_descriptor, name) is not None:
            raise RotationProvenanceError("expected pathname is present")
        self.absence_bindings[label] = (parent_descriptor, name)

    def ensure_absence(self, label: str, parent_descriptor: int, name: str) -> None:
        existing = self.absence_bindings.get(label)
        if existing is not None:
            if existing != (parent_descriptor, name):
                raise RotationProvenanceError("absence binding target drift")
            if _stat_at_optional(parent_descriptor, name) is not None:
                raise RotationProvenanceError("expected pathname appeared")
            return
        self.bind_absence(label, parent_descriptor, name)

    def unbind_absence(self, label: str) -> None:
        self.absence_bindings.pop(label, None)

    def move_binding(
        self,
        label: str,
        parent_descriptor: int,
        name: str,
        expected: dict,
        canonical_path: Path,
    ) -> None:
        _, _, descriptor, _, _ = self.bindings[label]
        self.bindings[label] = (
            parent_descriptor, name, descriptor, expected, canonical_path,
        )

    def unbind(self, label: str, *, close: bool = False) -> Optional[int]:
        binding = self.bindings.pop(label, None)
        if binding is None:
            return None
        descriptor = binding[2]
        if close:
            self.owned_fds.discard(descriptor)
            os.close(descriptor)
            return None
        return descriptor

    def barrier(self, label: str) -> None:
        if self.barrier_trace is not None:
            self.barrier_trace.append(label)
        if self.barrier_hook is not None:
            self.barrier_hook(label)
        self.revalidate()

    def set_state_allowlist(self, allowed: Set[str]) -> None:
        self.state_allowlist = set(allowed)
        self.assert_state_allowlist()

    def assert_state_allowlist(self) -> None:
        if self.state_allowlist is None:
            return
        names = set(os.listdir(self.state_fd))
        if not names.issubset(self.state_allowlist):
            raise RotationProvenanceError("ambiguous state directory residue")

    def revalidate(self) -> None:
        parent_path = os.lstat(self.state_dir.parent)
        parent_held = os.fstat(self.parent_fd)
        if not stat.S_ISDIR(parent_path.st_mode) or (
            parent_path.st_dev, parent_path.st_ino
        ) != (parent_held.st_dev, parent_held.st_ino):
            raise RotationProvenanceError("state parent pathname drift")
        external = (
            (
                self.authority_path,
                self.anchor_fd,
                self.authority_path,
                self.anchor_identity,
            ),
            (
                self.checker_path,
                self.checker_fd,
                self.checker_path,
                self.authority["checker"],
            ),
            (self.config_path, self.config_fd, self.config_path, self.authority["config"]),
            (
                self.logrotate_path,
                self.logrotate_fd,
                self.logrotate_path,
                self.authority["logrotate"],
            ),
        )
        for path, descriptor, canonical_path, expected in external:
            path_value = os.lstat(path)
            held = os.fstat(descriptor)
            if (path_value.st_dev, path_value.st_ino) != (held.st_dev, held.st_ino):
                raise RotationProvenanceError("external authority pathname drift")
            current = _fd_regular_identity(descriptor, canonical_path)
            if not _identity_fields_match(current, expected):
                raise RotationProvenanceError("external authority content drift")
        _require_canonical_fd(
            self.parent_fd,
            self.state_dir.name,
            self.state_fd,
            self.directory_identity,
            self.state_dir,
        )
        ledger_expected = dict(self.authority["provenance"])
        ledger_expected.pop("genesis_record_sha256")
        ledger_current = _require_canonical_fd(
            self.state_fd,
            ROTATION_LEDGER_NAME,
            self.ledger_fd,
            ledger_expected,
            self.state_dir / ROTATION_LEDGER_NAME,
        )
        if ledger_current["size"] != self.ledger_size:
            raise RotationProvenanceError("ledger tracked size drift")
        if ledger_current["sha256"] != self.ledger_sha256:
            raise RotationProvenanceError("ledger tracked content drift")
        for parent, name, descriptor, expected, canonical_path in self.bindings.values():
            _require_canonical_fd(parent, name, descriptor, expected, canonical_path)
        for parent, name in self.absence_bindings.values():
            if _stat_at_optional(parent, name) is not None:
                raise RotationProvenanceError("phase-bound pathname appeared")
        self.assert_state_allowlist()

    def read_records(self, *, repair_partial_tail: bool) -> Tuple[bytes, List[dict]]:
        payload = _pread_all(self.ledger_fd)
        if len(payload) != self.ledger_size or not payload:
            raise RotationProvenanceError("ledger read size drift")
        if payload != self.ledger_payload \
                or hashlib.sha256(payload).hexdigest() != self.ledger_sha256:
            raise RotationProvenanceError("ledger read content drift")
        if not payload.endswith(b"\n"):
            if not repair_partial_tail or not self.exclusive:
                raise RotationProvenanceError("partial ledger tail")
            last_complete = payload.rfind(b"\n") + 1
            if last_complete <= 0:
                raise RotationProvenanceError("missing complete ledger record")
            prefix = payload[:last_complete]
            try:
                prefix_records = [json.loads(line) for line in prefix.splitlines()]
            except (UnicodeError, json.JSONDecodeError) as error:
                raise RotationProvenanceError("invalid complete ledger prefix") from error
            _validate_records(
                self.state_dir,
                self.operation_id,
                os.fstat(self.ledger_fd),
                prefix_records,
                self.directory_identity,
            )
            self.barrier("B1-tail-repair-pre")
            os.ftruncate(self.ledger_fd, last_complete)
            os.fsync(self.ledger_fd)
            if _pread_all(self.ledger_fd) != prefix:
                raise RotationProvenanceError("ledger tail repair bytes mismatch")
            self.ledger_payload = prefix
            self.ledger_size = last_complete
            self.ledger_sha256 = hashlib.sha256(prefix).hexdigest()
            self.barrier("B1-tail-repair-post")
            payload = prefix
        try:
            records = [json.loads(line) for line in payload.splitlines()]
        except (UnicodeError, json.JSONDecodeError) as error:
            raise RotationProvenanceError("invalid ledger JSON") from error
        return payload, records

    def append_record(self, record: dict) -> dict:
        if os.fstat(self.ledger_fd).st_size != self.ledger_size:
            raise RotationProvenanceError("ledger changed before append")
        if _pread_all(self.ledger_fd) != self.ledger_payload:
            raise RotationProvenanceError("ledger prefix changed before append")
        complete = _record_with_hash(record)
        payload = _canonical_json(complete) + b"\n"
        expected_payload = self.ledger_payload + payload
        os.lseek(self.ledger_fd, 0, os.SEEK_END)
        _write_all(self.ledger_fd, payload)
        os.fsync(self.ledger_fd)
        observed_payload = _pread_all(self.ledger_fd)
        if observed_payload != expected_payload:
            raise RotationProvenanceError("ledger append bytes mismatch")
        self.ledger_payload = expected_payload
        self.ledger_size = len(expected_payload)
        if os.fstat(self.ledger_fd).st_size != self.ledger_size:
            raise RotationProvenanceError("ledger append size mismatch")
        self.ledger_sha256 = hashlib.sha256(expected_payload).hexdigest()
        return complete


def _renameat_no_replace(
    source_parent: int,
    source_name: str,
    destination_parent: int,
    destination_name: str,
) -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    source_bytes = os.fsencode(source_name)
    destination_bytes = os.fsencode(destination_name)
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is not None:
        renameat2.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        renameat2.restype = ctypes.c_int
        result = renameat2(
            source_parent,
            source_bytes,
            destination_parent,
            destination_bytes,
            RENAME_NOREPLACE,
        )
    else:
        renameatx_np = getattr(libc, "renameatx_np", None)
        if renameatx_np is None:
            raise RotationProvenanceError("atomic dirfd no-replace rename unavailable")
        renameatx_np.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        renameatx_np.restype = ctypes.c_int
        result = renameatx_np(
            source_parent,
            source_bytes,
            destination_parent,
            destination_bytes,
            0x00000004,
        )
    if result != 0:
        error = ctypes.get_errno()
        raise RotationProvenanceError(
            f"atomic no-replace rename failed: {errno.errorcode.get(error, error)}"
        )


def _rename_exact_no_replace(
    source_parent: int,
    source_name: str,
    held_descriptor: int,
    expected: dict,
    destination_parent: int,
    destination_name: str,
    pre_syscall_hook: Optional[Callable[[], None]] = None,
) -> None:
    def restore_destination_to_source() -> None:
        current_source = _stat_at_optional(source_parent, source_name)
        current_destination = _stat_at_optional(destination_parent, destination_name)
        if current_source is None and current_destination is not None:
            try:
                _renameat_no_replace(
                    destination_parent,
                    destination_name,
                    source_parent,
                    source_name,
                )
                os.fsync(destination_parent)
                if source_parent != destination_parent:
                    os.fsync(source_parent)
            except RotationProvenanceError:
                pass

    canonical_source = Path(expected["path"])
    _require_canonical_fd(
        source_parent,
        source_name,
        held_descriptor,
        expected,
        canonical_source,
    )
    if _stat_at_optional(destination_parent, destination_name) is not None:
        raise RotationProvenanceError("rename destination already exists")
    if pre_syscall_hook is not None:
        pre_syscall_hook()
    _renameat_no_replace(
        source_parent, source_name, destination_parent, destination_name
    )
    destination = _stat_at_optional(destination_parent, destination_name)
    source = _stat_at_optional(source_parent, source_name)
    held = os.fstat(held_descriptor)
    try:
        if stat.S_ISREG(held.st_mode):
            held_identity = _fd_regular_identity(held_descriptor, canonical_source)
        elif stat.S_ISDIR(held.st_mode):
            held_identity = _fd_directory_identity(held_descriptor, canonical_source)
        else:
            raise RotationProvenanceError("unsupported renamed inode type")
        held_matches_expected = _identity_fields_match(held_identity, expected)
    except (OSError, RotationProvenanceError):
        held_matches_expected = False
    if source is not None or destination is None or (
        destination.st_dev, destination.st_ino
    ) != (held.st_dev, held.st_ino) or not held_matches_expected:
        # Preserve or restore the proven inode whenever the namespace still
        # permits an exact no-replace rollback.
        restore_destination_to_source()
        raise RotationProvenanceError("rename postcondition drift")
    os.fsync(source_parent)
    if destination_parent != source_parent:
        os.fsync(destination_parent)
    final_held = os.fstat(held_descriptor)
    try:
        if stat.S_ISREG(final_held.st_mode):
            final_identity = _fd_regular_identity(held_descriptor, canonical_source)
        elif stat.S_ISDIR(final_held.st_mode):
            final_identity = _fd_directory_identity(held_descriptor, canonical_source)
        else:
            raise RotationProvenanceError("unsupported renamed inode type")
        final_identity_matches = _identity_fields_match(final_identity, expected)
    except (OSError, RotationProvenanceError):
        final_identity_matches = False
    final_source = _stat_at_optional(source_parent, source_name)
    final_destination = _stat_at_optional(destination_parent, destination_name)
    if final_source is not None or final_destination is None or (
        final_destination.st_dev,
        final_destination.st_ino,
    ) != (final_held.st_dev, final_held.st_ino) or not final_identity_matches:
        restore_destination_to_source()
        raise RotationProvenanceError("rename final namespace drift")


def _unlink_exact(
    parent_descriptor: int,
    name: str,
    held_descriptor: int,
    expected: dict,
) -> None:
    _require_canonical_fd(
        parent_descriptor, name, held_descriptor, expected, Path(expected["path"])
    )
    before = os.fstat(held_descriptor)
    os.unlink(name, dir_fd=parent_descriptor)
    if _stat_at_optional(parent_descriptor, name) is not None:
        raise RotationProvenanceError("unlink pathname remained")
    after = os.fstat(held_descriptor)
    if after.st_nlink >= before.st_nlink:
        raise RotationProvenanceError("unlink removed an unproven inode")
    os.fsync(parent_descriptor)


def _rmdir_exact(
    parent_descriptor: int,
    name: str,
    held_descriptor: int,
    expected: dict,
) -> None:
    _require_canonical_fd(
        parent_descriptor, name, held_descriptor, expected, Path(expected["path"])
    )
    before = os.fstat(held_descriptor)
    os.rmdir(name, dir_fd=parent_descriptor)
    if _stat_at_optional(parent_descriptor, name) is not None:
        raise RotationProvenanceError("rmdir pathname remained")
    after = os.fstat(held_descriptor)
    if sys.platform.startswith("linux") and after.st_nlink >= before.st_nlink:
        raise RotationProvenanceError("rmdir removed an unproven inode")
    os.fsync(parent_descriptor)


def _identity_at_path(expected: dict, canonical_path: Path) -> dict:
    result = dict(expected)
    result["path"] = str(canonical_path)
    return result


def _open_bound_regular(
    context: RotationContext,
    label: str,
    parent_descriptor: int,
    name: str,
    canonical_path: Path,
    expected: dict,
    *,
    writable: bool = False,
) -> Tuple[int, dict]:
    descriptor, identity = _open_regular_at(
        parent_descriptor,
        name,
        canonical_path,
        expected,
        writable=writable,
    )
    context.bind(
        label,
        parent_descriptor,
        name,
        descriptor,
        expected,
        canonical_path,
    )
    return descriptor, identity


def _open_bound_directory(
    context: RotationContext,
    label: str,
    parent_descriptor: int,
    name: str,
    canonical_path: Path,
    expected: dict,
) -> Tuple[int, dict]:
    descriptor, identity = _open_directory_at(
        parent_descriptor, name, canonical_path, expected
    )
    context.bind(
        label,
        parent_descriptor,
        name,
        descriptor,
        expected,
        canonical_path,
    )
    return descriptor, identity


def _create_candidate_from_status_fd(
    context: RotationContext,
    workspace_descriptor: int,
    workspace_path: Path,
    status_descriptor: Optional[int],
    expected_status: Optional[dict],
    copy_hook: Optional[Callable[[], None]] = None,
) -> Tuple[int, dict]:
    candidate_path = workspace_path / ROTATION_STATUS_NAME
    if status_descriptor is None:
        if expected_status is not None:
            raise RotationProvenanceError("missing authorized old status descriptor")
        source_payload = b""
        expected_sha256 = hashlib.sha256(b"").hexdigest()
        expected_size = 0
    else:
        if expected_status is None:
            raise RotationProvenanceError("unexpected old status descriptor")
        status_binding = context.bindings.get("status")
        if status_binding is None or status_binding[2] != status_descriptor:
            raise RotationProvenanceError("old status descriptor is not bound")
        status_path = context.state_dir / ROTATION_STATUS_NAME
        status_expected = _identity_at_path(expected_status, status_path)
        _require_canonical_fd(
            context.state_fd,
            ROTATION_STATUS_NAME,
            status_descriptor,
            status_expected,
            status_path,
        )
        if copy_hook is not None:
            copy_hook()
        source_payload = _pread_all(status_descriptor)
        expected_sha256 = expected_status["sha256"]
        expected_size = expected_status["size"]
    descriptor = os.open(
        ROTATION_STATUS_NAME,
        os.O_RDWR | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
        0o600,
        dir_fd=workspace_descriptor,
    )
    try:
        _write_all(descriptor, source_payload)
        os.fchmod(descriptor, 0o600)
        os.fsync(descriptor)
        os.fsync(workspace_descriptor)
        identity = _fd_regular_identity(descriptor, candidate_path)
        if status_descriptor is not None:
            _require_canonical_fd(
                context.state_fd,
                ROTATION_STATUS_NAME,
                status_descriptor,
                status_expected,
                context.state_dir / ROTATION_STATUS_NAME,
            )
        if identity["sha256"] != expected_sha256 or identity["size"] != expected_size:
            raise RotationProvenanceError("candidate copy content mismatch")
        if identity["uid"] != os.geteuid() or identity["gid"] != os.getegid() \
                or identity["mode"] != "600":
            raise RotationProvenanceError("candidate copy metadata drift")
        current = _stat_at_optional(workspace_descriptor, ROTATION_STATUS_NAME)
        if current is None or (current.st_dev, current.st_ino) != (
            identity["dev"], identity["ino"],
        ):
            raise RotationProvenanceError("candidate changed while copied")
        context.bind(
            "candidate",
            workspace_descriptor,
            ROTATION_STATUS_NAME,
            descriptor,
            identity,
            candidate_path,
        )
        return descriptor, identity
    except Exception:
        os.close(descriptor)
        raise


def _fd_runtime_path(descriptor: int) -> str:
    if os.path.isdir("/proc/self/fd"):
        return f"/proc/self/fd/{descriptor}"
    # Darwin test hosts expose the same descriptor semantics through /dev/fd.
    if os.path.isdir("/dev/fd"):
        return f"/dev/fd/{descriptor}"
    raise RotationProvenanceError("descriptor execution namespace unavailable")


def _kill_process_group(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        return
    except PermissionError as error:
        raise RotationProvenanceError("cannot terminate logrotate process group") from error
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired as error:
        raise RotationProvenanceError("logrotate process group did not terminate") from error


def _run_logrotate_fd_isolated(
    context: RotationContext,
    workspace_descriptor: int,
    candidate_descriptor: int,
    *,
    timeout: float,
    child_spawn_hook: Optional[Callable[[], None]] = None,
) -> None:
    executable = _fd_runtime_path(context.logrotate_fd)
    candidate = f"{_fd_runtime_path(workspace_descriptor)}/{ROTATION_STATUS_NAME}"
    config = _fd_runtime_path(context.config_fd)
    if child_spawn_hook is not None:
        child_spawn_hook()
    if executable.startswith("/proc/self/fd/"):
        command = [executable, "-s", candidate, config]
        process_executable = executable
    else:
        # Darwin's fdesc filesystem is readable but not executable.  Unit-test
        # logrotate fixtures are Python scripts, so execute the already-held
        # script FD through the current interpreter without reopening its path.
        if not _pread_all(context.logrotate_fd).startswith(b"#!"):
            raise RotationProvenanceError("non-Linux executable FD unsupported")
        process_executable = sys.executable
        candidate = f"fd:{candidate_descriptor}"
        command = [sys.executable, executable, "-s", candidate, config]
    process = subprocess.Popen(
        command,
        executable=process_executable,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        pass_fds=(
            context.logrotate_fd,
            context.config_fd,
            workspace_descriptor,
            candidate_descriptor,
        ),
    )
    timed_out = False
    try:
        returncode = process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        _kill_process_group(process)
        returncode = process.returncode
    descendants_remained = False
    try:
        os.killpg(process.pid, 0)
        descendants_remained = True
    except ProcessLookupError:
        pass
    except PermissionError as error:
        raise RotationProvenanceError("cannot inspect logrotate process group") from error
    if descendants_remained:
        _kill_process_group(process)
    if timed_out:
        raise RotationProvenanceError("logrotate timed out")
    if returncode != 0:
        raise RotationProvenanceError("logrotate failed")
    if descendants_remained:
        raise RotationProvenanceError("logrotate left a live child process")


def _probe_regular_state(
    context: RotationContext,
    label: str,
    parent_descriptor: int,
    name: str,
    canonical_path: Path,
    possibilities: Dict[str, dict],
) -> Tuple[str, Optional[int], Optional[dict]]:
    current = _stat_at_optional(parent_descriptor, name)
    if current is None:
        return "absent", None, None
    descriptor, identity = _open_regular_at(
        parent_descriptor, name, canonical_path, writable=True
    )
    for state_name, expected in possibilities.items():
        adjusted = _identity_at_path(expected, canonical_path)
        if _identity_fields_match(identity, adjusted):
            context.bind(
                label,
                parent_descriptor,
                name,
                descriptor,
                adjusted,
                canonical_path,
            )
            return state_name, descriptor, adjusted
    os.close(descriptor)
    raise RotationProvenanceError("captured recovery inode ambiguity")


def _workspace_names(record: dict) -> Tuple[str, str]:
    workspace_name = Path(record["workspace"]["path"]).name
    tombstone = (
        f".cleanup-{workspace_name}-{record['workspace']['dev']}-"
        f"{record['workspace']['ino']}"
    )
    return workspace_name, tombstone


def _phase_state_allowlist(record: dict) -> Set[str]:
    phase = record.get("phase")
    allowed = {ROTATION_LEDGER_NAME}
    if phase == "committed":
        if record.get("new_status") is not None:
            allowed.add(ROTATION_STATUS_NAME)
        if record.get("workspace") is not None:
            workspace_name, tombstone = _workspace_names(record)
            allowed.update((workspace_name, tombstone))
    elif phase == "prepared":
        if record.get("old_status") is not None:
            allowed.add(ROTATION_STATUS_NAME)
        workspace_name, _ = _workspace_names(record)
        allowed.add(workspace_name)
    elif phase == "captured":
        # Captured recovery accepts only C0/C1/C2.  The canonical status can
        # therefore be old, absent, or new while the active workspace remains.
        allowed.add(ROTATION_STATUS_NAME)
        workspace_name, _ = _workspace_names(record)
        allowed.add(workspace_name)
    else:
        raise RotationProvenanceError("unknown rotation phase")
    return allowed


def _committed_final_state_names(record: dict) -> Set[str]:
    names = {ROTATION_LEDGER_NAME}
    if record.get("new_status") is not None:
        names.add(ROTATION_STATUS_NAME)
    return names


def _assert_committed_namespace(
    context: RotationContext,
    record: dict,
) -> None:
    expected_status = record.get("new_status")
    if expected_status is None:
        if _stat_at_optional(context.state_fd, ROTATION_STATUS_NAME) is not None:
            raise RotationProvenanceError("unexpected committed status")
    else:
        binding = context.bindings.get("status")
        if binding is None:
            raise RotationProvenanceError("missing committed status binding")
        status_path = context.state_dir / ROTATION_STATUS_NAME
        status_expected = _identity_at_path(expected_status, status_path)
        _require_canonical_fd(
            context.state_fd,
            ROTATION_STATUS_NAME,
            binding[2],
            status_expected,
            status_path,
        )
    workspace = record.get("workspace")
    if workspace is not None:
        workspace_name, tombstone = _workspace_names(record)
        if _stat_at_optional(context.state_fd, workspace_name) is not None \
                or _stat_at_optional(context.state_fd, tombstone) is not None:
            raise RotationProvenanceError("committed workspace residue")
    if set(os.listdir(context.state_fd)) != _committed_final_state_names(record):
        raise RotationProvenanceError("ambiguous state directory residue")


def _cleanup_committed_workspace_fd(
    context: RotationContext,
    record: dict,
    fault_after_phase: Optional[str],
) -> bool:
    workspace_expected = record.get("workspace")
    if workspace_expected is None:
        return False
    workspace_name, workspace_tombstone = _workspace_names(record)
    active_exists = _stat_at_optional(context.state_fd, workspace_name) is not None
    tombstone_exists = _stat_at_optional(context.state_fd, workspace_tombstone) is not None
    if active_exists and tombstone_exists:
        raise RotationProvenanceError("ambiguous committed workspace cleanup")
    if not active_exists and not tombstone_exists:
        return False
    active_name = workspace_name if active_exists else workspace_tombstone
    active_path = context.state_dir / active_name
    workspace_at_active = _identity_at_path(workspace_expected, active_path)
    if "workspace" in context.bindings:
        workspace_fd = context.bindings["workspace"][2]
        context.move_binding(
            "workspace",
            context.state_fd,
            active_name,
            workspace_at_active,
            active_path,
        )
        _require_canonical_fd(
            context.state_fd,
            active_name,
            workspace_fd,
            workspace_at_active,
            active_path,
        )
    else:
        workspace_fd, _ = _open_bound_directory(
            context,
            "workspace",
            context.state_fd,
            active_name,
            active_path,
            workspace_at_active,
        )
    if not active_exists:
        context.ensure_absence(
            "workspace_source", context.state_fd, workspace_name
        )
        tombstone_allowlist = _phase_state_allowlist(record)
        tombstone_allowlist.discard(workspace_name)
        context.set_state_allowlist(tombstone_allowlist)
    old_status = record.get("old_status")
    previous_name = "previous-status"
    previous_tombstone: Optional[str] = None
    if old_status is not None:
        previous_tombstone = (
            f".cleanup-previous-{old_status['dev']}-{old_status['ino']}"
        )
        previous_exists = _stat_at_optional(workspace_fd, previous_name) is not None
        previous_tombstone_exists = (
            _stat_at_optional(workspace_fd, previous_tombstone) is not None
        )
        if previous_exists and previous_tombstone_exists:
            raise RotationProvenanceError("ambiguous previous-status cleanup")
        if previous_exists or previous_tombstone_exists:
            held_name = previous_name if previous_exists else previous_tombstone
            held_path = active_path / held_name
            held_expected = _identity_at_path(old_status, held_path)
            if "previous" in context.bindings:
                previous_fd = context.bindings["previous"][2]
                context.move_binding(
                    "previous", workspace_fd, held_name, held_expected, held_path
                )
                _require_canonical_fd(
                    workspace_fd,
                    held_name,
                    previous_fd,
                    held_expected,
                    held_path,
                )
            else:
                previous_fd, _ = _open_bound_regular(
                    context,
                    "previous",
                    workspace_fd,
                    held_name,
                    held_path,
                    held_expected,
                )
            if previous_exists:
                context.barrier("B9-previous-rename-pre")
                _rename_exact_no_replace(
                    workspace_fd,
                    previous_name,
                    previous_fd,
                    held_expected,
                    workspace_fd,
                    previous_tombstone,
                )
                held_path = active_path / previous_tombstone
                held_expected = _identity_at_path(old_status, held_path)
                context.move_binding(
                    "previous",
                    workspace_fd,
                    previous_tombstone,
                    held_expected,
                    held_path,
                )
            context.ensure_absence(
                "previous_source", workspace_fd, previous_name
            )
            if previous_exists:
                context.barrier("B9-previous-rename-post")
                if fault_after_phase == "after-previous-tombstone":
                    raise RotationProvenanceError("injected cleanup crash")
            context.barrier("B9-previous-unlink-pre")
            _unlink_exact(
                workspace_fd,
                previous_tombstone,
                previous_fd,
                held_expected,
            )
            context.unbind("previous", close=True)
            context.bind_absence("previous", workspace_fd, previous_tombstone)
            context.barrier("B9-previous-unlink-post")
        else:
            context.ensure_absence("previous", workspace_fd, previous_name)
            context.ensure_absence(
                "previous_source", workspace_fd, previous_name
            )
    else:
        context.ensure_absence("previous", workspace_fd, previous_name)
        context.ensure_absence("previous_source", workspace_fd, previous_name)
    if _stat_at_optional(workspace_fd, ROTATION_STATUS_NAME) is not None:
        raise RotationProvenanceError("unexpected committed candidate")
    context.ensure_absence("candidate", workspace_fd, ROTATION_STATUS_NAME)
    if os.listdir(workspace_fd):
        raise RotationProvenanceError("unknown workspace residue")
    if active_exists:
        context.barrier("B9-workspace-rename-pre")
        _rename_exact_no_replace(
            context.state_fd,
            workspace_name,
            workspace_fd,
            workspace_at_active,
            context.state_fd,
            workspace_tombstone,
        )
        active_name = workspace_tombstone
        active_path = context.state_dir / active_name
        workspace_at_active = _identity_at_path(workspace_expected, active_path)
        context.move_binding(
            "workspace",
            context.state_fd,
            active_name,
            workspace_at_active,
            active_path,
        )
        context.bind_absence(
            "workspace_source", context.state_fd, workspace_name
        )
        tombstone_allowlist = _phase_state_allowlist(record)
        tombstone_allowlist.discard(workspace_name)
        context.set_state_allowlist(tombstone_allowlist)
        context.barrier("B9-workspace-rename-post")
        if fault_after_phase == "after-workspace-tombstone":
            raise RotationProvenanceError("injected cleanup crash")
    if os.listdir(workspace_fd):
        raise RotationProvenanceError("workspace tombstone is not empty")
    context.barrier("B9-workspace-rmdir-pre")
    _rmdir_exact(
        context.state_fd,
        active_name,
        workspace_fd,
        workspace_at_active,
    )
    context.unbind_absence("candidate")
    context.unbind_absence("previous")
    context.unbind_absence("previous_source")
    context.unbind("workspace", close=True)
    context.bind_absence("workspace", context.state_fd, active_name)
    context.set_state_allowlist(_committed_final_state_names(record))
    context.barrier("B9-workspace-rmdir-post")
    _assert_committed_namespace(context, record)
    return True


def _snapshot_from_context(
    context: RotationContext,
    records: List[dict],
) -> dict:
    tail = records[-1]
    if tail.get("phase") != "committed":
        raise RotationProvenanceError("uncommitted ledger tail")
    expected_status = tail.get("new_status")
    status_identity: Optional[dict]
    if expected_status is None:
        if _stat_at_optional(context.state_fd, ROTATION_STATUS_NAME) is not None:
            raise RotationProvenanceError("unexpected status")
        status_identity = None
    else:
        status_path = context.state_dir / ROTATION_STATUS_NAME
        status_at_path = _identity_at_path(expected_status, status_path)
        if "status" not in context.bindings:
            _, status_identity = _open_bound_regular(
                context,
                "status",
                context.state_fd,
                ROTATION_STATUS_NAME,
                status_path,
                status_at_path,
            )
        else:
            status_identity = _require_canonical_fd(
                context.state_fd,
                ROTATION_STATUS_NAME,
                context.bindings["status"][2],
                status_at_path,
                status_path,
            )
    context.barrier("B10-snapshot")
    _assert_committed_namespace(context, tail)
    payload = _pread_all(context.ledger_fd)
    if len(payload) != context.ledger_size:
        raise RotationProvenanceError("snapshot ledger size drift")
    if payload != context.ledger_payload \
            or hashlib.sha256(payload).hexdigest() != context.ledger_sha256:
        raise RotationProvenanceError("snapshot ledger content drift")
    ledger_value = os.fstat(context.ledger_fd)
    snapshot = {
        "generation": tail["generation"],
        "tail_record_sha256": tail["record_sha256"],
        "ledger": {
            "path": str(context.state_dir / ROTATION_LEDGER_NAME),
            "sha256": hashlib.sha256(payload).hexdigest(),
            "size": len(payload),
            "uid": ledger_value.st_uid,
            "gid": ledger_value.st_gid,
            "mode": _mode(ledger_value),
            "dev": ledger_value.st_dev,
            "ino": ledger_value.st_ino,
        },
        "status": status_identity,
    }
    context.revalidate()
    _assert_committed_namespace(context, tail)
    return snapshot


def _validate_context_ledger(
    context: RotationContext,
    records: List[dict],
) -> None:
    _validate_records(
        context.state_dir,
        context.operation_id,
        os.fstat(context.ledger_fd),
        records,
        context.directory_identity,
    )
    genesis = records[0]
    provenance = context.authority["provenance"]
    for key in ("path", "uid", "gid", "mode", "dev", "ino"):
        if provenance[key] != genesis["ledger"][key]:
            raise RotationProvenanceError(f"authority genesis identity drift: {key}")
    if provenance["genesis_record_sha256"] != genesis["record_sha256"]:
        raise RotationProvenanceError("authority genesis hash drift")


def validate_rotation_authority(
    *,
    state_dir: Path,
    operation_id: str,
    authority_path: Path,
    anchor_expected: dict,
    checker_path: Path,
    checker_expected: dict,
    config_path: Path,
    config_expected: dict,
    logrotate_path: Path,
    logrotate_expected: dict,
) -> dict:
    with RotationContext(
        state_dir=state_dir,
        operation_id=operation_id,
        authority_path=authority_path,
        anchor_expected=anchor_expected,
        checker_path=checker_path,
        checker_expected=checker_expected,
        config_path=config_path,
        config_expected=config_expected,
        logrotate_path=logrotate_path,
        logrotate_expected=logrotate_expected,
        exclusive=False,
    ) as context:
        return dict(context.authority)


def _ensure_workspace_binding(
    context: RotationContext,
    workspace_expected: dict,
) -> Tuple[int, Path]:
    workspace_path = Path(workspace_expected["path"])
    if workspace_path.parent != context.state_dir \
            or not re.fullmatch(r"generation-[0-9]{20}", workspace_path.name):
        raise RotationProvenanceError("workspace path drift")
    if "workspace" in context.bindings:
        descriptor = context.bindings["workspace"][2]
        _require_canonical_fd(
            context.state_fd,
            workspace_path.name,
            descriptor,
            workspace_expected,
            workspace_path,
        )
        return descriptor, workspace_path
    descriptor, _ = _open_bound_directory(
        context,
        "workspace",
        context.state_fd,
        workspace_path.name,
        workspace_path,
        workspace_expected,
    )
    return descriptor, workspace_path


def _open_committed_status(
    context: RotationContext,
    expected_status: Optional[dict],
) -> Optional[int]:
    if expected_status is None:
        if _stat_at_optional(context.state_fd, ROTATION_STATUS_NAME) is not None:
            raise RotationProvenanceError("unexpected status")
        context.ensure_absence("status", context.state_fd, ROTATION_STATUS_NAME)
        return None
    status_path = context.state_dir / ROTATION_STATUS_NAME
    status_at_path = _identity_at_path(expected_status, status_path)
    descriptor, _ = _open_bound_regular(
        context,
        "status",
        context.state_fd,
        ROTATION_STATUS_NAME,
        status_path,
        status_at_path,
    )
    return descriptor


def _ensure_prepared_phase_bindings(
    context: RotationContext,
    workspace_descriptor: int,
    workspace_path: Path,
    old_status: Optional[dict],
) -> Optional[int]:
    if old_status is None:
        if "status" in context.bindings:
            raise RotationProvenanceError("unexpected prepared status binding")
        context.ensure_absence("status", context.state_fd, ROTATION_STATUS_NAME)
        status_descriptor = None
    else:
        if "status" in context.absence_bindings:
            raise RotationProvenanceError("prepared status unexpectedly absent")
        status_path = context.state_dir / ROTATION_STATUS_NAME
        status_expected = _identity_at_path(old_status, status_path)
        if "status" in context.bindings:
            status_descriptor = context.bindings["status"][2]
            _require_canonical_fd(
                context.state_fd,
                ROTATION_STATUS_NAME,
                status_descriptor,
                status_expected,
                status_path,
            )
        else:
            status_descriptor, _ = _open_bound_regular(
                context,
                "status",
                context.state_fd,
                ROTATION_STATUS_NAME,
                status_path,
                status_expected,
            )
    context.ensure_absence("previous", workspace_descriptor, "previous-status")
    return status_descriptor


def _relabel_binding(
    context: RotationContext,
    old_label: str,
    new_label: str,
    parent_descriptor: int,
    name: str,
    expected: dict,
    canonical_path: Path,
) -> int:
    descriptor = context.unbind(old_label)
    if descriptor is None:
        raise RotationProvenanceError("missing descriptor binding")
    context.bind(
        new_label,
        parent_descriptor,
        name,
        descriptor,
        expected,
        canonical_path,
    )
    return descriptor


def _captured_recovery_state(
    context: RotationContext,
    workspace_descriptor: int,
    workspace_path: Path,
    old_status: Optional[dict],
    candidate_expected: dict,
) -> str:
    status_path = context.state_dir / ROTATION_STATUS_NAME
    previous_path = workspace_path / "previous-status"
    candidate_path = workspace_path / ROTATION_STATUS_NAME
    status_possibilities: Dict[str, dict] = {
        "new": _identity_at_path(candidate_expected, status_path),
    }
    if old_status is not None:
        status_possibilities["old"] = _identity_at_path(old_status, status_path)
    if "status" in context.bindings:
        status_fd = context.bindings["status"][2]
        status_identity = _fd_regular_identity(status_fd, status_path)
        status_state = next(
            (
                state_name
                for state_name, expected in status_possibilities.items()
                if _identity_fields_match(status_identity, expected)
            ),
            None,
        )
        if status_state is None:
            raise RotationProvenanceError("captured status binding ambiguity")
    elif "status" in context.absence_bindings:
        context.ensure_absence("status", context.state_fd, ROTATION_STATUS_NAME)
        status_state = "absent"
    else:
        status_state, _, _ = _probe_regular_state(
            context,
            "status",
            context.state_fd,
            ROTATION_STATUS_NAME,
            status_path,
            status_possibilities,
        )
        if status_state == "absent":
            context.bind_absence("status", context.state_fd, ROTATION_STATUS_NAME)
    if old_status is None:
        context.ensure_absence("previous", workspace_descriptor, "previous-status")
        previous_state = "absent"
    elif "previous" in context.bindings:
        previous_fd = context.bindings["previous"][2]
        previous_expected = _identity_at_path(old_status, previous_path)
        _require_canonical_fd(
            workspace_descriptor,
            "previous-status",
            previous_fd,
            previous_expected,
            previous_path,
        )
        previous_state = "old"
    elif "previous" in context.absence_bindings:
        context.ensure_absence("previous", workspace_descriptor, "previous-status")
        previous_state = "absent"
    else:
        previous_state, _, _ = _probe_regular_state(
            context,
            "previous",
            workspace_descriptor,
            "previous-status",
            previous_path,
            {"old": _identity_at_path(old_status, previous_path)},
        )
        if previous_state == "absent":
            context.bind_absence("previous", workspace_descriptor, "previous-status")
    if "candidate" in context.bindings:
        candidate_fd = context.bindings["candidate"][2]
        candidate_at_path = _identity_at_path(candidate_expected, candidate_path)
        _require_canonical_fd(
            workspace_descriptor,
            ROTATION_STATUS_NAME,
            candidate_fd,
            candidate_at_path,
            candidate_path,
        )
        candidate_state = "new"
    elif "candidate" in context.absence_bindings:
        context.ensure_absence(
            "candidate", workspace_descriptor, ROTATION_STATUS_NAME
        )
        candidate_state = "absent"
    else:
        candidate_state, _, _ = _probe_regular_state(
            context,
            "candidate",
            workspace_descriptor,
            ROTATION_STATUS_NAME,
            candidate_path,
            {"new": _identity_at_path(candidate_expected, candidate_path)},
        )
        if candidate_state == "absent":
            context.bind_absence(
                "candidate", workspace_descriptor, ROTATION_STATUS_NAME
            )
    c0 = (
        (status_state == "old" if old_status is not None else status_state == "absent")
        and previous_state == "absent"
        and candidate_state == "new"
    )
    c1 = (
        old_status is not None
        and status_state == "absent"
        and previous_state == "old"
        and candidate_state == "new"
    )
    c2 = (
        status_state == "new"
        and candidate_state == "absent"
        and (previous_state == "old" if old_status is not None else previous_state == "absent")
    )
    matches = [name for name, matches_state in (("C0", c0), ("C1", c1), ("C2", c2)) if matches_state]
    if len(matches) != 1:
        raise RotationProvenanceError("captured CAS state is ambiguous")
    return matches[0]


def run_rotation_wrapper(
    *,
    state_dir: Path,
    operation_id: str,
    authority_path: Path,
    anchor_expected: dict,
    checker_path: Path,
    checker_expected: dict,
    config: Path,
    config_expected: dict,
    logrotate: Path,
    logrotate_expected: dict,
    lock_path: Optional[Path] = None,
    fault_after_phase: Optional[str] = None,
    recover_only: bool = False,
    barrier_hook: Optional[Callable[[str], None]] = None,
    barrier_trace: Optional[List[str]] = None,
    child_spawn_hook: Optional[Callable[[], None]] = None,
    candidate_copy_hook: Optional[Callable[[], None]] = None,
    candidate_cas_hook: Optional[Callable[[], None]] = None,
    old_status_cas_hook: Optional[Callable[[], None]] = None,
    logrotate_timeout: float = 300.0,
) -> dict:
    # Compatibility-only argument.  Serialization is the authority-bound
    # ledger inode itself, so replacing a /run pathname cannot split the lock.
    del lock_path
    with RotationContext(
        state_dir=state_dir,
        operation_id=operation_id,
        authority_path=authority_path,
        anchor_expected=anchor_expected,
        checker_path=checker_path,
        checker_expected=checker_expected,
        config_path=config,
        config_expected=config_expected,
        logrotate_path=logrotate,
        logrotate_expected=logrotate_expected,
        exclusive=True,
        barrier_hook=barrier_hook,
        barrier_trace=barrier_trace,
    ) as context:
        _, records = context.read_records(repair_partial_tail=True)
        _validate_context_ledger(context, records)
        tail = records[-1]
        context.set_state_allowlist(_phase_state_allowlist(tail))
        if tail["phase"] == "committed":
            expected_status = tail.get("new_status")
            status_descriptor = _open_committed_status(context, expected_status)
            cleaned = _cleanup_committed_workspace_fd(
                context, tail, fault_after_phase
            )
            if cleaned or recover_only:
                return _snapshot_from_context(context, records)
            generation = tail["generation"] + 1
            workspace_name = f"generation-{generation:020d}"
            workspace_path = context.state_dir / workspace_name
            context.barrier("B2-workspace-create-pre")
            try:
                os.mkdir(workspace_name, mode=0o700, dir_fd=context.state_fd)
            except FileExistsError as error:
                raise RotationProvenanceError(
                    "ambiguous state directory residue"
                ) from error
            os.fsync(context.state_fd)
            transition_allowlist = _phase_state_allowlist(tail)
            transition_allowlist.add(workspace_name)
            context.set_state_allowlist(transition_allowlist)
            workspace_descriptor, workspace_identity = _open_directory_at(
                context.state_fd, workspace_name, workspace_path
            )
            if workspace_identity["mode"] != "700" \
                    or workspace_identity["uid"] != os.geteuid() \
                    or workspace_identity["gid"] != os.getegid():
                os.close(workspace_descriptor)
                raise RotationProvenanceError("workspace metadata drift")
            context.bind(
                "workspace",
                context.state_fd,
                workspace_name,
                workspace_descriptor,
                workspace_identity,
                workspace_path,
            )
            context.barrier("B2-workspace-create-post")
            context.barrier("B3-candidate-copy-pre")
            _, candidate_initial = _create_candidate_from_status_fd(
                context,
                workspace_descriptor,
                workspace_path,
                status_descriptor,
                expected_status,
                candidate_copy_hook,
            )
            context.barrier("B3-prepared-append-pre")
            tail = context.append_record(
                {
                    "schema": 1,
                    "operation_id": operation_id,
                    "generation": generation,
                    "phase": "prepared",
                    "previous_record_sha256": tail["record_sha256"],
                    "workspace": workspace_identity,
                    "old_status": expected_status,
                    "candidate_initial": candidate_initial,
                }
            )
            records.append(tail)
            context.set_state_allowlist(_phase_state_allowlist(tail))
            context.barrier("B3-prepared-append-post")
            if fault_after_phase == "prepared":
                raise RotationProvenanceError("injected prepared crash")
        if tail["phase"] == "prepared":
            context.set_state_allowlist(_phase_state_allowlist(tail))
            workspace_descriptor, workspace_path = _ensure_workspace_binding(
                context, tail["workspace"]
            )
            status_descriptor = _ensure_prepared_phase_bindings(
                context,
                workspace_descriptor,
                workspace_path,
                tail["old_status"],
            )
            if "candidate" not in context.bindings:
                candidate_path = workspace_path / ROTATION_STATUS_NAME
                try:
                    _open_bound_regular(
                        context,
                        "candidate",
                        workspace_descriptor,
                        ROTATION_STATUS_NAME,
                        candidate_path,
                        tail["candidate_initial"],
                        writable=True,
                    )
                except (OSError, RotationProvenanceError) as error:
                    raise RotationProvenanceError(
                        "ambiguous prepared output"
                    ) from error
            if set(os.listdir(workspace_descriptor)) != {ROTATION_STATUS_NAME}:
                raise RotationProvenanceError("unknown prepared residue")
            context.barrier("B4-child-pre")
            initial_candidate_fd = context.unbind("candidate")
            child_error: Optional[BaseException] = None
            try:
                _run_logrotate_fd_isolated(
                    context,
                    workspace_descriptor,
                    initial_candidate_fd,
                    timeout=logrotate_timeout,
                    child_spawn_hook=child_spawn_hook,
                )
            except BaseException as error:
                child_error = error
            finally:
                if initial_candidate_fd is not None:
                    context.owned_fds.discard(initial_candidate_fd)
                    os.close(initial_candidate_fd)
            context.barrier("B4-child-post")
            if child_error is not None:
                raise child_error
            candidate_path = workspace_path / ROTATION_STATUS_NAME
            candidate_fd, _ = _open_regular_at(
                workspace_descriptor,
                ROTATION_STATUS_NAME,
                candidate_path,
                writable=True,
            )
            try:
                os.fchmod(candidate_fd, 0o600)
                os.fsync(candidate_fd)
                os.fsync(workspace_descriptor)
                candidate_identity = _fd_regular_identity(candidate_fd, candidate_path)
                candidate_at_path = _stat_at_optional(
                    workspace_descriptor, ROTATION_STATUS_NAME
                )
                if candidate_at_path is None or (
                    candidate_at_path.st_dev, candidate_at_path.st_ino
                ) != (candidate_identity["dev"], candidate_identity["ino"]):
                    raise RotationProvenanceError("candidate output pathname drift")
                if candidate_identity["mode"] != "600" \
                        or candidate_identity["uid"] != os.geteuid() \
                        or candidate_identity["gid"] != os.getegid():
                    raise RotationProvenanceError("candidate output metadata drift")
                context.bind(
                    "candidate",
                    workspace_descriptor,
                    ROTATION_STATUS_NAME,
                    candidate_fd,
                    candidate_identity,
                    candidate_path,
                )
            except Exception:
                os.close(candidate_fd)
                raise
            if set(os.listdir(workspace_descriptor)) != {ROTATION_STATUS_NAME}:
                raise RotationProvenanceError("unknown captured residue")
            context.barrier("B5-captured-append-pre")
            tail = context.append_record(
                {
                    "schema": 1,
                    "operation_id": operation_id,
                    "generation": tail["generation"],
                    "phase": "captured",
                    "previous_record_sha256": tail["record_sha256"],
                    "workspace": tail["workspace"],
                    "old_status": tail["old_status"],
                    "candidate": candidate_identity,
                }
            )
            records.append(tail)
            context.set_state_allowlist(_phase_state_allowlist(tail))
            context.barrier("B5-captured-append-post")
            if fault_after_phase == "captured":
                raise RotationProvenanceError("injected captured crash")
        if tail["phase"] == "captured":
            context.set_state_allowlist(_phase_state_allowlist(tail))
            workspace_descriptor, workspace_path = _ensure_workspace_binding(
                context, tail["workspace"]
            )
            old_status = tail["old_status"]
            candidate_expected = tail["candidate"]
            state = _captured_recovery_state(
                context,
                workspace_descriptor,
                workspace_path,
                old_status,
                candidate_expected,
            )
            context.barrier("B6-old-status-cas-pre")
            if state == "C0" and old_status is not None:
                old_at_status = _identity_at_path(
                    old_status, context.state_dir / ROTATION_STATUS_NAME
                )
                status_fd = context.bindings["status"][2]
                context.unbind_absence("previous")
                _rename_exact_no_replace(
                    context.state_fd,
                    ROTATION_STATUS_NAME,
                    status_fd,
                    old_at_status,
                    workspace_descriptor,
                    "previous-status",
                    old_status_cas_hook,
                )
                previous_path = workspace_path / "previous-status"
                previous_expected = _identity_at_path(old_status, previous_path)
                _relabel_binding(
                    context,
                    "status",
                    "previous",
                    workspace_descriptor,
                    "previous-status",
                    previous_expected,
                    previous_path,
                )
                context.bind_absence(
                    "status", context.state_fd, ROTATION_STATUS_NAME
                )
                state = "C1"
                if fault_after_phase == "after-old-move":
                    raise RotationProvenanceError("injected old-status crash")
            context.barrier("B6-old-status-cas-post")
            context.barrier("B7-candidate-cas-pre")
            if state in {"C0", "C1"}:
                candidate_path = workspace_path / ROTATION_STATUS_NAME
                candidate_at_workspace = _identity_at_path(
                    candidate_expected, candidate_path
                )
                candidate_fd = context.bindings["candidate"][2]
                context.unbind_absence("status")
                _rename_exact_no_replace(
                    workspace_descriptor,
                    ROTATION_STATUS_NAME,
                    candidate_fd,
                    candidate_at_workspace,
                    context.state_fd,
                    ROTATION_STATUS_NAME,
                    candidate_cas_hook,
                )
                status_path = context.state_dir / ROTATION_STATUS_NAME
                candidate_at_status = _identity_at_path(
                    candidate_expected, status_path
                )
                _relabel_binding(
                    context,
                    "candidate",
                    "status",
                    context.state_fd,
                    ROTATION_STATUS_NAME,
                    candidate_at_status,
                    status_path,
                )
                context.bind_absence(
                    "candidate", workspace_descriptor, ROTATION_STATUS_NAME
                )
                state = "C2"
                if fault_after_phase == "after-new-move":
                    raise RotationProvenanceError("injected new-status crash")
            context.barrier("B7-candidate-cas-post")
            if state != "C2":
                raise RotationProvenanceError("captured CAS did not converge")
            candidate_at_status = _identity_at_path(
                candidate_expected, context.state_dir / ROTATION_STATUS_NAME
            )
            context.barrier("B8-committed-append-pre")
            tail = context.append_record(
                {
                    "schema": 1,
                    "operation_id": operation_id,
                    "generation": tail["generation"],
                    "phase": "committed",
                    "previous_record_sha256": tail["record_sha256"],
                    "workspace": tail["workspace"],
                    "old_status": old_status,
                    "new_status": candidate_at_status,
                }
            )
            records.append(tail)
            context.set_state_allowlist(_phase_state_allowlist(tail))
            context.barrier("B8-committed-append-post")
            if fault_after_phase == "committed-before-cleanup":
                raise RotationProvenanceError("injected committed crash")
        context.set_state_allowlist(_phase_state_allowlist(tail))
        _cleanup_committed_workspace_fd(context, tail, fault_after_phase)
        return _snapshot_from_context(context, records)


def verify_rotation_provenance(
    state_dir: Path,
    operation_id: str,
    anchor: Optional[dict] = None,
) -> dict:
    """Descriptor-relative verifier for offline install and tests."""
    state_dir = Path(state_dir)
    parent_fd = os.open(
        state_dir.parent,
        os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0),
    )
    state_fd = -1
    ledger_fd = -1
    status_fd = -1
    try:
        state_fd, directory_identity = _open_directory_at(
            parent_fd, state_dir.name, state_dir
        )
        ledger_fd, ledger_identity = _open_regular_at(
            state_fd,
            ROTATION_LEDGER_NAME,
            state_dir / ROTATION_LEDGER_NAME,
        )
        fcntl.flock(ledger_fd, fcntl.LOCK_SH)
        _require_canonical_fd(
            parent_fd,
            state_dir.name,
            state_fd,
            directory_identity,
            state_dir,
        )
        _require_canonical_fd(
            state_fd,
            ROTATION_LEDGER_NAME,
            ledger_fd,
            ledger_identity,
            state_dir / ROTATION_LEDGER_NAME,
        )
        payload = _pread_all(ledger_fd)
        if not payload or not payload.endswith(b"\n"):
            raise RotationProvenanceError("partial ledger tail")
        try:
            records = [json.loads(line) for line in payload.splitlines()]
        except (UnicodeError, json.JSONDecodeError) as error:
            raise RotationProvenanceError("invalid ledger JSON") from error
        ledger_value = os.fstat(ledger_fd)
        _validate_records(
            state_dir,
            operation_id,
            ledger_value,
            records,
            directory_identity,
        )
        genesis = records[0]
        if anchor is not None:
            for key in ("path", "uid", "gid", "mode", "dev", "ino"):
                if anchor.get(key) != genesis["ledger"].get(key):
                    raise RotationProvenanceError(f"anchor drift: {key}")
            if anchor.get("genesis_record_sha256") != genesis.get("record_sha256"):
                raise RotationProvenanceError("genesis drift")
        tail = records[-1]
        if tail.get("phase") != "committed":
            raise RotationProvenanceError("uncommitted ledger tail")
        if set(os.listdir(state_fd)) != _committed_final_state_names(tail):
            raise RotationProvenanceError("ambiguous state directory residue")
        workspace = tail.get("workspace")
        if workspace is not None:
            workspace_name, tombstone = _workspace_names(tail)
            if _stat_at_optional(state_fd, workspace_name) is not None \
                    or _stat_at_optional(state_fd, tombstone) is not None:
                raise RotationProvenanceError("committed workspace residue")
        expected_status = tail.get("new_status")
        if expected_status is None:
            if _stat_at_optional(state_fd, ROTATION_STATUS_NAME) is not None:
                raise RotationProvenanceError("unexpected status")
            status_identity = None
        else:
            status_path = state_dir / ROTATION_STATUS_NAME
            status_expected = _identity_at_path(expected_status, status_path)
            status_fd, status_identity = _open_regular_at(
                state_fd,
                ROTATION_STATUS_NAME,
                status_path,
                status_expected,
            )
        _require_canonical_fd(
            parent_fd,
            state_dir.name,
            state_fd,
            directory_identity,
            state_dir,
        )
        _require_canonical_fd(
            state_fd,
            ROTATION_LEDGER_NAME,
            ledger_fd,
            ledger_identity,
            state_dir / ROTATION_LEDGER_NAME,
        )
        if expected_status is None:
            if _stat_at_optional(state_fd, ROTATION_STATUS_NAME) is not None:
                raise RotationProvenanceError("status appeared during verification")
        else:
            _require_canonical_fd(
                state_fd,
                ROTATION_STATUS_NAME,
                status_fd,
                status_expected,
                status_path,
            )
        if workspace is not None:
            workspace_name, tombstone = _workspace_names(tail)
            if _stat_at_optional(state_fd, workspace_name) is not None \
                    or _stat_at_optional(state_fd, tombstone) is not None:
                raise RotationProvenanceError("workspace appeared during verification")
        if set(os.listdir(state_fd)) != _committed_final_state_names(tail):
            raise RotationProvenanceError("ambiguous state directory residue")
        return {
            "generation": tail["generation"],
            "tail_record_sha256": tail["record_sha256"],
            "ledger": {
                "path": str(state_dir / ROTATION_LEDGER_NAME),
                "sha256": hashlib.sha256(payload).hexdigest(),
                "size": len(payload),
                "uid": ledger_value.st_uid,
                "gid": ledger_value.st_gid,
                "mode": _mode(ledger_value),
                "dev": ledger_value.st_dev,
                "ino": ledger_value.st_ino,
            },
            "status": status_identity,
        }
    finally:
        for descriptor in (status_fd, ledger_fd, state_fd, parent_fd):
            if descriptor >= 0:
                os.close(descriptor)


def recover_rotation_wrapper(**arguments: object) -> dict:
    arguments["recover_only"] = True
    return run_rotation_wrapper(**arguments)


def verify_authorized_rotation_provenance(
    *,
    state_dir: Path,
    operation_id: str,
    authority_path: Path,
    anchor_expected: dict,
    checker_path: Path,
    checker_expected: dict,
    config_path: Path,
    config_expected: dict,
    logrotate_path: Path,
    logrotate_expected: dict,
    lock_path: Optional[Path] = None,
) -> dict:
    del lock_path
    with RotationContext(
        state_dir=state_dir,
        operation_id=operation_id,
        authority_path=authority_path,
        anchor_expected=anchor_expected,
        checker_path=checker_path,
        checker_expected=checker_expected,
        config_path=config_path,
        config_expected=config_expected,
        logrotate_path=logrotate_path,
        logrotate_expected=logrotate_expected,
        exclusive=False,
    ) as context:
        _, records = context.read_records(repair_partial_tail=False)
        _validate_context_ledger(context, records)
        tail = records[-1]
        if tail.get("phase") != "committed":
            raise RotationProvenanceError("uncommitted ledger tail")
        workspace = tail.get("workspace")
        if workspace is not None:
            workspace_name, tombstone = _workspace_names(tail)
            if _stat_at_optional(context.state_fd, workspace_name) is not None \
                    or _stat_at_optional(context.state_fd, tombstone) is not None:
                raise RotationProvenanceError("committed workspace residue")
        return _snapshot_from_context(context, records)


@dataclass(frozen=True)
class Token:
    value: str
    line: int
    structural: bool = False


@dataclass(frozen=True)
class Node:
    name: str
    arguments: Tuple[str, ...]
    line: int
    children: Optional[Tuple["Node", ...]] = None


class ParseFailure(Exception):
    def __init__(self, line: int) -> None:
        super().__init__("nginx parse failure")
        self.line = max(1, line)


def tokenize(source: str) -> List[Token]:
    tokens: List[Token] = []
    current: List[str] = []
    current_line = 1
    line = 1
    quote: Optional[str] = None
    quote_line = 1
    index = 0

    def start_token() -> None:
        nonlocal current_line
        if not current:
            current_line = line

    def flush() -> None:
        if current:
            tokens.append(Token("".join(current), current_line))
            current.clear()

    while index < len(source):
        char = source[index]

        if quote is not None:
            if char == quote:
                quote = None
                index += 1
                continue
            if char == "\\":
                if index + 1 >= len(source):
                    raise ParseFailure(line)
                next_char = source[index + 1]
                if next_char == "\n":
                    line += 1
                else:
                    current.append(next_char)
                index += 2
                continue
            current.append(char)
            if char == "\n":
                line += 1
            index += 1
            continue

        if char in ("'", '"'):
            start_token()
            quote = char
            quote_line = line
            index += 1
            continue

        if char == "#":
            flush()
            while index < len(source) and source[index] != "\n":
                index += 1
            continue

        if char == "\\":
            start_token()
            if index + 1 >= len(source):
                raise ParseFailure(line)
            next_char = source[index + 1]
            if next_char == "\n":
                line += 1
            else:
                current.append(next_char)
            index += 2
            continue

        if char.isspace():
            flush()
            if char == "\n":
                line += 1
            index += 1
            continue

        if char in "{};":
            flush()
            tokens.append(Token(char, line, structural=True))
            index += 1
            continue

        start_token()
        current.append(char)
        index += 1

    if quote is not None:
        raise ParseFailure(quote_line)
    flush()
    return tokens


def parse_nodes(
    tokens: Sequence[Token],
    index: int = 0,
    expect_close: bool = False,
) -> Tuple[Tuple[Node, ...], int]:
    nodes: List[Node] = []
    directive: List[Token] = []

    while index < len(tokens):
        token = tokens[index]

        if token.structural and token.value == ";":
            if not directive:
                raise ParseFailure(token.line)
            nodes.append(
                Node(
                    directive[0].value,
                    tuple(part.value for part in directive[1:]),
                    directive[0].line,
                )
            )
            directive.clear()
            index += 1
            continue

        if token.structural and token.value == "{":
            if not directive:
                raise ParseFailure(token.line)
            children, index = parse_nodes(tokens, index + 1, expect_close=True)
            nodes.append(
                Node(
                    directive[0].value,
                    tuple(part.value for part in directive[1:]),
                    directive[0].line,
                    children,
                )
            )
            directive.clear()
            continue

        if token.structural and token.value == "}":
            if directive or not expect_close:
                raise ParseFailure(token.line)
            return tuple(nodes), index + 1

        directive.append(token)
        index += 1

    if directive or expect_close:
        failure_line = directive[0].line if directive else (tokens[-1].line if tokens else 1)
        raise ParseFailure(failure_line)
    return tuple(nodes), index


@dataclass
class Counts:
    locations: int = 0
    proxy_locations: int = 0
    proxy_pass: int = 0
    request_id: int = 0


def inspect_nodes(
    nodes: Sequence[Node],
    counts: Counts,
    errors: List[Tuple[int, int, int, int]],
    policy_errors: List[Tuple[int, str]],
    allowed_includes: Set[str],
) -> None:
    for node in nodes:
        name = node.name.lower()
        if node.children is None:
            if name == "access_log":
                policy_errors.append((node.line, "forbidden_access_log"))
            elif name == "include" and (
                len(node.arguments) != 1 or node.arguments[0] not in allowed_includes
            ):
                policy_errors.append((node.line, "unexpected_include"))

        if node.children is None:
            continue

        if name == "location":
            counts.locations += 1
            direct_proxy_pass = sum(
                1
                for child in node.children
                if child.children is None and child.name.lower() == "proxy_pass"
            )
            direct_request_id = sum(
                1
                for child in node.children
                if child.children is None
                and child.name.lower() == "proxy_set_header"
                and len(child.arguments) >= 1
                and child.arguments[0].lower() == "x-request-id"
            )
            direct_valid_request_id = sum(
                1
                for child in node.children
                if child.children is None
                and child.name.lower() == "proxy_set_header"
                and len(child.arguments) == 2
                and child.arguments[0].lower() == "x-request-id"
                and child.arguments[1] == "$request_id"
            )

            if direct_proxy_pass:
                counts.proxy_locations += 1
                counts.proxy_pass += direct_proxy_pass
                counts.request_id += direct_request_id
                if direct_request_id != 1 or direct_valid_request_id != 1:
                    errors.append(
                        (
                            node.line,
                            direct_proxy_pass,
                            direct_request_id,
                            direct_valid_request_id,
                        )
                    )

        inspect_nodes(
            node.children,
            counts,
            errors,
            policy_errors,
            allowed_includes,
        )


def read_source(source: str) -> str:
    if source == "-":
        return sys.stdin.read()
    with open(source, "r", encoding="utf-8") as handle:
        return handle.read()


def check_source(
    source: str,
    input_number: int,
    expected_proxy_count: Optional[int],
    allowed_includes: Set[str],
) -> bool:
    try:
        text = read_source(source)
    except (OSError, UnicodeError):
        print(f"ERROR input={input_number} line=0 read=1")
        return False

    try:
        tokens = tokenize(text)
        nodes, index = parse_nodes(tokens)
        if index != len(tokens):
            raise ParseFailure(tokens[index].line)
    except ParseFailure as failure:
        print(f"ERROR input={input_number} line={failure.line} parse=1")
        return False
    except Exception:
        print(f"ERROR input={input_number} line=0 internal=1")
        return False

    counts = Counts()
    errors: List[Tuple[int, int, int, int]] = []
    policy_errors: List[Tuple[int, str]] = []
    inspect_nodes(nodes, counts, errors, policy_errors, allowed_includes)

    if counts.proxy_locations == 0:
        errors.append((0, 0, 0, 0))

    if expected_proxy_count is not None and counts.proxy_pass != expected_proxy_count:
        print(
            f"ERROR input={input_number} expected_proxy_count={expected_proxy_count} "
            f"actual_proxy_count={counts.proxy_pass}"
        )
        policy_errors.append((0, "proxy_count"))

    for line, error_name in policy_errors:
        if error_name != "proxy_count":
            print(f"ERROR input={input_number} line={line} {error_name}=1")

    if errors or policy_errors:
        for line, proxy_pass, request_id, valid_request_id in errors:
            print(
                f"ERROR input={input_number} line={line} "
                f"proxy_pass={proxy_pass} request_id={request_id} "
                f"valid_request_id={valid_request_id}"
            )
        print(
            f"FAIL input={input_number} errors={len(errors) + len(policy_errors)} "
            f"locations={counts.locations} proxy_locations={counts.proxy_locations} "
            f"proxy_pass={counts.proxy_pass} request_id={counts.request_id}"
        )
        return False

    print(
        f"OK input={input_number} locations={counts.locations} "
        f"proxy_locations={counts.proxy_locations} proxy_pass={counts.proxy_pass} "
        f"request_id={counts.request_id}"
    )
    return True


def parse_arguments(arguments: Sequence[str]) -> Tuple[Optional[int], Set[str], List[str]]:
    expected_proxy_count: Optional[int] = None
    allowed_includes: Set[str] = set()
    sources: List[str] = []
    index = 0

    while index < len(arguments):
        argument = arguments[index]
        if argument == "--expect-proxy-count":
            if index + 1 >= len(arguments):
                raise ValueError("missing proxy count")
            expected_proxy_count = int(arguments[index + 1])
            if expected_proxy_count < 0:
                raise ValueError("invalid proxy count")
            index += 2
            continue
        if argument == "--allow-include":
            if index + 1 >= len(arguments) or not arguments[index + 1].startswith("/"):
                raise ValueError("invalid include")
            allowed_includes.add(arguments[index + 1])
            index += 2
            continue
        sources.append(argument)
        index += 1

    return expected_proxy_count, allowed_includes, sources or ["-"]


def main(arguments: Sequence[str]) -> int:
    if arguments and arguments[0].startswith("rotation-"):
        command = arguments[0]
        try:
            if command in {"rotation-wrapper", "rotation-recover", "rotation-verify"} \
                    and len(arguments) == 15:
                if os.geteuid() != 0:
                    raise RotationProvenanceError("root required")
                (
                    operation_id,
                    authority_value,
                    anchor_dev,
                    anchor_ino,
                    anchor_sha256,
                    checker_dev,
                    checker_ino,
                    checker_sha256,
                    config_dev,
                    config_ino,
                    config_sha256,
                    logrotate_dev,
                    logrotate_ino,
                    logrotate_sha256,
                ) = arguments[1:]
                authority_path = Path(authority_value)
                expected_authority = ROTATION_ANCHOR_DIRECTORY / (
                    f"rotation-anchor-{operation_id}.json"
                )
                if authority_path != expected_authority:
                    raise RotationProvenanceError("invalid authority path")

                def cli_expected(path: Path, dev: str, ino: str, sha256: str) -> dict:
                    if not re.fullmatch(r"[1-9][0-9]*", dev) \
                            or not re.fullmatch(r"[1-9][0-9]*", ino):
                        raise RotationProvenanceError("invalid expected identity")
                    parsed_dev = int(dev)
                    parsed_ino = int(ino)
                    if parsed_dev <= 0 or parsed_ino <= 0 \
                            or not re.fullmatch(r"[a-f0-9]{64}", sha256):
                        raise RotationProvenanceError("invalid expected identity")
                    return {
                        "path": str(path),
                        "dev": parsed_dev,
                        "ino": parsed_ino,
                        "sha256": sha256,
                    }

                common = {
                    "state_dir": ROTATION_STATE_DIRECTORY,
                    "operation_id": operation_id,
                    "authority_path": authority_path,
                    "anchor_expected": cli_expected(
                        authority_path, anchor_dev, anchor_ino, anchor_sha256
                    ),
                    "checker_path": ROTATION_CHECKER,
                    "checker_expected": cli_expected(
                        ROTATION_CHECKER, checker_dev, checker_ino, checker_sha256
                    ),
                    "config_expected": cli_expected(
                        ROTATION_CONFIG, config_dev, config_ino, config_sha256
                    ),
                    "logrotate_expected": cli_expected(
                        LOGROTATE, logrotate_dev, logrotate_ino, logrotate_sha256
                    ),
                }
                if command == "rotation-verify":
                    snapshot = verify_authorized_rotation_provenance(
                        config_path=ROTATION_CONFIG,
                        logrotate_path=LOGROTATE,
                        lock_path=ROTATION_LOCK,
                        **common,
                    )
                else:
                    runner = (
                        recover_rotation_wrapper
                        if command == "rotation-recover"
                        else run_rotation_wrapper
                    )
                    snapshot = runner(
                        config=ROTATION_CONFIG,
                        logrotate=LOGROTATE,
                        lock_path=ROTATION_LOCK,
                        **common,
                    )
                print(_canonical_json(snapshot).decode("utf-8"))
                return 0
            if command == "rotation-initialize" and len(arguments) == 3:
                operation_id = arguments[1]
                candidate = Path(arguments[2])
                expected = Path(f"{ROTATION_STATE_DIRECTORY}.candidate-gl-a-{operation_id}")
                if os.geteuid() != 0 or candidate != expected:
                    raise RotationProvenanceError("invalid initialization path")
                anchor = initialize_rotation_provenance(
                    candidate,
                    operation_id,
                    ROTATION_STATE_DIRECTORY,
                )
                print(_canonical_json(anchor).decode("utf-8"))
                return 0
            if command == "rotation-verify-initialized" and len(arguments) == 6:
                operation_id, candidate_value, expected_dev, expected_ino, genesis_hash = arguments[1:]
                candidate = Path(candidate_value)
                expected = Path(f"{ROTATION_STATE_DIRECTORY}.candidate-gl-a-{operation_id}")
                if os.geteuid() != 0 or candidate != expected:
                    raise RotationProvenanceError("invalid candidate verification path")
                anchor = {
                    "path": str(ROTATION_STATE_DIRECTORY / ROTATION_LEDGER_NAME),
                    "uid": 0,
                    "gid": 0,
                    "mode": "600",
                    "dev": int(expected_dev),
                    "ino": int(expected_ino),
                    "genesis_record_sha256": genesis_hash,
                }
                snapshot = verify_rotation_provenance(candidate, operation_id, anchor)
                print(_canonical_json(snapshot).decode("utf-8"))
                return 0
        except (OSError, TypeError, ValueError, RotationProvenanceError):
            print("ERROR rotation_provenance=1")
            return 1
        print("ERROR arguments=1")
        return 64
    try:
        expected_proxy_count, allowed_includes, sources = parse_arguments(arguments)
    except (TypeError, ValueError):
        print("ERROR arguments=1")
        return 2

    success = True
    for input_number, source in enumerate(sources, start=1):
        success = check_source(
            source,
            input_number,
            expected_proxy_count,
            allowed_includes,
        ) and success
    return 0 if success else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
