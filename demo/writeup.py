"""Generate the two-page OurLoss submission write-up with ReportLab.

Run with --template to print an editable evidence document. Pass that document
through --evidence after filling in the observed outcomes and video timestamps.
"""

import argparse
from html import escape
from io import BytesIO
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import (
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[1]
NAVY = colors.HexColor("#102532")
SLATE = colors.HexColor("#435B65")
TEAL = colors.HexColor("#006A64")
RULE = colors.HexColor("#D8E5E5")
PALE = colors.HexColor("#F2F7F7")

CRITERIA = (
    ("A1", "Inline edit"),
    ("A2", "Agent mode"),
    ("A3", "Streaming and cancellation"),
    ("B1", "Context assembly"),
    ("B2", "Diff safety"),
    ("B3", "Resilience (Task C)"),
    ("B4", "TrueForge integration depth"),
    ("C1", "Video"),
    ("C2", "Write-up"),
)

SECTIONS = (
    ("team", "1. Team"),
    ("starting_point", "2. Starting point"),
    ("architecture", "3. Architecture on TrueForge"),
    ("context", "4. How context is selected"),
    ("model_setup", "5. Model setup"),
    ("tools", "7. Tools used"),
    ("limitations", "8. Known limitations and what you would do with another month"),
)

MODEL_TRIALS = (
    "Development also tried local Ollama Qwen2.5 7B, Qwen2.5-Coder 7B and Qwen3 8B/14B. "
    "Hosted trials used Groq Qwen3.8 27B and GPT-OSS 20B/120B, Google Gemini 3.1/3.5 Flash-Lite "
    "and 3.6/3.8 Flash plus Gemma 4 31B, and OpenRouter Gemma 4 31B and Nemotron Ultra. "
    "Hosted attempts used free tiers, for approximately USD 0 in model API charges."
)

DEFAULTS = {
    "team": "Team OurLoss. Mehul Bhirud, Indian Institute of Information Technology Pune, GitHub mehul-bhirud.",
    "starting_point": (
        "The extension was built from scratch. The competition workspace is the Flask 3.1.3 "
        "release at commit 22d924701a6ae2e4cd01e9a15bbaf3946094af65."
    ),
    "architecture": [
        "The extension streams local TrueForge 0.185.1 turns over HTTP. Its authenticated "
        "loopback MCP connector exposes selected text, workspace search, excerpts, outlines, "
        "in-memory edits, syntax checks, review, and read-only Git inspection. TrueForge "
        "dispatches the model's tool calls and pauses on review_changes.",
        "The editor shows a native diff and can run the same configured check on temporary "
        "baseline and selected-hunk snapshots. Changing the selection clears the result. "
        "A reviewer can return a failed diagnostic as a same-turn denial and request a "
        "revised draft. On approval, the editor checks the base and applies the selected "
        "hunks in one text edit batch. A verified selection's evidence ID and verdicts go "
        "back to TrueForge with the apply result.",
    ],
    "context": [
        "The full instruction ranks tracked text by BM25-style term scores and filename "
        "matches. A related test or guide can move up the ranking, and explicit @file or "
        "@symbol references take priority. The editor shows the chosen paths, line ranges, "
        "ranking reasons and byte budget.",
        "The default automatic packet limit is 2,400 UTF-8 bytes. The agent can search "
        "again and read narrow ranges. The default agent loads the outline tool on demand "
        "to keep its schema out of turns that need only excerpts.",
    ],
    "model_setup": [
        "Tasks A and C use Qwen3-4B-Instruct-2507 through local Ollama. Task C starts with a "
        "deliberately unreachable endpoint and automatically switches to the local model.",
        MODEL_TRIALS,
        "Register a provider in TrueForge, then set its provider/model alias via Models in "
        "the VS Code panel or through ourloss.model. Set ourloss.fallbackModel for automatic "
        "recovery. TrueForge holds the model credentials and makes the inference calls.",
    ],
    "tools": (
        "OpenAI Codex assisted the design, implementation and testing. The build uses "
        "VS Code, TrueForge, Node.js, Git, and Python. Ollama served the local models. "
        "The VS Code extension-host driver ran the recorded operations and checks. "
        "Python captured the editor and ReportLab generated this PDF."
    ),
    "limitations": (
        "The editor reviews text edits to existing files. It reports save failures per file. "
        "Behavioral checks require available dependencies and a trusted verifier, and a pass "
        "covers the cases that verifier ran. With another month, we would add language-service "
        "symbol links, isolate check execution, and evaluate model reliability across repositories."
    ),
}

BODY = ParagraphStyle("body", fontName="Helvetica", fontSize=10.5, leading=15.3, textColor=NAVY, spaceAfter=6)
HEADING = ParagraphStyle("heading", fontName="Helvetica-Bold", fontSize=13.5, leading=17, textColor=NAVY, spaceBefore=11, spaceAfter=6)
TITLE = ParagraphStyle("title", fontName="Helvetica-Bold", fontSize=31, leading=35, textColor=NAVY, spaceAfter=5)
SUBTITLE = ParagraphStyle("subtitle", fontName="Helvetica", fontSize=13.5, leading=18, textColor=SLATE, spaceAfter=13)
LABEL = ParagraphStyle("label", fontName="Helvetica-Bold", fontSize=9, leading=13, textColor=TEAL, spaceAfter=4)
CELL = ParagraphStyle("cell", parent=BODY, fontSize=9.6, leading=13.0, spaceAfter=0)
CELL_HEAD = ParagraphStyle("tableHead", parent=CELL, fontName="Helvetica-Bold", textColor=colors.white)
NOTE = ParagraphStyle("note", parent=BODY, fontSize=9.4, leading=13, textColor=SLATE, spaceAfter=8)


def para(text, style=BODY):
    return Paragraph(escape(text.replace("\u2013", "-").replace("\u2014", "-")).replace("\n", "<br/>"), style)


def body(evidence, key, heading):
    value = evidence.get(key, DEFAULTS[key])
    paragraphs = value if isinstance(value, list) else [value]
    if not paragraphs or any(not isinstance(text, str) or not text.strip() for text in paragraphs):
        raise ValueError(f"{key} must contain text or a list of text paragraphs")
    return KeepTogether([para(heading, HEADING), *(para(text.strip()) for text in paragraphs)])


def link(label, url):
    if not url:
        return ""
    if not isinstance(url, str):
        raise ValueError(f"{label} URL must be text")
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError(f"{label} URL must use HTTP or HTTPS")
    return f'<link href="{escape(url, quote=True)}" color="#006A64">{escape(label)}</link>'


def scorecard(evidence, width, final):
    scores = evidence.get("scores", {})
    if not isinstance(scores, dict):
        raise ValueError("scores must be an object keyed by criterion")
    unknown = set(scores) - {code for code, _ in CRITERIA}
    if unknown:
        raise ValueError(f"Unknown scorecard criterion {', '.join(sorted(unknown))}")
    duration = evidence.get("video_seconds", 240)
    if type(duration) not in (int, float) or not 0 < duration <= 240:
        raise ValueError("video_seconds must be within the four-minute limit")
    rows = [[para(name, CELL_HEAD) for name in ("Criterion", "Video", "One-line claim")]]
    for code, name in CRITERIA:
        entry = scores.get(code, {})
        if not isinstance(entry, dict):
            raise ValueError(f"{code} must contain timestamp and claim fields")
        timestamp = entry.get("timestamp", "")
        claim = entry.get("claim", "")
        if not isinstance(timestamp, str) or not isinstance(claim, str):
            raise ValueError(f"{code} timestamp and claim must be text")
        if timestamp:
            if not re.fullmatch(r"0?[0-4]:[0-5]\d", timestamp):
                raise ValueError(f"{code} timestamp must be a video time in MM:SS")
            minutes, seconds = map(int, timestamp.split(":"))
            if 60 * minutes + seconds >= duration:
                raise ValueError(f"{code} timestamp exceeds the video duration")
        if timestamp and not claim.strip():
            raise ValueError(f"{code} needs a claim for its timestamp")
        if final and not claim.strip():
            raise ValueError(f"{code} needs an observed outcome or an explicit scope statement")
        missing = "Unshown" if final else "Pending"
        rows.append([
            Paragraph(f"<b>{code}</b>  {escape(name)}", CELL),
            para(timestamp or ("PDF" if code == "C2" and claim.strip() else missing), CELL),
            para(claim.strip() or "Evidence pending.", CELL),
        ])
    table = Table(rows, colWidths=[152, 60, width - 212], repeatRows=1, hAlign="LEFT")
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [PALE, colors.white]),
        ("LINEBELOW", (0, 0), (-1, 0), 1.6, TEAL),
        ("LINEBELOW", (0, len(rows)-1), (-1, len(rows)-1), .65, RULE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 9),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    return table


def draw_footer(canvas, document):
    canvas.saveState()
    width, _ = document.pagesize
    left, right = document.leftMargin + 6, width - document.rightMargin - 6
    canvas.setStrokeColor(RULE)
    canvas.line(left, 43, right, 43)
    canvas.setFillColor(SLATE)
    canvas.setFont("Helvetica", 8.5)
    canvas.drawString(left, 28, "Team OurLoss  /  Forge-a-thon Round 1")
    canvas.drawRightString(right, 28, str(document.page))
    canvas.restoreState()


def render(evidence, final=False):
    if not isinstance(evidence, dict):
        raise ValueError("Evidence must be a JSON object")
    output = BytesIO()
    document = SimpleDocTemplate(
        output, pagesize=A4, rightMargin=57, leftMargin=57, topMargin=57, bottomMargin=64,
        title="OurLoss for VS Code", author="Mehul Bhirud, Team OurLoss",
    )
    links = [link("Public repository", evidence.get("repo_url")), link("Demo video", evidence.get("demo_url"))]
    status_label = evidence.get("status_label", "")
    if not isinstance(status_label, str):
        raise ValueError("status_label must be text")
    story = [
        para("TECHFEST IIT BOMBAY / TRUEFOUNDRY FORGE-A-THON", LABEL),
        para("OurLoss for VS Code", TITLE),
        para("Verify selected changes before applying them", SUBTITLE),
    ]
    if status_label.strip():
        story.append(para(status_label.strip(), LABEL))
    if any(links):
        story.append(Paragraph("  /  ".join(item for item in links if item), NOTE))
    story.extend(body(evidence, key, heading) for key, heading in SECTIONS[:5])
    story += [
        PageBreak(),
        para("6. Scorecard", HEADING),
        scorecard(evidence, document.width - 12, final),
        Spacer(1, 7),
        *(body(evidence, key, heading) for key, heading in SECTIONS[5:]),
    ]
    document.build(story, onFirstPage=draw_footer, onLaterPages=draw_footer)
    if not 1 <= document.page <= 3:
        raise ValueError("Keep the write-up within three pages. Shorten the evidence paragraphs.")
    return output.getvalue()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, help="JSON with observed results and optional section overrides")
    parser.add_argument("--output", type=Path, default=ROOT / "output" / "pdf" / "OurLoss-Round1.pdf")
    parser.add_argument("--template", action="store_true", help="Print the editable evidence JSON template")
    parser.add_argument("--final", action="store_true", help="Require an observed outcome or scope statement for every criterion")
    options = parser.parse_args()
    if options.template:
        print(json.dumps({
            "repo_url": "",
            "demo_url": "",
            "status_label": "",
            "video_seconds": 240,
            **DEFAULTS,
            "scores": {code: {"timestamp": "", "claim": ""} for code, _ in CRITERIA},
        }, indent=2, ensure_ascii=False))
        return
    try:
        evidence = json.loads(options.evidence.read_text(encoding="utf-8-sig")) if options.evidence else {}
        pdf = render(evidence, final=options.final)
    except (ValueError, OSError) as error:
        parser.error(str(error))
    options.output.parent.mkdir(parents=True, exist_ok=True)
    options.output.write_bytes(pdf)
    print(options.output.resolve())


if __name__ == "__main__":
    main()
