---
name: 3d-worlds
description: Use when building or changing anything in 3D - three.js or WebGL scenes, games, worlds, levels, cameras, lighting, movement and collision. Covers the conventions to fix first and how to check positions with the scene3d tool instead of guessing.
---

# 3D worlds

You cannot judge a 3D scene from its code, and one picture is a poor map: from a single camera, small and far away look the same. Work from numbers, and check them with `scene3d`.

## 1. Fix the conventions before placing anything

Write these down as constants at the top of the scene code and never deviate:

- **Axes.** three.js: +X right, +Y up, +Z towards the viewer. The ground is the XZ plane at y = 0. "Forward" for a character is usually -Z.
- **Units.** One unit is one metre (or one grid cell - say which). A person is about 1.8 tall, a door 2, a room 3 high. A grid game: one cell = 1 unit, cell (col, row) sits at x = col - (cols - 1) / 2, z = row - (rows - 1) / 2, so the world is centred on the origin.
- **Origins.** A box's position is its centre. To stand an object of height h on the ground, set y = h / 2. Decide this per object type once.
- **One source of truth.** Keep game state (grid positions, speeds, scores) in plain data, separate from the meshes, and derive mesh positions from it each frame. Logic that can be tested without a renderer should live in its own file and have tests.

## 2. Build order

1. Ground and world bounds, a camera that sees all of it, one light pair (ambient about 0.5 plus one directional). Run `scene3d` now: an empty stage that renders is the first milestone.
2. Static geometry (walls, terrain). Check the top view.
3. Moving things, then input, then collision, then rules (score, win, lose).
4. Look and feel last: materials, shadows, fog, post-processing.

After each step run `scene3d`; do not stack three steps on an unverified one.

## 3. Reading scene3d

- **The numbers.** Every object with position, size, distance from the camera, and whether the camera sees it. Check there first: is the thing where the code meant to put it? Is its size the unit you intended (a wall of size 100 in a world 20 wide is a units bug)? Is anything at exactly (0, 0, 0) that should not be (a position never set)?
- **Top view.** The map. Layout, gaps in walls, objects inside each other, whether the level is centred.
- **Front and side views.** Heights: things sunk into the floor (y is the centre, not the base) or floating above it.
- **Camera view.** What the player actually sees. If the top view is right and this is wrong, the bug is in the camera, not the world.
- **Errors.** A black canvas is almost always an error in the list: a failed import, an exception in the render loop, a texture that did not load.
- Give important objects a `name` (`player`, `ghost-red`, `exit`); they are then listed one by one instead of grouped.
- Use `run` to press keys or advance time, then compare positions before and after to verify movement and collision: `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }))`.

## 4. The usual mistakes

- **Nothing visible:** camera inside an object or looking away (check its direction in the numbers); object beyond `far` or closer than `near`; no light with a lit material (`MeshStandardMaterial` is black without light; `MeshBasicMaterial` ignores light and is good for debugging); canvas with zero size.
- **Everything tiny or huge:** mixed units, or the camera distance not derived from the world's size. Compute the camera distance from the bounds instead of hard-coding it.
- **Sunk or floating objects:** forgot the half-height offset.
- **Mirrored or rotated layout:** rows mapped to +Z vs -Z, or to Y. Decide with the top view, fix in the one function that maps grid to world.
- **Rotation surprises:** angles are radians; rotation order is XYZ; `lookAt` needs the target in world space and the camera's `up` set first.
- **Movement tied to frame rate:** multiply speeds by the frame's delta time.
- **Collision by eye:** test collision in the logic layer against the data (grid cells, bounding boxes), not against what is drawn.
- **Stretched picture / wrong aspect:** on resize update `camera.aspect`, call `updateProjectionMatrix()`, and `renderer.setSize`.
- **Slow scene:** thousands of separate meshes. Use `InstancedMesh` for repeated objects, share geometries and materials, and cap `renderer.setPixelRatio` at 2.
- **Module pages opened from disk** do not load (`file://` blocks ES modules). The screenshot and scene3d tools serve local files themselves; for the user, say how to run a local server.

## 5. Before you say it is done

- `scene3d` shows no page errors, and the numbers match the layout you intended.
- The camera view shows the whole play area (or follows the player), with nothing important outside the view.
- You pressed the controls through `run` and saw positions change the right way, and stop at walls.
- The logic has tests that run without a browser.
- You told the user how to start it, and what you could not verify (sound, feel of the controls, performance on their machine).
