# Product launch film

A finished fifteen second launch film, four beats, one canvas, one source file. It is a
reference to start from, not a form to fill in: replace the copy and the assets, keep the
structure where it earns its place, and break it deliberately where it does not.

Open it with the video capability's `preview` operation and it plays in this project's
browser tab. Look at it before changing it, so you know what you are cutting into.

## The beats

Fifteen seconds at 30fps, 1920x1080. One idea per beat, and the time budget includes the
entrances, the reading holds and the exits.

| seconds | beat | what the viewer takes away | the focus | what transforms | copy and audio | how it exits |
| --- | --- | --- | --- | --- | --- | --- |
| 0.0 to 3.2 | the mark | who this is | the wordmark | letters rise, a rule draws outward from the centre | brand, subtitle; the bed fades in | the wordmark travels to the top left |
| 3.2 to 7.2 | the claim | the promise | one sentence | the sentence rises in two lines, the rule travels under it | the claim | the rule settles, then clears |
| 7.2 to 11.4 | the proof | that it is real | three facts | cards pop, numbers count up, the rule becomes a progress track | the proof points | the cards fade, the track completes |
| 11.4 to 15.0 | the close | remember the name | the wordmark again | the mark bookends at its opening size and the rule expands, one flare | the tagline | the last frame holds the mark |

## What to replace

Every line of copy is a control in the video panel, so the film can be reworded without
touching code:

- `brand`, the wordmark, drawn in caps in the readout strip as well.
- `claim`, one sentence that wraps to two lines at 92px. Longer than about forty
  characters and it will push the rule off the frame.
- `tagline`, the closing line.
- `accent` and `cool`, the two colours everything else is built from.
- `gridStep` and `showReadout`, the texture and the strip at the top.

Replace the three proof points in `COPY.proof` in `index.html`. They describe this starter
truthfully today (its length, its frame rate, its source), which is why the film is honest
as shipped. Put real numbers there, never invented ones.

Then the assets: the typeface in `assets/`, the bed in `sound/bed.m4a`, and the audio
policy in `composition.json`.

## The sound

`sound/bed.m4a` is synthesized for this starter: three low sines with a slow tremolo and a
level change at each beat, produced locally with ffmpeg. It is a placeholder. Replace it
with music, keep a level change at a cut unless the cut is meant to be invisible, and keep
the bed well under any voice.

`composition.json` declares `"audioPolicy": "required"`, which is what makes the export
refuse to hand back a silent file. A film that is deliberately silent declares `"silent"`
instead. The bed is one file listed in `audio`; the video panel's audio tracks can place
several with their own start, trim and gain.

## How it is built, and what to keep

- One canvas, one `draw(t)`, and the frame is a function of `t` alone. That is what makes a
  capture the frame that was asked for and an export frame-accurate. Keep it: no
  `Date.now()` in the drawing, no accumulated state, and clear the canvas at the top.
- `window.cioRenderFrame = draw` is assigned before anything awaits. A capture and an
  export both call it, and a film that never defines it cannot be captured at all.
- `CIOVideo.bind(draw)` loads the panel's controls and captions, `CIOVideo.useCanvas(canvas)`
  tells the export which canvas to encode, and `CIOVideo.drawCaptions` draws the caption
  band the app positions. `cio-video.js` is installed by the app, never hand-edited.
- The curve is chosen per move, from `CIOVideo.easings`: `outQuint` for the entrances and
  the number counts, `inOutCubic` for the mark travelling between its two positions and for
  the rule drawing itself, `outBack` for the cards that pop, `outExpo` for the one flare at
  the end, `linear` for nothing but the clock in the readout.
- The motif is a single horizontal rule. It draws outward under the mark, travels under the
  claim, becomes the progress track across the proof, and expands to full width for the
  close. One idea carried through four beats is what makes the film read as one piece.
- Type is set in one family at two weights. The wordmark is drawn letter by letter so it can
  carry tracking and arrive in order; everything else is one call to draw a line.
- Nothing important sits in the outer 5% of the frame, and every entity is a fraction of
  the frame rather than a fixed pixel size, so the film looks the same at any preview width.

## Honest limits

- The film does not loop: it ends on the mark, and the first and last frames differ. For a
  loop, match both the start and the end state and their velocity.
- There are no captions in `studio.json`. The call is wired up, so add lines with the panel
  or the `captions` operation when the film has narration, rather than captioning copy that
  is already on screen.
- The bed is a drone, not music. It exists so the film is not silent and so the audio policy
  has something to enforce.

Fonts are JetBrains Mono under the SIL Open Font License; the licence text ships beside them
in `assets/jetbrains-mono-OFL.txt`.
