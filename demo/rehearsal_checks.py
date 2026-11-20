"""Independent behavior probes for a Flask source snapshot."""

import json
import os
import re
import sys
import traceback
from pathlib import Path

from verify_flask import (
    DEMO_CONFIG, HERE, SECRET_MARKERS, TASKS, VerificationError, config_guides,
    find_config_regression, git_file, pytest, require,
)


def check_a():
    from flask.helpers import get_debug_flag

    false_cases = (None, "", "0", "false", "FaLsE", "no", "No", "off", "oFf", "n", "N")
    true_cases = ("1", "yes", "on", "true", "unrelated", " off ", "unset", "empty")
    failures = []
    for value, expected in [(value, False) for value in false_cases] + [(value, True) for value in true_cases]:
        if value is None:
            os.environ.pop("FLASK_DEBUG", None)
        else:
            os.environ["FLASK_DEBUG"] = value
        if get_debug_flag() is not expected:
            failures.append(f"FLASK_DEBUG={value!r} should produce {expected}")
    doc = get_debug_flag.__doc__ or ""
    names = ("0", "false", "no", "off", "n")
    missing = [name for name in names if not re.search(rf"(?<!\w){re.escape(name)}(?!\w)", doc, re.I)]
    if not re.search(r"\b(?:unset|missing|absent|not\s+(?:set|defined|present|provided)|none)\b", doc, re.I):
        missing.append("unset")
    if not re.search(r"\b(?:empty|blank)\b|''|\"\"", doc, re.I):
        missing.append("empty")
    quoted = re.findall(r"[\"'](?:unset|empty|none)[\"']", doc, re.I)
    outcome = "Runtime failures: " + ", ".join(failures) if failures else "All 19 runtime cases already pass."
    if missing:
        outcome += " Docstring must also cover " + ", ".join(missing) + "."
        if not failures:
            outcome += " Update only the docstring and leave executable lines unchanged."
    if quoted:
        outcome += " The docstring should distinguish the absent variable and empty string from literal strings such as 'unset' or 'empty'."
    require(not failures and not missing and not quoted, outcome)
    print("FLASK_DEBUG=off -> False. All 19 behavior cases and the complete docstring passed.")


def check_b():
    from click.testing import CliRunner
    from flask import Flask
    from flask.cli import ScriptInfo, cli

    app = Flask(__name__)
    app.config.update(DEMO_CONFIG)
    info = ScriptInfo(create_app=lambda: app)
    runner = CliRunner()
    help_result = runner.invoke(cli, ["--help"], obj=info)
    require(help_result.exit_code == 0 and re.search(r"(?m)^\s{2,}config(?:[ \t]+.*)?$", help_result.output),
            "flask --help does not list config")
    result = runner.invoke(cli, ["config"], obj=info)
    require(result.exit_code == 0, f"flask config failed: {result.exception or result.output}")
    data = json.loads(result.output)
    require(isinstance(data, dict) and data.keys() == app.config.keys(), "Expected the complete Flask config object")
    confidential = [key for key in data if any(marker in key for marker in SECRET_MARKERS)]
    for key in confidential:
        require(data[key] == "***", f"{key} was not masked")
    for key in ("DEMO_RETRIES", "DEMO_THEME"):
        require(data[key] == DEMO_CONFIG[key], f"{key} did not retain its public JSON value")
    require(all(str(DEMO_CONFIG[key]) not in result.output for key in confidential if key in DEMO_CONFIG),
            "A synthetic secret appeared in JSON")
    print(f"flask --help lists config. JSON has {len(data)} keys, {len(confidential)} masked and public values preserved.")
    root = Path.cwd()
    candidates = [path.relative_to(root).as_posix() for path in (root / "docs").rglob("*.rst")]
    config_guides(root, candidates, lambda file: git_file(HERE / "flask", TASKS["commit"], file))
    candidates = [path.relative_to(root).as_posix() for path in (root / "tests").rglob("test_*.py")]
    _, regression_id = find_config_regression(root, candidates, compare_to_head=False)
    print(pytest(root, regression_id, "--tb=short"))


def main():
    root = Path.cwd()
    sys.path.insert(0, str(root / "src"))
    try:
        import flask

        require(Path(flask.__file__).resolve().is_relative_to(root / "src"), "Flask was imported outside this snapshot")
        {"A": check_a, "B": check_b}[sys.argv[1]]()
    except (VerificationError, ValueError, KeyError) as error:
        print(error, file=sys.stderr)
        return 1
    except Exception as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        frames = [frame for frame in traceback.extract_tb(error.__traceback__)
                  if Path(frame.filename).is_relative_to(root / "src")]
        for frame in frames[-3:]:
            file = Path(frame.filename).relative_to(root).as_posix()
            print(f"{file}:{frame.lineno} {frame.line or frame.name}", file=sys.stderr)
        if sys.argv[1] == "B" and isinstance(error, NameError) and any(frame.name == "<module>" for frame in frames):
            print("Define the missing name before the module-level statement that needs it.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
