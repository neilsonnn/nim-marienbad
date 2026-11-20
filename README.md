# Nim

The matchstick game from a famous black-and-white shot, rebuilt as a real-time
three.js scene. You play over a man's shoulder against an opponent standing
across a polished black marble table.

![The reference still: two men at a black marble table with matches laid out in rows](docs/reference.jpg)

*The reference shot ([via are.na](https://www.are.na/block/44634262)).*

**The players:** you play over the man's shoulder. His left hand, the one in the shot, rests as in the still: forearm laid across the stone in front of him, cuff showing, a composed fist lying level with the thumb wrapped round the front. It works the left and centre of the board. His right hand rests on his thigh and comes up past the table edge for matches on the right. Each hand keeps its own pile. The opponent stands at the far side, as in the reference shot, with his weight braced on his left hand. `?lean=1` bends him low over the board instead, so his face hangs in the lamp light and shows in the polished stone.

**The box:** the board starts empty. The opponent picks up the matchbox in his left hand, from above, fingers wrapped round the sleeve near its closed end. He slides the drawer further out and holds it over the board beside his right hand, which takes the matches from the open end a few at a time and lays out the rows, far to near. Then the drawer goes back in and the box back down.

**Non, c'est impossible:** lose to him and the line appears under the board. Click it and your man loses his temper: his left hand snaps back, slams down beside his matches and shoves them hard to the right, and they skid and hop off the table's right edge. The opponent sighs and lays the board out again, first from his own pile, then the rest from the box. Autoplay protests now and then by itself.

**Two players:** pick "two players" in the settings panel (the gear, bottom right) to play hot-seat at one screen. Player one plays this side, over the shoulder, and player two plays the man across the table. Each picks matches the same way on their turn, and his hand carries out player two's choice. Player one starts the first game, and the opening player alternates after that. The switch takes effect from the next game.

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

- The game starts straight away. The **gear** in the bottom-right corner opens the settings: how to play, the three modes, and the credit line. The modes are **one player** (against him), **two players** (hot-seat; switching to or from it takes effect from the next game) and **autoplay** (random moves for you against him; starts and stops at once, no reload). The choice is remembered. While the settings are open the subtitles and take buttons step aside for the credit. Click outside the buttons, or press Esc, to close it.
- **Hover** a match and the head of whoever is choosing turns slightly toward it.
- **Click / tap** matches to select them, or **drag** across several. The first match you touch decides whether the stroke selects or deselects. Selections are limited to one row; picking a match in another row starts a new selection.
- When only one match is left on your turn, there is nothing to decide: you take it automatically.
- **take** (or Enter, or double-click) confirms the move. **clear** (or Esc) drops the selection.
- Sound is always on and starts with your first click or key press. All sounds are synthesised.
- **Pinch** (trackpad or touch screen) zooms in and out within a set range; a notched mouse wheel zooms too. **Two-finger drag** (or right-drag with a mouse) turns the view a few degrees around the table. Both ease to a soft stop at their limits, and zoom moves straight along the line of sight without turning.
- **Shift + two-finger drag** (or shift + right-drag, or the left / right arrow keys; shift + arrow for bigger steps) slides the camera sideways without turning it.
- With `?fps`, **F** shows or hides the frame-rate counter in the top-left corner (frames per second, frame time, worst frame, and the render size).

## What's in it

| File | What it does |
| --- | --- |
| `src/sdf.js` | SDF primitives and a narrow-band Surface Nets mesher. It projects vertices onto the surface and takes normals from the SDF gradient. |
| `src/handModel.js` | Hand anatomy as an SDF: forearm, palm, metacarpals, thenar/hypothenar, phalanges and thumb. The forearm tapers smoothly into the palm. The thumb's metacarpal is buried in the thenar mass, and a web of skin (a fan of tapering cones with a thin, concave free edge) joins it to the index, so the thumb grows out of the hand. The hand is meshed once and auto-skinned to a 17-bone rig with Gaussian bone-distance weights. It is deformed with dual-quaternion skinning, so a sharply bent wrist or a swung thumb keeps its volume. Nail, crease, dorsal and thickness masks are baked per vertex. Thumb poses are IK-solved (precision pinch, fist, relaxed, and lying flat on the stone beside a pressed palm) with finger, palm and stone collision penalties. The palm's contact points are taken from its actual surface. |
| `src/bodyModel.js` | SDF torso (suit jacket) and head. The faces are deliberately rough and abstract: a skull, a soft face mass, a brow, shallow hollows, a nose and a jaw. The hair is a slicked hairline that fades into the nape, with combed tangents. Ears are meshed separately at fine resolution. There's a rolled jacket collar with the shirt collar showing above it, French cuffs fitted close to the wrist, and legs. The jacket's shoulders are skinned to the arms: each shoulder cap and a short stump of upper sleeve is modelled with the arm at a rest angle, weighted by whether a point belongs to the arm or the body, and turned with the upper arm about the shoulder joint in the vertex shader, the jacket between bending smoothly. Sleeves are swept tubes rebuilt every frame, with rotation-minimising frames, elbow folds and cuff bunching; each starts inside its stump, coaxial with it, so arm and body read as one piece however the arm moves. Toward the wrist the sleeve turns and flattens to fit evenly around the cuff, which sits a centimetre up the forearm. |
| `src/actors.js` | Two-bone arm IK with a soft reach limit, so an arm never locks straight. The elbow swivels around the shoulder–wrist axis toward a preferred direction (out, a little down and back, relative to the body's facing rather than its lean). It stays clear of the chest, neck, face and the stone slab, and is penalised for winging up. It is carried with the arm, eased in world space and capped in speed, so it never pops. Hands do minimum-jerk reaches with low arcs, grasp along the match axis, and settle onto the stone through a contact constraint. Taking a whole row of three or more is one stroke: the hand comes down past the far end of the row still pointing forward, palm down, middle, ring and little fingers hooked onto the stone (index lifted), and draws the row along and round into its pile without turning; the matches gather against those fingertips and come to rest on the heap. Multi-point moves are timed along the path's true length, so a hand never dawdles into a turn and shoots out of it. A hand rising from the lap follows one spline through via points instead of stopping at each. Hands never pass through their owner's face. Bodies reach by protracting the shoulder, then twisting about the spine, then leaning from the hips. Each move carries a body plan: the lean it needs is solved continuously (bisection, no steps) and eased in step with the hand, so the torso never snaps to catch up. A seated reach slides forward on the chair. A braced hand (the opponent's left) is locked to the stone and carries his weight; each of its fingers bends at the knuckle until its pad rests on the stone. A bent wrist pushes its cuff back up the forearm. Legs use IK from the moving hips to feet planted on the floor. Bodies breathe, sway and turn their heads with damped look-at. |
| `src/glsl.js` | Lighting from scratch: GGX + height-correlated Smith + Schlick, Charlie sheen for wool. Skin uses a subsurface model (curvature- and wavelength-dependent wrap, penumbra bleed, thin-part translucency, vellus rim, dual specular). Also Kajiya-Kay hair, an analytic room environment, split-sum approximation, PCSS soft shadows with blocker search, bump mapping from procedural height, and pixel-footprint detail fading. Shadow lookups are offset by the shadow texel's size along the true (unbumped) normal, with a slope-scaled bias. Past the terminator, where skin and cloth still get wrapped light, the lookup also looks through the object's own thickness toward the lamp, so the wrap is never cut along the object's jagged silhouette in the map. The light bounced up off the stone is gated by a filtered shadow test, not a single hard tap. |
| `src/materials.js` | Procedural surfaces: skin (pores, knuckle and palm creases, nails), hair, twill wool with lapels, shirt and tie, cotton cuffs, aspen matchwood with phosphorus heads, the printed matchbox, parquet. The stone is polished black granite: Voronoi crystals, domain-warped clouding, calcite threads, glinting mica, hazy smudges and rotary polishing swirls. Its smooth fields (clouding, threads, haze, smudges, relief slope, slab undulation) never change, so they are baked once at startup into two mipmapped textures; crystals, mica and swirls stay live. The table's metal siding is polished chrome. Suit cloth has a soft wool sheen, kept subtle under the hanging lamp so black suits stay black. |
| `src/world.js` | Table: a lathed stone slab set into a polished convex metal siding, which catches the lamp and a soft reflected strip along its front. Also the matchbox with its drawer half open and matches lying in it, and the matches. When matches drop on a pile, each one settles on the upper convex hull of the matches beneath it. |
| `src/director.js` | Game flow and choreography: picking, carrying, dropping, the end-of-game rebuild by both players, look-at targets and idle behaviours (thumb rub, finger taps). |
| `src/nim.js` | Misère Nim rules and the opponent's move choice. |
| `src/post.js` | Thin-lens depth of field (half-resolution golden-spiral bokeh gather), plus the film finish: halation, panchromatic B&W response, filmic toe and shoulder, 24 fps grain, vignette, subtle flicker. Focus stays on the board and leans slightly toward the working hand. |
| `src/audio.js` | Synthesised foley: match ticks, fingertip taps, sleeve rustle, room tone. |

The lamp is mirrored by the stone. A tall lit strip behind the opponent appears only in the reflection: a wavering bright streak down the right of the table that his arm cuts into, as in the shot. The waver comes from slow undulations of the slab, a fraction of a degree deep. They bend reflections of distant things while near hands stay crisp. A virtual lamp below the table lights chins, palms and the undersides of fingers, gated by whether the bounce point is lit. A narrow follow-spot keeps the opponent's face readable when he leans in.

Each frame renders the scene three times:
1. Shadow depth from the hanging lamp.
2. A mirrored camera into a half-resolution HDR target. Alpha stores each surface's height above the stone, so reflections blur with height and roughness.
3. The beauty pass (4× MSAA, half-float), with camera distance in alpha for depth of field, then post.

The table also gets analytic contact occlusion from every match and fingertip.

**Performance:** nearly all the cost is per pixel, so the render size is the device pixel ratio capped by a pixel budget (3.6 MP on desktop, 1.5 MP on phones), and then trimmed to hold 60 fps. Frame intervals are rounded to whole display refreshes, so a scale that proved too slow becomes a ceiling for a while instead of being retried every few seconds.

**Mobile:** shadow taps and shadow map size drop on touch devices, as does the size of the stone bake. The scene always fills the whole page; narrow portrait screens get a tighter lens and simply see more above and below the table.

## Debug URL parameters

- `?clean` hides the UI
- `?fade` skips the fade-in
- `?speed=4` runs the simulation 4× faster
- `?autoplay` starts in autoplay mode, and `?players=1` / `?players=2` in one- or two-player mode, without changing the saved choice
- `docs/og.jpg` is the 1200×630 link preview (Open Graph and X card tags in `index.html`), rendered from the opening shot with `?clean`. Once the game has a public URL, make `og:image` and `twitter:image` absolute links, since most sites ignore relative ones.
- `?players=2` (or `?players=1`) preselects the players setting
- `?debug=loop` runs a reach test instead of the game. The player first rakes in each row of three or more and lays it out again, then takes the whole board apart one match at a time and lays it out again, then the opponent does the same, forever. Every move is measured (overreach, elbow riding up, arm in the body, elbow snaps, lean jerk, extreme wrists, hand at the face). Failures go to the console and `window.__diag`. Add `&first=opponent` to start with him, and `&speed=4` to run it quickly.
- `?still` starts no game at all, for driving the hands from the console. `nim.pause()`, `nim.advance(seconds)`, `nim.view(px, py, pz, tx, ty, tz)` and `nim.shot()` freeze the simulation, step it, and look from anywhere. `tools/inspect.js` has a clay material for inspecting shapes in shadow.
- `?timer` drives frames from a timer instead of requestAnimationFrame (for background tabs)
- `?camdebug` frees the camera limits and shows the live view (yaw, pitch, sideways pan, zoom) at the top, with a **copy** button, for lining up a new default shot
- `?fixed` turns off adaptive resolution
- `?budget=6` sets the pixel budget in megapixels (6 renders a 1600×866 retina window at full 2× density)
- `?fps` shows the frame-rate counter and render size (hidden by default)
- `?lean=1` bends the opponent low over the board, so his face shows in the stone
- `?nodof` turns off depth of field; `?aperture=0.0065` sets the lens opening in metres
- `?cam=px,py,pz,tx,ty,tz,hfov` sets the camera position, target and horizontal FOV
- `?gallery=fist,pinch,touch&gview=side|top|palm&side=left|right&wrist=75` shows a hand pose gallery (`wrist` bends the wrist, in degrees; pair it with `?cam`)
