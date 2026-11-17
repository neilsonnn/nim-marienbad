# Nim

The matchstick game from a famous black-and-white shot, rebuilt as a real-time
three.js scene. You play over a man's shoulder against an opponent standing
across a polished black marble table.

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
| `src/bodyModel.js` | SDF torso (suit jacket) and head (skull, face, ears, a tapered slicked hairline with combed tangents), plus the collar, cuffs and legs. Sleeves are swept tubes rebuilt every frame, with rotation-minimising frames, elbow folds and cuff bunching. |
| `src/actors.js` | Two-bone arm IK. The hand controller does minimum-jerk reaches with arcs, wrist and forearm roll, grasp orientation from the match axis, and a table-contact constraint so fingertips settle on the stone and never sink. Held-match bundles live here too. Bodies reach by shoulder protraction first, then twist about the spine, then lean from the hips. They also breathe (irregular rate, chest expansion in the vertex shader, shoulders rising), sway, and turn their heads with damped look-at. |
| `src/glsl.js` | Lighting from scratch: GGX + height-correlated Smith + Schlick, Charlie sheen for wool, wrap diffuse and transmission for skin, Kajiya-Kay hair, an analytic room environment, split-sum approximation, PCSS soft shadows with blocker search, bump mapping from procedural height, and pixel-footprint detail fading. |
| `src/materials.js` | Procedural surfaces: skin (pores, knuckle and palm creases, veins, nails), hair, twill wool with lapels, shirt and tie, cotton cuffs, aspen matchwood with phosphorus heads, black marble, chrome, the printed matchbox, parquet. |
| `src/world.js` | Table, bullnose chrome band, pedestal, matchbox and matches. When matches drop on a pile, each one settles on the upper convex hull of the matches beneath it. |
| `src/director.js` | Game flow and choreography: picking, carrying, dropping, the end-of-game rebuild by both players, look-at targets and idle behaviours (thumb rub, finger taps). |
| `src/nim.js` | Misère Nim rules and the opponent's move choice. |
| `src/post.js` | Film finish: halation, panchromatic B&W response, filmic toe and shoulder, 24 fps grain, vignette, subtle flicker. |
| `src/audio.js` | Synthesised foley: match ticks, fingertip taps, sleeve rustle, room tone. |

Each frame renders the scene three times:
1. Shadow depth from the hanging lamp.
2. A mirrored camera into a half-resolution HDR target. Alpha stores each surface's height above the stone, so reflections blur with height and roughness.
3. The beauty pass (4× MSAA, half-float), then post.

The table also gets analytic contact occlusion from every match and fingertip.

**Mobile:** shadow taps and shadow map size drop on touch devices, and resolution adapts to frame time. Narrow portrait screens get a letterboxed 0.78 frame with a tighter lens, so the shot stays composed and the UI sits in the bars.

## Debug URL parameters

- `?clean` hides the UI
- `?fade` skips the fade-in
- `?speed=4` runs the simulation 4× faster
- `?autoplay` picks random moves for you
- `?timer` drives frames from a timer instead of requestAnimationFrame (for background tabs)
- `?fixed` turns off adaptive resolution
- `?cam=px,py,pz,tx,ty,tz,hfov` sets the camera position, target and horizontal FOV
- `?gallery=fist,pinch,touch&gview=side|top|palm&side=left|right` shows a hand pose gallery
