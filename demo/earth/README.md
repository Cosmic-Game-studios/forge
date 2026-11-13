# Earth — a demo built by Forge

An interactive 3D Earth in the browser: day and night sides with city lights, a cloud layer, an atmosphere shader, bloom, and a star field. Drag to rotate, scroll or pinch to zoom, space to pause the rotation.

Forge built this running Claude Fable 5.2. The files are as the agent left them (the on-screen texts are German, the language of the request). While building, Forge inspected the scene with its `scene3d` and `screenshot` tools, and its independent reviewer caught black streaks on steep mountain slopes, which the agent then fixed.

**Live:** <https://cosmic-game-studios.github.io/forge/demo/earth/earth.html>

## Run it locally

Browsers do not load ES modules from disk, so serve the folder:

```bash
cd demo/earth
python -m http.server 8000
```

Then open <http://localhost:8000/earth.html>. Needs WebGL 2.

## Files

| | |
|---|---|
| `earth.html` | the page |
| `earth.js` | scene, renderer, post-processing, input |
| `earth-shaders.js` | surface, cloud and atmosphere shaders |
| `earth-logic.js` | camera orbit logic, free of any rendering |
| `earth-logic.test.js` | 11 tests for that logic: `node --test earth-logic.test.js` |
| `vendor/` | three.js and its post-processing add-ons, and the Earth textures |

## Credits

- [three.js](https://threejs.org) and its add-ons — MIT licence, © three.js authors.
- Earth textures (`vendor/earth/`) — from the three.js examples (`examples/textures/planets`).
