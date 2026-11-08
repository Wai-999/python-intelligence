"""Tests for scripts/validate_manifest.py. Path-independent: everything resolves from this file."""
import copy
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "validate_manifest.py"
REAL_MANIFEST = ROOT / "docs" / "audit" / "source_manifest.json"

_spec = importlib.util.spec_from_file_location("validate_manifest", SCRIPT)
vm = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(vm)

GOOD_SOURCE = {
    "source_id": "s-1",
    "repo": "owner/repo",
    "commit_sha": "d1590b79e98eb9975548da88001387bdedcd930a",
    "path": "books/x.pdf",
    "git_blob_sha1": "0f7fbf1168dcf37e9682b30ceb386292c645f768",
    "size_bytes": 123,
    "sha256": None,
    "downloaded": False,
    "rights_status": "unknown",
    "rights_verified": False,
    "allowed_to_publish": False,
    "allowed_for_internal_extraction": False,
}
_DROP = object()  # sentinel: remove the key instead of overriding it

DECISION = {"by": "Owner Name", "date": "2026-11-08", "basis": "CC BY-SA 3.0 license page verified"}


def manifest(*sources):
    return {"sources": [copy.deepcopy(s) for s in (sources or (GOOD_SOURCE,))]}


def src(**overrides):
    s = copy.deepcopy(GOOD_SOURCE)
    for k, v in overrides.items():
        if v is _DROP:
            s.pop(k, None)
        else:
            s[k] = v
    return s


def run_cli(*args, cwd):
    return subprocess.run([sys.executable, str(SCRIPT), *map(str, args)],
                          capture_output=True, text=True, cwd=cwd)


def assert_one_error(m, needle):
    errs = vm.validate(m)
    assert errs, f"expected an error mentioning {needle!r}"
    assert any(needle in e for e in errs), errs


# --- valid inputs -------------------------------------------------------------

def test_real_manifest_is_valid():
    assert vm.validate(json.loads(REAL_MANIFEST.read_text(encoding="utf-8"))) == []


def test_minimal_good_manifest_is_valid():
    assert vm.validate(manifest()) == []


def test_permission_with_full_decision_is_valid():
    s = src(rights_verified=True, allowed_to_publish=True, allowed_for_internal_extraction=True,
            decision=DECISION)
    assert vm.validate(manifest(s)) == []


def test_downloaded_with_sha256_is_valid():
    assert vm.validate(manifest(src(downloaded=True, sha256="a" * 64))) == []


# --- top-level shape ----------------------------------------------------------

@pytest.mark.parametrize("m", [[], "x", None, {}, {"sources": []}, {"sources": {}}])
def test_top_level_shape(m):
    assert vm.validate(m) != []


def test_non_object_source():
    assert_one_error({"sources": ["nope"]}, "must be an object")


# --- required fields and types ------------------------------------------------

@pytest.mark.parametrize("field", ["source_id", "repo", "commit_sha", "path", "git_blob_sha1", "size_bytes",
                                   "rights_status", "rights_verified", "allowed_to_publish",
                                   "allowed_for_internal_extraction"])
def test_missing_required_field(field):
    assert_one_error(manifest(src(**{field: _DROP})), field)


@pytest.mark.parametrize("sid", ["", "   ", 7, None])
def test_bad_source_id(sid):
    assert_one_error(manifest(src(source_id=sid)), "source_id")


def test_duplicate_source_id():
    assert_one_error(manifest(GOOD_SOURCE, GOOD_SOURCE), "duplicate source_id")


@pytest.mark.parametrize("field", ["repo", "path", "rights_status"])
def test_string_fields_must_be_strings(field):
    assert_one_error(manifest(src(**{field: 1})), field)


@pytest.mark.parametrize("sha", ["D1590B79E98EB9975548DA88001387BDEDCD930A", "abc", "g" * 40, "a" * 41, 1])
def test_bad_commit_sha(sha):
    assert_one_error(manifest(src(commit_sha=sha)), "commit_sha")


@pytest.mark.parametrize("sha", ["abc", "z" * 40, "a" * 39, None])
def test_bad_git_blob_sha1(sha):
    assert_one_error(manifest(src(git_blob_sha1=sha)), "git_blob_sha1")


@pytest.mark.parametrize("size", [0, -1, 1.5, "10", True, None])
def test_bad_size_bytes(size):
    assert_one_error(manifest(src(size_bytes=size)), "size_bytes")


@pytest.mark.parametrize("field", ["rights_verified", "allowed_to_publish", "allowed_for_internal_extraction"])
@pytest.mark.parametrize("value", [0, "false", None])
def test_bool_fields_must_be_bools(field, value):
    assert_one_error(manifest(src(**{field: value})), field)


# --- rights gate --------------------------------------------------------------

@pytest.mark.parametrize("perm", ["allowed_to_publish", "allowed_for_internal_extraction"])
def test_permission_requires_rights_verified(perm):
    assert_one_error(manifest(src(**{perm: True}, decision=DECISION)), "rights_verified")


@pytest.mark.parametrize("perm", ["allowed_to_publish", "allowed_for_internal_extraction"])
@pytest.mark.parametrize("decision", [_DROP, None, "yes", []])
def test_permission_requires_decision_object(perm, decision):
    assert_one_error(manifest(src(**{perm: True}, rights_verified=True, decision=decision)), "decision")


@pytest.mark.parametrize("key", ["by", "basis", "date"])
@pytest.mark.parametrize("bad", [_DROP, "", "  ", 5])
def test_decision_fields_required(key, bad):
    d = dict(DECISION)
    if bad is _DROP:
        del d[key]
    else:
        d[key] = bad
    s = src(allowed_to_publish=True, rights_verified=True, decision=d)
    assert_one_error(manifest(s), f"decision.{key}")


@pytest.mark.parametrize("date", ["2026/11/08", "08-11-2026", "2026-13-01", "2026-02-30", "2026-1-1"])
def test_decision_date_format(date):
    s = src(allowed_to_publish=True, rights_verified=True, decision=dict(DECISION, date=date))
    assert_one_error(manifest(s), "decision.date")


def test_rights_verified_alone_without_permission_is_fine():
    assert vm.validate(manifest(src(rights_verified=True))) == []


# --- downloaded / sha256 ------------------------------------------------------

@pytest.mark.parametrize("sha", [None, "", "A" * 64, "a" * 63, "g" * 64])
def test_downloaded_requires_sha256(sha):
    assert_one_error(manifest(src(downloaded=True, sha256=sha)), "sha256")


def test_errors_accumulate_across_sources():
    errs = vm.validate(manifest(src(source_id="a", size_bytes=0), src(source_id="b", commit_sha="x")))
    assert any("(a)" in e and "size_bytes" in e for e in errs)
    assert any("(b)" in e and "commit_sha" in e for e in errs)


# --- CLI ----------------------------------------------------------------------

def test_cli_valid_exit_0(tmp_path):
    r = run_cli(REAL_MANIFEST, cwd=tmp_path)
    assert r.returncode == 0, r.stdout + r.stderr


def test_cli_invalid_exit_1(tmp_path):
    p = tmp_path / "m.json"
    p.write_text(json.dumps(manifest(src(allowed_to_publish=True))), encoding="utf-8")
    r = run_cli(p, cwd=tmp_path)
    assert r.returncode == 1
    assert "rights_verified" in r.stdout and "decision" in r.stdout


def test_cli_bad_json_exit_2(tmp_path):
    p = tmp_path / "bad.json"
    p.write_text("{not json", encoding="utf-8")
    assert run_cli(p, cwd=tmp_path).returncode == 2


def test_cli_missing_file_exit_2(tmp_path):
    assert run_cli(tmp_path / "nope.json", cwd=tmp_path).returncode == 2
