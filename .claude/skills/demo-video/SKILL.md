---
name: demo-video
description: Create polished 1920x1080 web-app demo videos from a single YAML scenario using Playwright, with injected virtual cursor, click effects, subtitles, title cards, highlights, human-like motion and typing, and H.264 MP4 output.
---

# Demo video

Use this skill when a user wants an automated browser walkthrough or product demo video. Keep the scenario in one YAML file; reuse `scripts/demo-video.mjs` instead of writing a new Playwright flow.

## Run

From the project root, run:

```powershell
node .claude/skills/demo-video/scripts/demo-video.mjs path\to\scenario.yml
```

The script records at 1920x1080, injects all presentation overlays with `addInitScript`, writes intermediate WebM and final MP4 files under `out/`, and leaves a failure screenshot under `out/failure-*.png` when an action fails. It uses the project-local `ffmpeg-static` binary to produce H.264 `yuv420p` MP4 with `+faststart`.

## Scenario contract

The YAML has `url`, optional `output`, and an ordered `chapters` list. Each chapter may have `title`, `subtitle`, and `steps`. Steps support `wait`, `click` (`selector`), `type` (`selector`, `text`, optional `delay`), `highlight` (`selector`, optional `duration`), `move` (`selector`), `scroll` (`selector`, optional `duration`), `expand` (`selector`, optional `duration`), and `screenshot` (`name`). Optional step `caption` is shown as a lower-third subtitle; `click` also creates a visible click ring. `expand` grows a scrollable element (e.g. a `<textarea>` whose CSS caps its height) to fit its full content — `el.style.height = el.scrollHeight + 'px'` — so internal overflow doesn't hide content from the recording; use it before `highlight`/`scroll` on a textarea or panel whose content is taller than its visible box. Selectors are standard Playwright selectors. The included `scenario.example.yml` is the canonical minimal example.

## Invariants

- Keep overlays in the page DOM via `context.addInitScript`; browser video capture does not include the OS mouse pointer.
- Preserve curved, eased cursor motion and per-character typing delay unless the scenario explicitly overrides them.
- Keep the viewport and recording dimensions at exactly 1920x1080.
- Validate the final MP4 exists and is encoded as H.264/yuv420p; preserve the failure screenshot for diagnosis.
