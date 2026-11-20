"""Record the rendered workbench of a single isolated VS Code demo host."""

import argparse
import base64
from io import BytesIO
import json
from pathlib import Path
import re
import subprocess
import time
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, build_opener

import imageio_ffmpeg
from PIL import Image
import websocket


LOCAL_HTTP = build_opener(ProxyHandler({}))
EXPAND_AGENT_STEPS = """(() => {
    const card = document.querySelector('.aui-agent-steps-card');
    const button = card && [...card.querySelectorAll('button')]
        .find(item => item.textContent.includes('Agent steps'));
    if (!button) return false;
    const expanded = button.getAttribute('aria-expanded');
    if (expanded === 'false') button.click();
    if (expanded !== 'true') return false;
    button.scrollIntoView({block: 'start', behavior: 'instant'});
    return true;
})()"""


def wait_for_target(ready, port, title):
    until = time.monotonic() + 45
    while time.monotonic() < until:
        try:
            if ready is not None:
                port = int(json.loads(ready.read_text(encoding="utf8"))["cdpPort"])
            if not port or not 1024 <= port <= 65535:
                raise ValueError("Expected a local debug port from the isolated recording host.")
            with LOCAL_HTTP.open(f"http://127.0.0.1:{port}/json/list", timeout=1) as response:
                targets = json.load(response)
            workbenches = [
                target for target in targets if (
                    target["type"] == "page"
                    and target["url"].startswith("vscode-file://vscode-app/")
                    and urlsplit(target["url"]).path.endswith("/workbench.html")
                    and title.casefold() in target["title"].casefold()
                )
            ]
            if len(workbenches) == 1:
                address = workbenches[0]["webSocketDebuggerUrl"]
                parts = urlsplit(address)
                if parts.scheme != "ws" or parts.hostname != "127.0.0.1" or parts.port != port:
                    raise RuntimeError("The selected workbench has an unexpected debugger address.")
                return address, workbenches[0]["title"]
        except (OSError, ValueError, KeyError, URLError):
            pass
        time.sleep(0.15)
    raise RuntimeError("The named VS Code workbench did not appear on the recording port.")


class WorkbenchCapture:
    def __init__(self, url, timeout=5):
        self.connection = websocket.create_connection(
            url, timeout=timeout, suppress_origin=True, http_no_proxy=["127.0.0.1"],
        )
        self.request = 0

    def command(self, method, **params):
        self.request += 1
        self.connection.send(json.dumps({"id": self.request, "method": method, "params": params}))
        while True:
            response = json.loads(self.connection.recv())
            if response.get("id") != self.request:
                continue
            if "error" in response:
                raise RuntimeError(f"{method}: {response['error']['message']}")
            return response["result"]

    def frame(self):
        shot = self.command("Page.captureScreenshot", format="jpeg", quality=91, fromSurface=True)
        return base64.b64decode(shot["data"])

    def close(self):
        self.connection.close()


def expand_saved_session(phase_file, debug_port):
    """Open the official tool activity accordion in the matching local browser."""
    try:
        phase = json.loads(phase_file.read_text(encoding="utf8"))
        if phase.get("name") != "harness-session":
            return False
        url = phase["url"]
        parts = urlsplit(url)
        if (
            parts.scheme not in ("http", "https")
            or parts.hostname not in ("localhost", "127.0.0.1", "::1")
            or parts.username is not None or parts.password is not None
            or parts.query or parts.fragment
            or not re.fullmatch(r"/sessions/[A-Za-z0-9_-]{10,80}", parts.path)
        ):
            return False
        with LOCAL_HTTP.open(f"http://127.0.0.1:{debug_port}/json/list", timeout=0.4) as response:
            targets = [
                target for target in json.load(response)
                if target.get("type") == "page" and target.get("url") == url
            ]
        if len(targets) != 1:
            return False
        address = targets[0]["webSocketDebuggerUrl"]
        debugger = urlsplit(address)
        if (debugger.scheme != "ws" or debugger.hostname != "127.0.0.1"
                or debugger.port != debug_port or not debugger.path.startswith("/devtools/page/")
                or debugger.username is not None or debugger.password is not None):
            return False
        browser = WorkbenchCapture(address, timeout=0.4)
        try:
            result = browser.command("Runtime.evaluate", expression=EXPAND_AGENT_STEPS, returnByValue=True)
            return result.get("result", {}).get("value") is True
        finally:
            browser.connection.close(timeout=0.2)
    except (OSError, ValueError, KeyError, TypeError, AttributeError, RuntimeError, websocket.WebSocketException):
        return False


def image_details(frame):
    with Image.open(BytesIO(frame)) as image:
        dark, light = image.convert("L").getextrema()
        if light - dark < 18:
            raise RuntimeError("The isolated VS Code renderer did not produce visible workbench pixels.")
        return image.size


def encode(capture, initial, target, seconds, fps, start, stop, phase_file=None, debug_port=None):
    command = [
        imageio_ffmpeg.get_ffmpeg_exe(), "-hide_banner", "-loglevel", "error",
        "-f", "image2pipe", "-framerate", str(fps), "-vcodec", "mjpeg", "-i", "pipe:0",
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", str(target),
    ]
    with subprocess.Popen(command, stdin=subprocess.PIPE) as recorder:
        try:
            recorder.stdin.write(initial)
            beginning = time.monotonic()
            prior = initial
            frames = 1
            next_session_check = beginning
            if start:
                start.write_text("workbench pixels verified; capture started\n", encoding="utf8")
            while time.monotonic() < beginning + seconds and not (stop and stop.exists()):
                wait = beginning + frames / fps - time.monotonic()
                if wait > 0:
                    time.sleep(wait)
                now = time.monotonic()
                if phase_file is not None and now >= next_session_check:
                    next_session_check = now + 0.3
                    if expand_saved_session(phase_file, debug_port):
                        phase_file = None
                try:
                    frame = capture.frame()
                except (websocket.WebSocketException, OSError):
                    if stop and stop.exists():
                        break
                    raise
                target_frame = int((time.monotonic() - beginning) * fps)
                for _ in range(max(0, target_frame - frames)):
                    recorder.stdin.write(prior)
                    frames += 1
                recorder.stdin.write(frame)
                frames += 1
                prior = frame
        finally:
            recorder.stdin.close()
            code = recorder.wait(timeout=20)
    if code or not target.is_file():
        raise RuntimeError(f"The workbench video did not encode successfully ({code}).")
    return frames, prior


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--match", required=True, help="Unique title substring of the isolated demo window.")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--ready", type=Path, help="Driver readiness JSON containing the isolated debugging port.")
    parser.add_argument("--port", type=int, help="Local debugging port when ready.json is unavailable.")
    parser.add_argument("--start", type=Path, help="Create this signal after seeing the first workbench frame.")
    parser.add_argument("--stop", type=Path, help="Stop recording when this signal appears.")
    parser.add_argument("--seconds", type=int, default=235)
    parser.add_argument("--fps", type=int, default=8)
    args = parser.parse_args()
    if args.ready is None and args.port is None:
        parser.error("Provide --ready or --port from the isolated host.")
    if args.seconds <= 0 or not 2 <= args.fps <= 20:
        parser.error("Choose a positive duration and a rate from 2 to 20 frames per second.")
    if args.output.exists():
        raise FileExistsError(args.output)
    if any(path and path.exists() for path in (args.start, args.stop)):
        raise RuntimeError("Choose fresh start and stop signals.")
    address, title = wait_for_target(args.ready, args.port, args.match)
    capture = WorkbenchCapture(address)
    try:
        initial = capture.frame()
        width, height = image_details(initial)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.with_suffix(".first.jpg").write_bytes(initial)
        print(f"Recording {title} at {width}x{height}", flush=True)
        phase_file = args.ready.with_name("phase.json") if args.ready else None
        frames, final = encode(
            capture, initial, args.output, args.seconds, args.fps, args.start, args.stop,
            phase_file=phase_file, debug_port=urlsplit(address).port,
        )
        args.output.with_suffix(".last.jpg").write_bytes(final)
        print(f"Saved {frames} frames to {args.output}", flush=True)
    finally:
        capture.close()


if __name__ == "__main__":
    main()
