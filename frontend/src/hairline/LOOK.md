# Hairline figures — without-browser look (look.md)

**The figures were NOT looked at in a browser.** All VM browsers are broken
(Chromium 1255 dead, Firefox lacks Juggler, Playwright downloads blocked), so
`look.mjs` could not run. Each question below is answered from the code, with
the line that makes it true. The device-browser pass must answer 1, 5, 6, 10
and 12 from the sheet.

Build: `node build.mjs src/hairline/<name>.js public/figures/hairline-<name>.html`
— all three validate exit 0 (kernel + bench intact, static checks pass).
Tour points and frame boxes were computed numerically with the real kernel
(`/dev/shm/hl-tour.mjs`): payable bbox 232×222, seal 262×135, receipt 249×161
— all inside the 400×320 viewBox.

## payable (198 lines, rules [1,2,4,8,10], range [0,40,90])

1. Silhouette at 240px — UNVERIFIED (no browser). Sized for it: bbox 232 wide
   at S=2.0; sheets carry rule lines + punch dots (r=1.05 world).
2. Rest is a composition — YES. Sheets lean back REST=-12° (line 10),
   staggered tabs TABS=[6,31,56], tray with finger pull.
3. Spread — YES. Stagger by distance: `delay = |i-from| * stag` (line 149),
   tweens on the 700ms lift curve (line 150).
4. No flicker — YES by construction. Hit test on static rest-pose bands
   (lines 110-116); choice is discrete state; tick returns moving only while
   a tween/spring runs (lines 135-137). Stillness timing UNVERIFIED.
5. Bright outside, dim inside — YES by construction (filleted sheet outlines,
   tray via rings/prism = silhouette + one crease). Eyes needed.
6. Nothing shows through — YES by construction. Paint order: tray far →
   slip → sheets back-to-front → tray near, opaque (lines 74-108). Eyes needed.
7. One highlight — PARTIAL at rest: no single bright mark at rest; each sheet
   carries one medium punch dot (its number). On pay, exactly one bright
   place: the paid sheet's face+head `hi` + the slip's face `hi` (lines
   161-164) — one thing, the paid sheet and its receipt. Same pattern as the
   package's riffle example. Device pass: confirm the rest still reads.
8. Read-out — YES. `rest` / `sheet NN` / `receipt NN` (lines 152, 166).
9. Nothing leaves the frame — YES. fit() includes the lifted sheet and the
   raised slip (line 71); probe bbox 232×222. Slider ends change timing only.
10. Both themes — figure sets no colours. UNVERIFIED visually.
11. No words — YES. Identity via punch dots + rule lines.
12. Page clean — validate exit 0. Console UNVERIFIED.
13/14. N/A.

## seal (112 lines, rules [1,4,5,8,9,10], range [2,6,10])

1. Silhouette at 240px — UNVERIFIED. Bbox 262 wide; plinth + tapered stamp
   + disc with face ring and 3 dots.
2. Rest is a composition — YES. Stamp hovers 12+depth over the disc; disc
   face ring bright at rest (faceRing class `nf hi`, bright() line 69).
3. Spread — N/A (one moving part by design); the press is the 700ms tween
   (line 83).
4. No flicker — YES. Hit test via unproj onto the ground plane z=0, which
   never moves (line 75); stamp height is a tween, never a spring chasing
   the pointer. Stillness timing UNVERIFIED.
5. Bright outside, dim inside — YES. Plinth/disc/handle via prism; stamp
   body via the two-ring taper (rule 09 note) = silhouette + one crease.
   Eyes needed.
6. Nothing shows through — YES. Paint order: plinth → disc → face ring/dots
   → stamp (body, handle, knob). Eyes needed.
7. One highlight — YES. Exactly one `hi` at a time (lines 69-71): face ring
   at rest, stamp body on hover, disc silhouette when pressed.
8. Read-out — YES. `rest` / `seal` / `paid once` (line 72).
9. Nothing leaves the frame — YES. fit() includes the highest stamp pose
   (depth 10, knob z=50, line 24); probe bbox 262×135.
10. Both themes — no colours set. UNVERIFIED visually.
11. No words — YES. Face ring + 3 dots carry the identity.
12. Page clean — validate exit 0. Console UNVERIFIED.
13/14. N/A.

## receipt (101 lines, rules [1,3,5,8,10], range [12,26,40])

1. Silhouette at 240px — UNVERIFIED. Bbox 249 wide; body + slot + slip with
   torn top edge and rule lines.
2. Rest is a composition — YES. Short stub (REST_H=8) in the slot; slot
   outline bright at rest (lines 30, 81).
3. Spread/falloff — YES. Slip height follows the pointer on a spring,
   clamped to maxH (line 68); the far end is the max print height, fitted
   (line 22).
4. No flicker — YES. The pointer maps to the spring's TARGET, never a
   reading of its position (line 68); tick returns stepS only (line 58).
   Stillness timing UNVERIFIED.
5. Bright outside, dim inside — YES. Body via prism; slip is a filleted
   plate with a torn top (radii ≥0.8); slot is an open outline. Eyes needed.
6. Nothing shows through — YES. Paint order: body → slot → slip; the slip
   covers the slot's middle, its foot sits on the top face inside the body
   (x ±22 vs body ±70). Eyes needed.
7. One highlight — YES. Slot `hi` at rest, slip face `hi` while printing
   (lines 74, 80-81) — mutually exclusive.
8. Read-out — YES. `rest` / `line NN` (line 54).
9. Nothing leaves the frame — YES. fit() includes BH+40 (line 22); probe
   bbox 249×161. Slider ends (12 / 40) both fitted.
10. Both themes — no colours set. UNVERIFIED visually.
11. No words — YES. Rule lines + torn edge, no text.
12. Page clean — validate exit 0. Console UNVERIFIED.
13/14. N/A.
