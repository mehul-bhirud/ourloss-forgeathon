"""Assemble verified A, B and C screen recordings and the scorecard timeline."""

import argparse
from dataclasses import dataclass
import json
import math
import os
from pathlib import Path
import re
import subprocess
import tempfile

import imageio_ffmpeg
from PIL import Image, ImageDraw, ImageFont


WIDTH, WORKBENCH_HEIGHT, HEIGHT = 1920, 1200, 1260
FPS = 8
INTRO_SECONDS = 1.75
MAX_SECONDS = 239.8
BACKGROUND = "#141a23"
TEXT = "#e6edf5"
MUTED = "#aab9cb"
ACCENT = "#8ec8f8"
TASK_NAMES = {"A": "Inline edit", "B": "Repository change", "C": "Failure and recovery"}
PROJECT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Recording:
    task: str
    path: Path
    phases: list
    duration: float
    fps: float


def ffmpeg(args, **kwargs):
    return subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), *args], **kwargs)


def media_info(filename):
    result = ffmpeg(["-hide_banner", "-i", str(filename)], capture_output=True, text=True)
    duration = re.search(r"Duration: (\d+):(\d+):(\d+\.\d+)", result.stderr)
    size = re.search(r"Stream #.*Video:.*?\b(\d{3,5})x(\d{3,5})\b", result.stderr)
    rate = re.search(r"\b(\d+(?:\.\d+)?) fps", result.stderr)
    if not duration or not size or not rate:
        raise ValueError(f"Unreadable video: {filename}")
    hours, minutes, seconds = map(float, duration.groups())
    return hours * 3600 + minutes * 60 + seconds, tuple(map(int, size.groups())), float(rate[1])


def load_clip(directory, task):
    capture = (directory / "capture.mp4").resolve()
    phases = [json.loads(line) for line in (directory / "phases.ndjson").read_text(encoding="utf8").splitlines()]
    if not phases or any(phase["task"] != task for phase in phases):
        raise ValueError(f"The recording directory for Task {task} contains mismatched phases")
    if phases[-1]["name"] != "finished" or not phases[-1]["passed"]:
        raise ValueError(f"Task {task} did not finish successfully")
    start = (directory / "start.signal").stat().st_mtime
    duration, _, fps = media_info(capture)
    if abs(fps - FPS) > 0.001:
        raise ValueError(f"Task {task} needs an {FPS} fps workbench capture")
    events = [
        {**phase, "source_seconds": phase["time"] / 1000 - start}
        for phase in phases if phase["name"] not in ("ready", "finished")
    ]
    prompts = [event for event in events if event["name"] == "prompt"]
    result_path = phases[-1].get("resultFile")
    if prompts and result_path:
        result = Path(result_path).resolve()
        if result.is_relative_to(PROJECT / ".local" / "host") and result.is_file():
            recorded = json.loads(result.read_text(encoding="utf8"))
            begin = next((event for event in recorded.get("events", []) if event["type"] == "begin"), None)
            if begin:
                offset = prompts[0]["source_seconds"] - begin["elapsedMs"] / 1000
                for event in recorded["events"]:
                    if event["type"] in ("applied", "context"):
                        events.append({"name": event["type"], "source_seconds": offset + event["elapsedMs"] / 1000})
    events = [event for event in events if 0 <= event["source_seconds"] < duration]
    events.sort(key=lambda event: event["source_seconds"])
    if not any(event["name"] == "verification" and event.get("passed") for event in events):
        raise ValueError(f"Task {task} has no on-screen terminal verification")
    if task in "AB":
        visible = {event["name"] for event in events}
        if "prompt" not in visible or not visible.intersection({"first-diff", "preview"}):
            raise ValueError(f"Task {task} has no captured prompt-to-diff sequence")
    if task == "B" and "harness-session" not in {event["name"] for event in events}:
        raise ValueError("Task B must show its actual TrueForge session")
    return Recording(task, capture, events, duration, fps)


def font(size, bold=False):
    windows = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
    candidates = [
        windows / ("segoeuib.ttf" if bold else "segoeui.ttf"),
        Path("/usr/share/fonts/truetype/dejavu") / ("DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"),
    ]
    family = next((item for item in candidates if item.is_file()), None)
    return ImageFont.truetype(str(family), size) if family else ImageFont.load_default(size=size)


def title_card(path):
    image = Image.new("RGB", (WIDTH, HEIGHT), BACKGROUND)
    draw = ImageDraw.Draw(image)
    draw.line((140, 407, 210, 407), fill=ACCENT, width=4)
    draw.text((140, 444), "TrueFoundry Forge-a-thon  ·  Techfest IIT Bombay", fill=MUTED, font=font(30))
    draw.text((132, 493), "OurLoss", fill=TEXT, font=font(124, bold=True))
    draw.text((140, 657), "Verify selected hunks before applying changes", fill=ACCENT, font=font(42))
    draw.text((140, 739), "Mehul Bhirud  ·  Team OurLoss  ·  IIIT Pune", fill=MUTED, font=font(28))
    image.save(path)


def footer(path, task, caption):
    image = Image.new("RGB", (WIDTH, HEIGHT - WORKBENCH_HEIGHT), BACKGROUND)
    draw = ImageDraw.Draw(image)
    draw.line((0, 0, WIDTH, 0), fill="#3a4b60", width=2)
    draw.text((25, 29), task + "  /  " + TASK_NAMES[task], fill=ACCENT, font=font(23, bold=True), anchor="lm")
    draw.line((320, 16, 320, 43), fill="#3a4b60", width=2)
    draw.text((348, 29), caption, fill=TEXT, font=font(23), anchor="lm")
    image.save(path)


def visible_caption(recording, phase):
    task = recording.task
    name = phase["name"]
    if name == "prompt":
        if task == "C" and phase != next(event for event in recording.phases if event["name"] == "prompt"):
            return "Start a fresh turn to demonstrate cancellation"
        return {
            "A": "Select the Flask helper and enter the exact inline instruction",
            "B": "Send one request · the agent discovers the relevant files",
            "C": "Start with a deliberately unreachable model endpoint",
        }[task]
    if name == "first-diff":
        return "The first native diff appears before the workspace changes"
    if name == "preview" and task != "C":
        return "Review the proposed changes one hunk at a time"
    if name == "context":
        return "TrueForge receives relevant excerpts with reasons and a visible byte budget"
    if name == "applied":
        return "Apply only the reviewed hunks"
    if name in ("rehearsal-subset", "rehearsal-full"):
        if phase.get("candidate") == "failed":
            return "The selected hunks fail the isolated check"
        if phase.get("candidate") == "passed":
            return "The selected hunks pass in an isolated workspace"
    if name == "revision-requested":
        return "Send the failed check back to the same TrueForge session"
    if name == "undo":
        return "Undo restores the original editor content and clean checkout"
    if name == "harness-session":
        return "The actual TrueForge session records the model’s tool calls"
    if name == "session" and task == "C":
        sessions = [event for event in recording.phases if event["name"] == "session"]
        if len(sessions) > 1 and phase["id"] == sessions[1]["id"] and phase["model"] != sessions[0]["model"]:
            return "A separately configured model takes over automatically"
    if name == "failure-visible":
        if any(event["name"] == "preview" for event in recording.phases):
            return "The fallback draft is rejected and the checkout remains clean"
        return "The editor reports the provider failure and the checkout stays clean"
    if name == "cancelled-live-turn":
        return "Cancel a live TrueForge turn from the editor"
    if name == "verification":
        return {
            "A": "Terminal verification · FLASK_DEBUG=off returns False",
            "B": "The Flask CLI suite passes and the live command masks sensitive values",
            "C": "Terminal verification · git status --short reports a clean checkout",
        }[task]
    return None


def merge_ranges(ranges, duration):
    selected = []
    limit = round(duration * FPS)
    for left, right in sorted(ranges):
        start, end = max(0, math.floor(left * FPS)), min(limit, math.ceil(right * FPS))
        if end <= start:
            continue
        if selected and start <= selected[-1][1]:
            selected[-1] = (selected[-1][0], max(selected[-1][1], end))
        else:
            selected.append((start, end))
    return selected


def timeline_range(recording, condensed=False):
    if not condensed:
        return merge_ranges([(0, recording.duration)], recording.duration)
    first_diff = next((event for event in recording.phases if event["name"] == "first-diff"), None)
    if first_diff is None:
        first_diff = next((event for event in recording.phases if event["name"] == "preview"), None)
    if first_diff is None:
        return merge_ranges([(0, recording.duration)], recording.duration)
    result = [(0, first_diff["source_seconds"] + 2)]
    holds = {"preview": 2.5, "rehearsal-subset": 2.5, "rehearsal-full": 3.4, "applied": 1.5,
             "revision-requested": 1.2, "harness-session": 4.1, "verification": recording.duration}
    if recording.task == "A":
        holds.update({"undo": 2.0, "undo-saved": 1.0})
    if recording.task == "C":
        holds["failure-visible"] = recording.duration
    for phase in recording.phases:
        if phase["name"] not in holds:
            continue
        time = phase["source_seconds"]
        result.append((time - 0.45, time + holds[phase["name"]]))
    return merge_ranges(result, recording.duration)


def source_to_video(ranges, source):
    frame = source * FPS
    previous = 0
    for a, b in ranges:
        if a <= frame < b:
            return (previous + frame - a) / FPS
        previous += b - a
    return None


def captions(recording, ranges):
    initial = {
        "A": "Flask 3.1.3 · selected function",
        "B": "Flask 3.1.3 · repository request",
        "C": "Flask 3.1.3 · recovery on a clean checkout",
    }[recording.task]
    result = {0: initial}
    for phase in recording.phases:
        text = visible_caption(recording, phase)
        shifted = source_to_video(ranges, phase["source_seconds"])
        if text and shifted is not None:
            result[max(0, math.ceil(shifted * FPS))] = text
    return sorted(result.items())


def encoder_args():
    return ["-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p",
            "-video_track_timescale", "8000"]


def render_title(directory):
    image, output = directory / "title.png", directory / "intro.mp4"
    title_card(image)
    ffmpeg(["-v", "error", "-n", "-loop", "1", "-framerate", str(FPS), "-i", str(image),
            "-t", str(INTRO_SECONDS), *encoder_args(), str(output)], check=True)
    return output


def render_clip(recording, ranges, directory):
    output = directory / (recording.task + ".mp4")
    inputs = ["-i", str(recording.path)]
    filters = []
    cuts = len(ranges)
    if cuts == 1:
        start, end = ranges[0]
        filters.append(f"[0:v]trim=start_frame={start}:end_frame={end},setpts=PTS-STARTPTS[seq]")
    else:
        filters.append(f"[0:v]split={cuts}" + "".join(f"[raw{idx}]" for idx in range(cuts)))
        for idx, (start, end) in enumerate(ranges):
            filters.append(f"[raw{idx}]trim=start_frame={start}:end_frame={end},setpts=PTS-STARTPTS[cut{idx}]")
        filters.append("".join(f"[cut{idx}]" for idx in range(cuts)) + f"concat=n={cuts}:v=1:a=0[seq]")
    filters.append(
        f"[seq]scale={WIDTH}:{WORKBENCH_HEIGHT}:force_original_aspect_ratio=decrease:force_divisible_by=2,"
        f"pad={WIDTH}:{HEIGHT}:(ow-iw)/2:({WORKBENCH_HEIGHT}-ih)/2:{BACKGROUND},setsar=1[body0]"
    )
    schedule = captions(recording, ranges)
    frame_count = sum(end - start for start, end in ranges)
    for idx, (start, caption) in enumerate(schedule):
        image = directory / f"{recording.task}-caption-{idx}.png"
        footer(image, recording.task, caption)
        inputs.extend(["-i", str(image)])
        end = schedule[idx + 1][0] if idx + 1 < len(schedule) else frame_count
        filters.append(
            f"[body{idx}][{idx + 1}:v]overlay=x=0:y={WORKBENCH_HEIGHT}:"
            f"enable='gte(n,{start})*lt(n,{end})'[body{idx + 1}]"
        )
    ffmpeg(["-v", "error", "-n", *inputs, "-filter_complex_threads", "1",
            "-filter_complex", ";".join(filters), "-map", f"[body{len(schedule)}]",
            "-frames:v", str(frame_count), "-r", str(FPS), *encoder_args(), str(output)], check=True)
    return output


def quote_manifest(path):
    return "'" + path.as_posix().replace("'", "'\\''") + "'"


def assemble(recordings, output, preview=False):
    output.parent.mkdir(parents=True, exist_ok=True)
    condensed = INTRO_SECONDS + sum(recording.duration for recording in recordings) > MAX_SECONDS
    ranges = [timeline_range(recording, condensed and recording.task == "B") for recording in recordings]
    expected_seconds = INTRO_SECONDS + sum(end - start for part in ranges for start, end in part) / FPS
    if expected_seconds > MAX_SECONDS:
        ranges = [timeline_range(recording, True) for recording in recordings]
        expected_seconds = INTRO_SECONDS + sum(end - start for part in ranges for start, end in part) / FPS
    if expected_seconds > MAX_SECONDS:
        raise ValueError("The protected prompt-to-diff sequences and verification moments exceed the four-minute limit")
    timeline = []
    source_segments = []
    with tempfile.TemporaryDirectory(prefix="ourloss-assembly-", dir=output.parent) as temporary:
        directory = Path(temporary)
        intro = render_title(directory)
        parts = [intro]
        offset = media_info(intro)[0]
        for recording, selected in zip(recordings, ranges):
            part = render_clip(recording, selected, directory)
            parts.append(part)
            for phase in recording.phases:
                seconds = source_to_video(selected, phase["source_seconds"])
                if seconds is not None:
                    timeline.append({"task": recording.task, "phase": phase["name"],
                                     "seconds": round(offset + seconds, 3),
                                     "source_seconds": round(phase["source_seconds"], 3)})
            for start, end in selected:
                source_segments.append({"task": recording.task, "source_start": start / FPS, "source_end": end / FPS})
            offset += media_info(part)[0]
        manifest = directory / "segments.txt"
        manifest.write_text("ffconcat version 1.0\n" + "".join(
            f"file {quote_manifest(part)}\n" for part in parts
        ), encoding="utf8")
        ffmpeg(["-v", "error", "-n", "-f", "concat", "-safe", "0", "-i", str(manifest),
                "-c", "copy", "-movflags", "+faststart", str(output)], check=True)
    duration, size, fps = media_info(output)
    if duration > 240 or abs(duration - expected_seconds) > 0.2 or size != (WIDTH, HEIGHT) or fps != FPS:
        raise ValueError(f"Unexpected render dimensions, frame rate or duration: {duration:.2f}s, {size}, {fps} fps")
    return {"duration": duration, "size": list(size), "fps": fps, "preview": preview,
            "condensed": condensed, "events": timeline, "source_segments": source_segments}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("recordings", nargs="+", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--preview-ac", action="store_true", help="Render a diagnostic A/C preview while B is pending.")
    args = parser.parse_args()
    tasks = "AC" if args.preview_ac else "ABC"
    if len(args.recordings) != len(tasks):
        parser.error(f"Provide Task {' and '.join(tasks)} recording directories in that order.")
    if args.output.exists():
        raise FileExistsError(args.output)
    records = [load_clip(path, task) for path, task in zip(args.recordings, tasks)]
    report = assemble(records, args.output.resolve(), preview=args.preview_ac)
    args.output.with_suffix(".timeline.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf8")
    print(f"Recorded {report['duration']:.2f} seconds with {'A/C preview' if args.preview_ac else 'all three'} verification sections.")


if __name__ == "__main__":
    main()
