"""Verify the competition tasks against actual saved Flask working trees."""

from __future__ import annotations

import argparse
import ast
from difflib import SequenceMatcher
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


HERE = Path(__file__).resolve().parent
TASKS = json.loads(HERE.joinpath("tasks.json").read_text(encoding="utf-8"))
SECRET_MARKERS = ("SECRET", "PASSWORD", "TOKEN", "KEY")
DEMO_CONFIG = {
    "DEMO_SECRET_VALUE": "private-alpha-29",
    "DEMO_PASSWORD_VALUE": "private-beta-37",
    "DEMO_TOKEN_VALUE": "private-gamma-41",
    "DEMO_MONKEY_VALUE": "private-delta-43",
    "DEMO_THEME": {"palette": ["blue", "amber"], "contrast": True},
    "DEMO_RETRIES": 3,
}


class VerificationError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise VerificationError(message)


def capture(argv, repo, *, env=None, timeout=90):
    result = subprocess.run(
        argv,
        cwd=repo,
        env=env,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )
    if result.returncode:
        detail = (result.stdout + result.stderr).strip()
        raise VerificationError(f"{' '.join(argv[1:])} exited with {result.returncode}\n{detail}")
    return result.stdout


def git(repo, *args):
    return capture(["git", *args], repo, timeout=10)


def git_file(repo, revision, file):
    try:
        return git(repo, "show", f"{revision}:{file}")
    except VerificationError:
        return ""


def pin(repo):
    require(repo.is_dir(), f"Flask checkout is missing at {repo}")
    require(git(repo, "rev-parse", "HEAD").strip() == TASKS["commit"],
            f"Expected Flask {TASKS['tag']} at {TASKS['commit'][:8]} in {repo}")


def python(repo, *args, demo_path=None, overrides=None):
    paths = [str(repo / "src")]
    if demo_path:
        paths.append(str(demo_path))
    env = os.environ.copy()
    env.update(PYTHONPATH=os.pathsep.join(paths), PYTHONDONTWRITEBYTECODE="1",
               PYTHONUTF8="1", FLASK_SKIP_DOTENV="1", NO_COLOR="1")
    env.pop("FLASK_APP", None)
    env.pop("FLASK_DEBUG", None)
    env.pop("PYTEST_ADDOPTS", None)
    env.update(overrides or {})
    return capture([sys.executable, *args], repo, env=env)


def pytest(repo, target, *options):
    return python(repo, "-m", "pytest", "-p", "no:cacheprovider", target, "-q", *options).rstrip()


def changed_files(repo):
    tracked = git(repo, "diff", "--name-only", "--no-renames", "-z", "HEAD", "--")
    untracked = git(repo, "ls-files", "--others", "--exclude-standard", "-z")
    return set(filter(None, (tracked + untracked).split("\0")))


def split_selected_function(source, name):
    node = next(
        (item for item in ast.parse(source).body if isinstance(item, ast.FunctionDef) and item.name == name),
        None,
    )
    require(node is not None, f"Could not find the top-level function {name}")
    lines = source.splitlines(keepends=True)
    first = min([node.lineno, *(item.lineno for item in node.decorator_list)]) - 1
    return "".join(lines[:first]), "".join(lines[node.end_lineno:]), ast.get_docstring(node) or ""


def verify_a(repo, *, combined=False):
    file = TASKS["A"]["file"]
    name = TASKS["A"]["symbol"]
    actual = (repo / file).read_text(encoding="utf-8")
    original = git(repo, "show", f"HEAD:{file}").replace("\r\n", "\n")
    before, after, doc = split_selected_function(actual, name)
    original_before, original_after, _ = split_selected_function(original, name)
    require(actual != original, f"No saved edit to {file}")
    require(before == original_before and after == original_after,
            f"Task A changed text outside {name} in {file}")
    if not combined:
        require(changed_files(repo) == {file}, f"Task A should change only {file} before Task B begins")

    result = python(repo, "-c", "from flask.helpers import get_debug_flag; print(get_debug_flag())",
                    overrides={"FLASK_DEBUG": "off"}).strip()
    print(f"FLASK_DEBUG=off -> {result}", flush=True)
    require(result == "False", "Expected FLASK_DEBUG=off to produce False")
    code = """
import json
import os
from pathlib import Path
import flask
from flask.helpers import get_debug_flag

assert Path(flask.__file__).resolve().is_relative_to(Path.cwd() / "src")
cases = (None, "", "0", "false", "FaLsE", "no", "No", "off", "oFf", "n", "N",
         "1", "yes", "on", "true", "unrelated", " off ", "unset", "empty")
results = []
for value in cases:
    if value is None:
        os.environ.pop("FLASK_DEBUG", None)
    else:
        os.environ["FLASK_DEBUG"] = value
    results.append(get_debug_flag())
print(json.dumps(results))
"""
    actual_cases = json.loads(python(repo, "-c", code))
    expected_cases = [False] * 11 + [True] * 8
    require(actual_cases == expected_cases, f"Case matrix mismatch: {actual_cases!r}")
    names = ("0", "false", "no", "off", "n")
    missing = [item for item in names if not re.search(rf"(?<!\w){re.escape(item)}(?!\w)", doc, re.I)]
    if not re.search(r"\b(?:unset|missing|absent|not\s+(?:set|defined|present|provided)|none)\b", doc, re.I):
        missing.append("unset")
    if not re.search(r"\b(?:empty|blank|zero[- ]length)\b|''|\"\"", doc, re.I):
        missing.append("empty")
    require(not missing, f"Docstring is missing false cases: {', '.join(missing)}")
    require(not re.search(r"[\"'](?:unset|empty|none)[\"']", doc, re.I),
            "The docstring describes an unset or empty value as a literal string.")
    print(f"Task A verified: {len(actual_cases)} runtime cases, complete false-value docstring, selection-only diff.")


def pytest_functions(tree, prefix):
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("test_"):
            yield prefix + "::" + node.name, node
        if isinstance(node, ast.ClassDef) and node.name.startswith("Test"):
            yield from pytest_functions(node, prefix + "::" + node.name)


def test_body(function):
    pending = list(function.body)
    while pending:
        node = pending.pop()
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            continue
        yield node
        pending.extend(ast.iter_child_nodes(node))


def find_config_regression(repo, changed, *, compare_to_head=True):
    for candidate in sorted(changed):
        if not candidate.startswith("tests/") or not candidate.endswith(".py"):
            continue
        target = repo / candidate
        if not target.is_file():
            continue
        source = target.read_text(encoding="utf-8")
        parsed = ast.parse(source)
        command_names = {
            name.id
            for statement in parsed.body if isinstance(statement, (ast.Assign, ast.AnnAssign))
            and isinstance(statement.value, ast.Constant) and statement.value.value == "config"
            for name in (statement.targets if isinstance(statement, ast.Assign) else [statement.target])
            if isinstance(name, ast.Name)
        }
        diff = git(repo, "diff", "--unified=0", "HEAD", "--", candidate) if compare_to_head else ""
        spans = []
        for first, count in re.findall(r"(?m)^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", diff):
            spans.append((int(first), int(first) + int(count or "1") - 1))
        for test_id, function in pytest_functions(parsed, candidate):
            body = list(test_body(function))
            calls_config = any(
                (isinstance(item, ast.Constant) and item.value == "config") or
                (isinstance(item, ast.Name) and item.id in command_names)
                for item in body
            )
            has_assertion = any(isinstance(item, ast.Assert) or
                                (isinstance(item, ast.Call) and isinstance(item.func, ast.Attribute)
                                 and item.func.attr.startswith("assert")) for item in body)
            start = min([function.lineno, *(item.lineno for item in function.decorator_list)])
            edited = not diff or any(first <= function.end_lineno and last >= start
                                     for first, last in spans)
            if calls_config and has_assertion and edited:
                collected = python(repo, "-m", "pytest", "-p", "no:cacheprovider", "--collect-only", "-q", candidate)
                if any(line == test_id or line.startswith(test_id + "[") for line in collected.splitlines()):
                    return candidate, test_id
    raise VerificationError("No collected pytest test invokes config and asserts its output. A nested test function is not collected.")


def config_guides(repo, candidates, original):
    verified = []
    for candidate in candidates:
        target = repo / candidate
        if not target.is_file():
            continue
        current = target.read_text(encoding="utf-8")
        if not re.search(r"\bflask\s+config\b", current):
            continue
        previous = original(candidate)
        if target.suffix == ".rst" and previous:
            before = previous.splitlines()
            after = current.splitlines()
            for operation, first, last, start, end in SequenceMatcher(None, before, after, autojunk=False).get_opcodes():
                section = "\n".join(after[start:end])
                if (operation == "insert" and 0 < first < len(before) and before[first - 1].strip()
                        and before[first].strip() and re.search(r"(?m)^\S[^\n]+\n[-=^~]{3,}$", section)):
                    raise VerificationError(f"New section in {candidate} interrupts an existing paragraph or directive. "
                                            "Place it at a blank-line boundary between existing sections.")
        verified.append(candidate)
    require(verified, "No guide documents the 'flask config' command.")
    return verified


def verify_b(repo, *, full_json=False):
    changed = changed_files(repo) - {TASKS["A"]["file"]}
    require(len(changed) >= 3, f"Expected at least three Task B files, found {len(changed)}: {sorted(changed)}")
    require(any(file.startswith("src/") for file in changed), "Expected a CLI implementation change under src/")
    config_guides(repo, sorted(file for file in changed if file.startswith("docs/")),
                  lambda file: git_file(repo, "HEAD", file))
    regression_file, regression_id = find_config_regression(repo, changed)
    print("pytest tests/test_cli.py -q", flush=True)
    print(pytest(repo, "tests/test_cli.py"), flush=True)
    if regression_file != "tests/test_cli.py":
        print(pytest(repo, regression_file), flush=True)

    # The app lives outside the workspace and carries only synthetic data.
    with tempfile.TemporaryDirectory(prefix="ourloss-flask-oracle-") as directory:
        demo_path = Path(directory)
        demo_path.joinpath("ourloss_validation_app.py").write_text(
            "from flask import Flask\n"
            "app = Flask(__name__)\n"
            f"app.config.update({DEMO_CONFIG!r})\n",
            encoding="utf-8",
        )
        primary = ("-m", "flask", "--app", "ourloss_validation_app")
        help_text = python(repo, *primary, "--help", demo_path=demo_path)
        registered = re.search(r"(?m)^\s{2,}config(?:[ \t]+.*)?$", help_text)
        require(registered is not None, "flask --help did not list config")
        print("flask --help -> " + registered.group().strip(), flush=True)
        output = python(repo, *primary, "config", demo_path=demo_path)
        expected_code = (
            "import json; from ourloss_validation_app import app; "
            "print(json.dumps(dict(app.config), default=str))"
        )
        expected = json.loads(python(repo, "-c", expected_code, demo_path=demo_path))

    observed = json.loads(output)
    require(isinstance(observed, dict), "flask config must print a JSON object")
    require(observed.keys() == expected.keys(),
            f"Unexpected config keys: missing {sorted(expected.keys() - observed.keys())}, "
            f"extra {sorted(observed.keys() - expected.keys())}")
    for key, value in expected.items():
        if any(marker in key for marker in SECRET_MARKERS):
            require(observed[key] == "***", f"Sensitive key {key} was not masked exactly as ***")
        elif key == "PERMANENT_SESSION_LIFETIME":
            lifetime = observed[key]
            valid = (lifetime == value or lifetime == 31 * 24 * 3600 or lifetime == "P31D" or
                     lifetime == {"days": 31, "seconds": 0, "microseconds": 0})
            require(valid, "Unexpected encoding of Flask's default 31-day session lifetime")
        else:
            require(json.dumps(observed[key], sort_keys=True) == json.dumps(value, sort_keys=True),
                    f"Unexpected value or type for non-sensitive config key {key}")
    require(not any(value in output for key, value in DEMO_CONFIG.items()
                    if any(marker in key for marker in SECRET_MARKERS)),
            "A synthetic sensitive value leaked into command output")
    print("flask --app ourloss_validation_app config" + ("" if full_json else " (selected output)"))
    if full_json:
        print(output.strip())
    else:
        print(json.dumps({key: observed[key] for key in DEMO_CONFIG}, ensure_ascii=False, indent=2))
    print(f"Task B verified: {len(changed)} changed files, {len(observed)} config keys "
          f"and {regression_id}.")


def verify_c(repo):
    status = git(repo, "status", "--porcelain=v1", "--untracked-files=all")
    require(not status, "Task C checkout has changes:\n" + status)
    print("git status --short -> (no output)")
    print(f"Task C workspace verified: clean Flask {TASKS['tag']} at {TASKS['commit'][:8]}.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("task", choices=("A", "B", "C", "all"))
    parser.add_argument("--repo", type=Path, default=HERE / "flask")
    parser.add_argument("--clean-repo", type=Path, default=HERE / "flask-clean")
    parser.add_argument("--show-full-json", action="store_true")
    arguments = parser.parse_args()
    repo = arguments.repo.resolve()
    clean_repo = arguments.clean_repo.resolve()
    try:
        if arguments.task in ("A", "B", "all"):
            pin(repo)
        if arguments.task in ("A", "all"):
            verify_a(repo, combined=arguments.task == "all")
        if arguments.task in ("B", "all"):
            verify_b(repo, full_json=arguments.show_full_json)
        if arguments.task in ("C", "all"):
            require(clean_repo != repo, "Use a separate pinned checkout for Task C.")
            pin(clean_repo)
            verify_c(clean_repo)
    except (OSError, subprocess.SubprocessError, VerificationError, SyntaxError, ValueError) as error:
        print(f"Verification failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
