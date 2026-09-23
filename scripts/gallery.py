"""Emit a per-frame Obsidian gallery: every frame embedded, with the transcript
cue covering that frame's timestamp printed underneath.

Unlike the watch-and-index skill's frames.py (periodic + scene sampling, capped),
this emits EVERY frame. Used when full-fidelity flipbook output is explicitly wanted.

Usage:
  python gallery.py --srt <source.srt> --frames-dir <dir> --rel frames/01 --fps 30 --out gallery.md
"""

import argparse
import re
from pathlib import Path

CUE_TIME = re.compile(
    r"(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})"
)


def parse_srt(path):
    """Return [(start_sec, end_sec, text)] from an SRT/VTT file."""
    cues = []
    raw = Path(path).read_text(encoding="utf-8", errors="replace")
    blocks = re.split(r"\n\s*\n", raw)
    for block in blocks:
        m = CUE_TIME.search(block)
        if not m:
            continue
        g = [int(x) for x in m.groups()]
        start = g[0] * 3600 + g[1] * 60 + g[2] + g[3] / 1000.0
        end = g[4] * 3600 + g[5] * 60 + g[6] + g[7] / 1000.0
        lines = [l.strip() for l in block.splitlines()]
        text = " ".join(
            l for l in lines
            if l and not CUE_TIME.search(l) and not l.strip().isdigit()
            and l.strip().upper() != "WEBVTT"
        ).strip()
        if text:
            cues.append((start, end, text))
    cues.sort(key=lambda c: c[0])
    return cues


def caption_for(t, cues, idx_hint=0):
    """Cue covering time t. Returns (text, new_hint). Cues are sorted, so we
    walk forward from the last hit instead of rescanning the whole list."""
    i = idx_hint
    while i < len(cues) and cues[i][1] <= t:
        i += 1
    if i < len(cues) and cues[i][0] <= t < cues[i][1]:
        return cues[i][2], i
    return None, i


def mmss(t):
    return f"{int(t // 60):02d}:{t % 60:05.2f}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--srt", required=True)
    ap.add_argument("--frames-dir", required=True)
    ap.add_argument("--rel", required=True, help="vault-relative path prefix, e.g. frames/01")
    ap.add_argument("--fps", type=float, default=30.0)
    ap.add_argument("--out", required=True)
    ap.add_argument("--heading", default=None)
    args = ap.parse_args()

    cues = parse_srt(args.srt)
    frames = sorted(Path(args.frames_dir).glob("*.jpg"))
    if not frames:
        raise SystemExit(f"no frames found in {args.frames_dir}")

    out = []
    if args.heading:
        out.append(args.heading)
        out.append("")

    hint = 0
    covered = 0
    for n, f in enumerate(frames, start=1):
        t = (n - 1) / args.fps
        text, hint = caption_for(t, cues, hint)
        if text:
            covered += 1
        else:
            text = "—"
        out.append(f"![[{args.rel}/{f.name}]]")
        out.append(f"`{mmss(t)}` — {text}")
        out.append("")

    Path(args.out).write_text("\n".join(out), encoding="utf-8")
    print(f"frames={len(frames)} cues={len(cues)} captioned={covered} "
          f"gaps={len(frames) - covered} out={args.out}")


if __name__ == "__main__":
    main()
