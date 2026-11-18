# Nim

The matchstick game from a famous black-and-white shot, rebuilt as a real-time
three.js scene. You play over a man's shoulder against an opponent standing
across a polished black marble table.

**The players:** you play over the man's shoulder. His left hand, the one in the shot, works the left and centre of the board. His right hand rests on his thigh and comes up past the table edge for matches on the right. Each hand keeps its own pile. The opponent stands at the far side. He braces his weight on his left hand and bends low over the board, so his face hangs in the lamp light and shows in the polished stone. `?lean=0` restores the upright stance from the reference shot.

**Rules:** sixteen matches in rows of 7, 5, 3 and 1. On your turn you take as many
matches as you like, but from one row only. Whoever takes the last match loses.
The opponent plays the misère strategy almost perfectly, so you can't win from the
first position when you move first. The opening player alternates every game.

## Run it

It's a static site with no build step. three.js is vendored in `vendor/`.

```bash
python3 tools/serve.py
```

Then open http://127.0.0.1:5199. To try it on a phone on the same Wi-Fi:

```bash
HOST=0.0.0.0 python3 tools/serve.py
```

…and open `http://<your-computer's-LAN-IP>:5199` on the phone. Any static host
works too; just upload the folder.

## Controls

- **Hover** a match and the player's head turns slightly toward it.
- **Click / tap** matches to select them. Selections are limited to one row; picking a match in another row starts a new selection.
- **take** (or Enter, or double-click) confirms the move. **clear** (or Esc) drops the selection.
- **sound on/off** sits in the bottom-left corner. All sounds are synthesised.

## What's in it

| File | What it does |
| --- | --- |
| `src/sdf.js` | SDF primitives and a narrow-band Surface Nets mesher. It projects vertices onto the surface and takes normals from the SDF gradient. |
| `src/handModel.js` | Hand anatomy as an SDF: palm, metacarpals, thenar/hypothenar, phalanges and thumb. It is meshed once and auto-skinned to a 17-bone rig with Gaussian bone-distance weights. Nail, crease, dorsal and thickness masks are baked per vertex. Thumb poses are IK-solved (precision pinch, fist, relaxed) with a finger-collision penalty. |
| `src/bodyModel.js` | SDF torso (suit jacket) and head (skull, face, a slicked hairline that fades into the nape, combed tangents). Ears are meshed separately at fine resolution: helix rim, antihelix, concha, tragus, lobe and conchal eminence. There's a rolled jacket collar with the shirt collar showing above it, French cuffs with links, and legs. Sleeves are swept tubes rebuilt every frame, with rotation-minimising frames, elbow folds and cuff bunching. |
| `src/actors.js` | Two-bone arm IK with a soft reach limit, so an arm never locks straight. The elbow swivels around the shoulder–wrist axis to stay clear of the chest, neck and face; it is carried with the arm, eased in world space and capped in speed, so it never pops. Hands do minimum-jerk reaches with low arcs, grasp along the match axis, and settle onto the stone through a contact constraint. They never pass through their owner's face. Bodies reach by protracting the shoulder, then twisting about the spine, then leaning from the hips. The lean always keeps up with the hand, and a seated reach slides forward on the chair. A braced hand (the opponent's left) is locked to the stone and carries his weight. Legs use IK from the moving hips to feet planted on the floor. Bodies breathe, sway and turn their heads with damped look-at. |
| `src/glsl.js` | Lighting from scratch: GGX + height-correlated Smith + Schlick, Charlie sheen for wool. Skin uses a subsurface model (curvature- and wavelength-dependent wrap, penumbra bleed, thin-part translucency, vellus rim, dual specular). Also Kajiya-Kay hair, an analytic room environment, split-sum approximation, PCSS soft shadows with blocker search, bump mapping from procedural height, and pixel-footprint detail fading. |
| `src/materials.js` | Procedural surfaces: skin (pores, knuckle and palm creases, veins, nails), hair, twill wool with lapels, shirt and tie, cotton cuffs, aspen matchwood with phosphorus heads, the printed matchbox, parquet. The stone is polished black granite: Voronoi crystals, domain-warped clouding, calcite threads, glinting mica, hazy smudges and rotary polishing swirls. The nickel band has polished beads and brushed faces. |
| `src/world.js` | Table: a lathed slab with a polished bullnose edge, a shadow gap, and a nickel band with two beads. Also the pedestal, matchbox and matches. When matches drop on a pile, each one settles on the upper convex hull of the matches beneath it. |
| `src/director.js` | Game flow and choreography: picking, carrying, dropping, the end-of-game rebuild by both players, look-at targets and idle behaviours (thumb rub, finger taps). |
| `src/nim.js` | Misère Nim rules and the opponent's move choice. |
| `src/post.js` | Thin-lens depth of field (half-resolution golden-spiral bokeh gather), plus the film finish: halation, panchromatic B&W response, filmic toe and shoulder, 24 fps grain, vignette, subtle flicker. Focus stays on the board and leans slightly toward the working hand. |
| `src/audio.js` | Synthesised foley: match ticks, fingertip taps, sleeve rustle, room tone. |

The lamp is mirrored by the stone. A virtual lamp below the table lights chins, palms and the undersides of fingers, gated by whether the bounce point is lit. A narrow follow-spot keeps the opponent's face readable when he leans in.

Each frame renders the scene three times:
1. Shadow depth from the hanging lamp.
2. A mirrored camera into a half-resolution HDR target. Alpha stores each surface's height above the stone, so reflections blur with height and roughness.
3. The beauty pass (4× MSAA, half-float), with camera distance in alpha for depth of field, then post.

The table also gets analytic contact occlusion from every match and fingertip.

**Mobile:** shadow taps and shadow map size drop on touch devices, and resolution adapts to frame time. Narrow portrait screens get a letterboxed 0.78 frame with a tighter lens, so the shot stays composed and the UI sits in the bars.

## Debug URL parameters

- `?clean` hides the UI
- `?fade` skips the fade-in
- `?speed=4` runs the simulation 4× faster
- `?autoplay` picks random moves for you
- `?timer` drives frames from a timer instead of requestAnimationFrame (for background tabs)
- `?fixed` turns off adaptive resolution
- `?lean=0` keeps the opponent upright, as in the reference (no face in the stone)
- `?nodof` turns off depth of field; `?aperture=0.0065` sets the lens opening in metres
- `?cam=px,py,pz,tx,ty,tz,hfov` sets the camera position, target and horizontal FOV
- `?gallery=fist,pinch,touch&gview=side|top|palm&side=left|right` shows a hand pose gallery
