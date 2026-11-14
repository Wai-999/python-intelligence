"""The placement check (content/diagnostic.json) must be prerequisite-closed and its predicted outputs must be real."""
import copy
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("validate_content", ROOT / "scripts" / "validate_content.py")
vc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vc)

DIAG = json.loads((ROOT / "content" / "diagnostic.json").read_text())
LESSONS = {p.stem: json.loads(p.read_text()) for p in (ROOT / "content" / "lessons").glob("*.json")}


def errs(mutate):
    d = copy.deepcopy(DIAG)
    mutate(d)
    return vc.check_diagnostic(d, LESSONS)


def q(d, cid, qid):
    return next(x for x in next(c for c in d["checkpoints"] if c["id"] == cid)["questions"] if x["id"] == qid)


def test_shipped_diagnostic_is_clean():
    assert vc.check_diagnostic(copy.deepcopy(DIAG), LESSONS) == []


def test_a_wrong_marked_answer_fails_because_the_code_is_run():
    e = errs(lambda d: q(d, "basics", "ret").update(answer=0))  # "3": the function returns None
    assert any("prints 'None', not the marked choice '3'" in x for x in e), e


def test_code_that_crashes_fails():
    e = errs(lambda d: q(d, "basics", "expr").update(code="print(undefined_name)"))
    assert any("code failed" in x for x in e), e


def test_testing_out_must_not_skip_a_prerequisite():
    def drop(d):  # py-loops needs py-conditionals; remove py-conditionals from the first checkpoint
        d["checkpoints"][0]["covers"].remove("py-conditionals")
        d["checkpoints"][0]["questions"] = [x for x in d["checkpoints"][0]["questions"] if x["lesson"] != "py-conditionals"]
    e = errs(drop)
    assert any("py-loops needs py-conditionals" in x for x in e), e


def test_a_question_must_test_a_concept_of_its_lesson():
    e = errs(lambda d: q(d, "basics", "expr").update(concept="slicing"))
    assert any("concept slicing is not taught by py-values-names" in x for x in e), e
    e = errs(lambda d: q(d, "basics", "expr").update(lesson="py-strings"))
    assert any("not one this checkpoint covers" in x for x in e), e


def test_every_covered_lesson_needs_its_own_question():
    def drop(d):  # keep py-functions covered but remove its only question
        d["checkpoints"][0]["questions"] = [x for x in d["checkpoints"][0]["questions"] if x["lesson"] != "py-functions"]
    e = errs(drop)
    assert any("py-functions has no question of its own" in x for x in e), e


def test_structure_checks():
    assert any("covered by more than one" in x for x in errs(lambda d: d["checkpoints"][1]["covers"].append("py-functions")))
    assert any("unknown lesson" in x for x in errs(lambda d: d["checkpoints"][0]["covers"].append("nope")))
    assert any("unique across" in x for x in errs(lambda d: q(d, "loops-text", "acc").update(id="expr")))
    assert any("can't contain ':'" in x for x in errs(lambda d: q(d, "basics", "expr").update(id="a:b")))
    assert any("Not sure" in x for x in errs(lambda d: q(d, "arrays-stats", "var")["choices"].append("Not sure")))
    assert any("answer must index" in x for x in errs(lambda d: q(d, "arrays-stats", "var").update(answer=9)))
    assert any("answer must index" in x for x in errs(lambda d: q(d, "arrays-stats", "var").update(answer=True)))
    assert any("distinct" in x for x in errs(lambda d: q(d, "arrays-stats", "var").update(choices=["4", "4"])))
    assert any("needs code" in x for x in errs(lambda d: q(d, "arrays-stats", "var").update(output=True)))
    assert vc.check_diagnostic({"version": 1, "checkpoints": []}, LESSONS)


def test_every_core_lesson_up_to_the_data_track_can_be_placed_out_of_and_ml_cannot():
    covered = {lid for c in DIAG["checkpoints"] for lid in c["covers"]}
    assert {"py-values-names", "py-dicts", "np-arrays", "stats-summary"} <= covered
    assert not any(lid.startswith("ml-") or lid.startswith("proj-") for lid in covered)
