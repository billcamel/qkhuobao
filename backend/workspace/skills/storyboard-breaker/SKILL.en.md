---
name: storyboard-breaker
description: Storyboard design rules — script scene → segment → shot → beat, with every panel's visuals, camera, sound, and connecting states
---

# Storyboard Design Guide

The storyboard turns a script scene into an executable plan: it constrains the later storyboard image, the video prompt, and video generation, so it must be specific, shootable, and reviewable.

## Levels

| Level | Meaning | Rules |
|---|---|---|
| Script scene | `## S01 \| INT. · location \| time` in the script | One script scene becomes 1 or more segments; write a one-line scene purpose (summary), e.g. "Sacrifice · faith at its limit: badly wounded and captured, he keeps his resolve" |
| Segment | One video generation | **4-15 seconds**, happens in a single scene (scene_id); **at most 4 panels** — split into the next segment beyond that |
| Shot | A new shot number = a hard cut | Each shot has shot size, angle, camera movement, purpose, and in-segment start/end seconds; the timeline is contiguous and the last shot's end = segment duration |
| Beat | Continuous action within one shot, codes 1A/1B/1C | A/B/C of the same shot do not cut — the action or camera just continues; **one beat = one panel on the board**; 1-3 beats per shot |

## Splitting Segments

1. **Beats of the story**: split at emotional and narrative turns (setup, trigger, confrontation, eruption, aftermath); prefer cutting at beat boundaries and keep a causal chain (setup-event-reaction) in one segment
2. **Total volume**: target total duration ≈ script length ÷ 500 characters/minute (≈ 150 words/minute in English); establishing/opening shots 4-6 s, narrative segments 8-12 s, emotional peaks 12-15 s at a slower pace
3. **Dialogue floor**: segment duration ≥ spoken dialogue and narration time + 2 seconds of performance headroom; split if it does not fit
4. **Continuity**: write "segment start" (start_state) and "segment end" (end_state) for every segment — each a visible state (who is where, doing what, under what light); the next segment's start must pick up the previous segment's end

## Writing Shots

- **size**: extreme long / long / full / medium / medium close-up / close-up / extreme close-up
- **angle**: camera direction + height, e.g. "looking down along the mountain road from high above", "frontal, slightly off-axis, eye level", "diagonal to the map table, chest height"
- **movement**: static / push in / pull out / pan / truck / follow / handheld, with speed and landing point, e.g. "static, then a very slow push in"
- **purpose**: what this shot should make the audience feel, e.g. "the film's first breath: cold, still, pressed low"

## Writing Beats (each panel)

- **frame**: the composition when the panel is frozen — who is where in frame, facing, expression, foreground/background (used for the board image; one complete picture). **Panels without people start with "空镜：" (empty shot) and name the object the camera is on** (e.g. "空镜：raindrops hitting a muddy puddle, throwing up tiny splashes"); avoid words like "facing" or "looking back" that read as a person's action
- **action**: the visible change in this beat (characters, props, environment), with concrete verbs; turn emotions into visible behavior
- **camera**: camera change while the same shot continues (optional)
- **sound**: ambience, action sounds, music — not just "tense" or "sad"
- **narration / dialogue**: only from the script, placed in the beat where it happens
- **subject_arrow (red arrow)**: a short label for character/prop motion, e.g. "advance", "trace", "turn"; omit if none
- **camera_arrow (blue arrow)**: a short label for camera motion, e.g. "slow truck", "slow push in to the lit face"; omit if none

## Binding Rules

- `scene_id`: the scene of the segment, from the scenes returned by read_storyboard_context; required whenever it matches
- `character_ids`: every character who appears, is seen, or speaks; empty for establishing shots
- `prop_ids`: key props that are used, handed over, shown in close-up, or clearly visible and meaningful
- Bound assets become reference images for the board image and the video, keeping characters, scenes, and props consistent

## Example (one segment, 2 shots, 3 panels)

```json
{
  "shot_number": 3, "part": 1, "title": "Choice at the map", "duration": 11, "scene_id": 2, "character_ids": [3],
  "atmosphere": "dim oil-lamp light, deep shadows, a far-off night wind outside",
  "board": {
    "start_state": "Late-night command post; an oil lamp lights the spread-out map; the commander leans over the table",
    "end_state": "A finger rests on the Xiang River line on the map; the commander looks up and stares, silent",
    "shots": [
      { "no": 1, "start": 0, "end": 5, "size": "medium", "angle": "diagonal to the map table from the doorway, chest height", "movement": "static, steady gaze", "purpose": "establish the oppressive late-night decision space",
        "beats": [ { "code": "1A", "frame": "The commander leans on both sides of the map table, the oil lamp at frame left", "action": "The lamp flame flickers; the commander leans over the map, silent for a long time", "sound": "Utter silence, only the faint crackle of the flame", "narration": "Chiang Kai-shek massed heavy forces and laid a fourth blockade line along the Xiang River." } ] },
      { "no": 2, "start": 5, "end": 11, "size": "close-up", "angle": "looking down at the table over the commander's shoulder", "movement": "slow push in", "purpose": "press the army's fate onto a single finger",
        "beats": [
          { "code": "2A", "frame": "An index finger pressing on the Xiang River line on the map", "action": "A finger slowly traces the Xiang River line on the map and stops", "sound": "A fingertip brushing paper", "narration": "Whether we can cross the river decides", "subject_arrow": "trace" },
          { "code": "2B", "frame": "Close shot of the commander looking up, half his face in lamplight", "action": "The commander looks up, grave", "camera": "the camera keeps pushing in", "sound": "Flame hiss, far-off night wind", "narration": "the life or death of this army.", "camera_arrow": "slow push in to the lit face" }
        ] }
    ]
  }
}
```

## Quality Requirements

- Every panel must be drawable on its own: concrete positions, facing, and light — no abstract emotions
- Every cut within a segment needs a clear reason (new information, new emotion, new subject)
- Dialogue and narration land in the beats where they happen, in order, without dropping any script lines
- save_boards validates duration, timeline, beat codes, panel count, and the dialogue floor and returns warnings — fix them and re-save that scene
