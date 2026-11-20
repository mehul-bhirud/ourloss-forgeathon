# Live extension-host tests

These commands launch VS Code's Extension Development Host with an isolated editor profile and a fresh checkout of the pinned Flask commit. The host activates the actual OurLoss extension, drives its public editor operations and connects to your local TrueForge.

```powershell
node test/host/run.js C
node test/host/run.js A configured-provider/model
node test/host/run.js B configured-provider/model
node test/host/run.js C forge-unavailable/offline configured-provider/model
```

Prepare `demo/flask` at the version in `demo/tasks.json`. Tasks A and B use its virtual environment for Flask and pytest dependencies. The verifier imports source from each disposable checkout. Set `OURLOSS_HOST_PYTHON` to use another Flask-compatible interpreter or `OURLOSS_CODE` to select a different VS Code executable.

For a recording, set `OURLOSS_DEMO_DIR` to a fresh directory inside the project. Wait for `ready.json`, start the capture of the host window and create `start.signal`. The driver writes phase times to `phases.ndjson` and keeps the real terminal verification visible before exiting. The run's `result.json` identifies the workspace, ordered extension events and verification result.

Set `OURLOSS_REHEARSAL=1` for a recording that uses the review checks. Task A tests the candidate before accepting it. Task B first rehearses the test and documentation hunks without the implementation and then rehearses the complete selection. If a full check fails, the driver sends its diagnostic back to TrueForge and rehearses the revision. The driver allows up to two revisions for A and four for B, and checks the receipt and Git status after each rehearsal.

The recorder uses Pillow, imageio-ffmpeg and websocket-client. It connects to the isolated host's loopback debugging port, verifies visible first-frame pixels and writes the start signal itself. Launch it alongside the host with paths for the same recording directory:

```powershell
python demo/capture.py --match "OurLoss Forge-a-thon Task C" --ready demo/evidence/clip-c/ready.json --start demo/evidence/clip-c/start.signal --stop demo/evidence/clip-c/finished.signal --output demo/evidence/clip-c/capture.mp4
```

Assemble passing captures in A, B, C order. The editor stays on screen throughout each task. The assembler keeps the prompt-to-first-diff sequence continuous, adds captions below the editor and writes the observed scorecard timeline beside the MP4.

```powershell
python -m pip install Pillow imageio-ffmpeg websocket-client reportlab
python demo/assemble.py demo/evidence/clip-a demo/evidence/clip-b demo/evidence/clip-c --output output/OurLoss-Round1.mp4
python demo/writeup.py --final --evidence demo/round1-evidence.json
```
