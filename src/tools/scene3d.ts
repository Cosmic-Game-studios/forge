// scene3d: lets the model find its way around a three.js world.
//
// A picture alone is a poor map: from one camera a model cannot tell whether
// an object is small or far away, or where things are that the camera does not
// see. So this tool returns the scene as numbers (every object with position,
// size and distance, the camera, the world's bounds) and as pictures from
// fixed directions - top, front, side - next to what the page's own camera sees.
//
// It works on an unmodified three.js page: three.js announces its scenes and
// renderers to a devtools hook, which the script below provides.

import { c } from "../ui/term.ts";
import { openPage, resolveTarget } from "./browser.ts";
import { errorsText } from "./screenshot.ts";
import type { ContentBlock } from "../providers/types.ts";
import type { Tool } from "./types.ts";

/** Runs before the page's scripts: remember scenes, renderers, and the last (scene, camera) pair that was drawn. */
const HOOK = `(() => {
  const state = (window.__forge3d = window.__forge3d || { scenes: [], renderers: [], last: null, hold: false });
  const wrap = (r) => {
    if (r.__forgeWrapped || typeof r.render !== "function") return;
    r.__forgeWrapped = true;
    const render = r.render.bind(r);
    state.draw = render;
    r.render = (scene, camera) => {
      if (scene && scene.isScene && camera && camera.isCamera) state.last = { scene, camera, renderer: r };
      if (!state.hold) return render(scene, camera);
    };
  };
  const target = new EventTarget();
  target.addEventListener("observe", (e) => {
    const o = e.detail;
    if (!o) return;
    if (o.isScene) state.scenes.push(o);
    else if (o.domElement) { state.renderers.push(o); setTimeout(() => wrap(o), 0); }
  });
  window.__THREE_DEVTOOLS__ = target;
})();`;

const DUMP = `(() => {
  const s = window.__forge3d;
  if (!s || !s.last) return { error: s && s.renderers.length ? "A three.js renderer exists, but it has not drawn a scene with a camera yet." : "No three.js renderer was found on this page." };
  const { scene, camera } = s.last;
  scene.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  const V = camera.position.constructor;
  const r = (n) => Math.round(n * 100) / 100;
  const vec = (v) => [r(v.x), r(v.y), r(v.z)];
  const camPos = camera.getWorldPosition(new V());
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const objects = [];
  let total = 0;
  scene.traverse((o) => {
    if (o === scene) return;
    const drawable = o.isMesh || o.isPoints || o.isLine || o.isSprite;
    if (!drawable && !o.isLight && !(o.name && o.children.length)) return;
    total++;
    if (objects.length >= 2500) return;
    const pos = o.getWorldPosition(new V());
    let size = null, center = pos;
    if (o.geometry) {
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
      if (isFinite(b.min.x) && isFinite(b.max.x)) {
        size = [r(b.max.x - b.min.x), r(b.max.y - b.min.y), r(b.max.z - b.min.z)];
        center = b.getCenter(new V());
        if (o.visible) for (const [i, k] of ["x", "y", "z"].entries()) { min[i] = Math.min(min[i], b.min[k]); max[i] = Math.max(max[i], b.max[k]); }
      }
    }
    const ndc = center.clone().project(camera);
    const color = o.material && o.material.color && o.material.color.getHexString ? "#" + o.material.color.getHexString() : o.color && o.color.getHexString ? "#" + o.color.getHexString() : null;
    objects.push({ name: o.name || "", type: o.type, pos: vec(pos), size, dist: r(center.distanceTo(camPos)), inView: Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1 && ndc.z > -1 && ndc.z < 1, visible: o.visible !== false, color, count: o.isInstancedMesh ? o.count : 1, parent: o.parent && o.parent !== scene ? o.parent.name || o.parent.type : "" });
  });
  const bounds = isFinite(min[0]) ? { min: min.map(r), max: max.map(r) } : null;
  s.bounds = bounds;
  return {
    total, objects, bounds,
    camera: { type: camera.type, pos: vec(camPos), dir: vec(camera.getWorldDirection(new V())), up: vec(camera.up), fov: camera.fov ? r(camera.fov) : null, near: r(camera.near), far: r(camera.far) },
    background: scene.background && scene.background.getHexString ? "#" + scene.background.getHexString() : null,
    canvas: s.last.renderer.domElement ? [s.last.renderer.domElement.width, s.last.renderer.domElement.height] : null,
  };
})()`;

/** Draw the scene from a fixed direction with a copy of the page's camera, and hold that frame. */
const viewScript = (view: string) => `(async () => {
  const s = window.__forge3d;
  const { scene, camera } = s.last;
  const b = s.bounds;
  if (!b) return false;
  const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2, cz = (b.min[2] + b.max[2]) / 2;
  const span = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2], 0.001);
  const cam = camera.clone();
  const half = ((cam.fov || 50) * Math.PI) / 360;
  const d = (span * 0.62) / Math.tan(half) + span / 2;
  cam.up.set(0, 1, 0);
  if (${JSON.stringify(view)} === "top") { cam.position.set(cx, cy + d, cz); cam.up.set(0, 0, -1); }
  else if (${JSON.stringify(view)} === "front") cam.position.set(cx, cy, cz + d);
  else cam.position.set(cx + d, cy, cz);
  cam.near = d / 200; cam.far = d * 10;
  if (cam.isOrthographicCamera) { const a = (cam.right - cam.left) / (cam.top - cam.bottom) || 1; cam.top = span * 0.6; cam.bottom = -span * 0.6; cam.right = span * 0.6 * a; cam.left = -span * 0.6 * a; cam.zoom = 1; }
  cam.lookAt(cx, cy, cz);
  if (cam.updateProjectionMatrix) cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  s.hold = true;
  s.draw(scene, cam);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return true;
})()`;

const VIEW_NOTE: Record<string, string> = {
  camera: "what the page's own camera shows",
  top: "from above, looking down the Y axis: +X is to the right, +Z is towards the bottom of the picture",
  front: "from the front, looking along -Z: +X is to the right, +Y is up",
  side: "from the right side, looking along -X: +Z is to the left, +Y is up",
};

interface Obj {
  name: string;
  type: string;
  pos: number[];
  size: number[] | null;
  dist: number;
  inView: boolean;
  visible: boolean;
  color: string | null;
  count: number;
  parent: string;
}

/** The object list as text. Many identical objects (maze walls, pellets) become one line with their extent. */
export function describeObjects(objects: Obj[], total: number): string {
  const groups = new Map<string, Obj[]>();
  for (const o of objects) {
    const key = o.name ? `name:${o.name}` : `${o.type}|${o.size?.join("x")}|${o.color}|${o.parent}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(o);
  }
  const fmt = (v: number[]) => `(${v.join(", ")})`;
  const lines: string[] = [];
  const sorted = [...groups.values()].sort((a, b) => Number(!!b[0].name) - Number(!!a[0].name) || a.length - b.length || a[0].dist - b[0].dist);
  for (const g of sorted.slice(0, 60)) {
    const o = g[0];
    const label = `${o.name ? `"${o.name}"` : "(unnamed)"} ${o.type}${o.color ? ` ${o.color}` : ""}${o.parent ? ` in ${o.parent}` : ""}`;
    if (g.length === 1) {
      lines.push(`- ${label}: at ${fmt(o.pos)}${o.size ? `, size ${fmt(o.size)}` : ""}, ${o.dist} from the camera, ${!o.visible ? "hidden (visible=false)" : o.inView ? "in the camera's view" : "outside the camera's view"}${o.count > 1 ? `, ${o.count} instances` : ""}`);
    } else {
      const lo = [0, 1, 2].map((i) => Math.min(...g.map((x) => x.pos[i])));
      const hi = [0, 1, 2].map((i) => Math.max(...g.map((x) => x.pos[i])));
      lines.push(`- ${g.length} x ${label}${o.size ? `, each size ${fmt(o.size)}` : ""}: positions from ${fmt(lo)} to ${fmt(hi)}, ${g.filter((x) => x.inView && x.visible).length} in the camera's view`);
    }
  }
  if (sorted.length > 60) lines.push(`- … ${sorted.length - 60} more kinds of object`);
  if (total > objects.length) lines.push(`(${total} objects in the scene; the first ${objects.length} were read)`);
  return lines.join("\n");
}

const VIEWS = ["camera", "top", "front", "side"];

export const scene3dTool: Tool = {
  kind: "exec",
  spec: {
    name: "scene3d",
    description:
      "Inspect a three.js scene running in a web page, to find your way around a 3D world you are building. Returns (1) the scene as numbers: every object with its name, world position, size, distance from the camera and whether the camera sees it, plus the camera and the world's bounds; (2) pictures from fixed directions - the page's own camera, top, front and side - so you can tell small from far away and see what the camera misses; (3) the errors the page reported. Use it after building or changing a 3D scene and whenever something is not where you expect: check positions and sizes in the numbers, and the layout in the top view. No change to the page is needed for three.js. Give objects a `name` and they are listed individually. Coordinates are three.js world units: +X right, +Y up, +Z towards the viewer.",
    input_schema: {
      type: "object",
      properties: {
        target: { type: "string", description: "URL, or path to a local HTML file." },
        views: { type: "array", items: { type: "string", enum: VIEWS }, description: "Which pictures to take. Default: camera, top, front, side. Pass [] for numbers only." },
        wait: { type: "integer", description: "Milliseconds to let the page run after loading (default 1500, at most 10000)." },
        run: { type: "string", description: "JavaScript to run in the page before inspecting, for example to press a key or advance the game: document.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowUp'}))." },
      },
      required: ["target"],
    },
  },
  summarize: (i) => String(i.target ?? ""),
  async run(input, ctx) {
    const target = await resolveTarget(String(input.target), ctx.cwd);
    if (!target) return { content: `File not found: ${input.target}`, isError: true };
    const url = target.url;
    const views: string[] = Array.isArray(input.views) ? input.views.filter((v: unknown) => VIEWS.includes(String(v))) : VIEWS;
    const width = 720;
    const height = 450;
    let page;
    try {
      page = await openPage(url, { width, height, signal: ctx.signal, init: HOOK, settleMs: Math.min(10_000, Math.max(0, Number(input.wait) || 1500)) });
    } catch (err) {
      target.close();
      return { content: `Could not open the page: ${(err as Error).message}`, isError: true };
    }
    try {
      if (typeof input.run === "string" && input.run.trim()) {
        try {
          await page.evaluate(`(async () => { ${input.run}\n })()`);
          await new Promise((r) => setTimeout(r, 400));
        } catch (err) {
          page.errors.push(`Your \`run\` script threw: ${(err as Error).message.split("\n")[0]}`);
        }
      }
      const dump = await page.evaluate(DUMP);
      if (!dump || dump.error) {
        const shot = await page.screenshot();
        return {
          content: [
            { type: "text", text: `${dump?.error ?? "The scene could not be read."} If the page uses three.js, check that it loads and that the render loop runs.${errorsText(page.errors)}\n\nThis is what the page shows:` },
            { type: "image", source: { type: "base64", media_type: "image/png", data: shot.toString("base64") } },
          ],
          isError: true,
          display: [c.red("no three.js scene found") + (page.errors.length ? c.red(` · ${page.errors.length} page errors`) : "")],
        };
      }
      const cam = dump.camera;
      const text = [
        `three.js scene at ${target.label}`,
        dump.bounds ? `World bounds (visible geometry): x ${dump.bounds.min[0]} to ${dump.bounds.max[0]}, y ${dump.bounds.min[1]} to ${dump.bounds.max[1]}, z ${dump.bounds.min[2]} to ${dump.bounds.max[2]}` : "World bounds: the scene has no visible geometry.",
        `Camera: ${cam.type} at (${cam.pos.join(", ")}), looking along (${cam.dir.join(", ")})${cam.fov ? `, field of view ${cam.fov} degrees` : ""}, draws distances ${cam.near} to ${cam.far}`,
        `Background: ${dump.background ?? "none set"}${dump.canvas ? ` · canvas ${dump.canvas[0]}x${dump.canvas[1]}` : ""}`,
        `Objects (${dump.total}):\n${describeObjects(dump.objects, dump.total) || "  none"}`,
      ].join("\n");
      const content: ContentBlock[] = [{ type: "text", text: text + errorsText(page.errors) }];
      for (const view of views) {
        if (view !== "camera" && !(await page.evaluate(viewScript(view)))) continue;
        const shot = await page.screenshot();
        if (view !== "camera") await page.evaluate("window.__forge3d.hold = false");
        content.push({ type: "text", text: `View "${view}": ${VIEW_NOTE[view]}.` }, { type: "image", source: { type: "base64", media_type: "image/png", data: shot.toString("base64") } });
      }
      return { content, display: [c.dim(`${dump.total} objects, ${views.length} view${views.length === 1 ? "" : "s"}`) + (page.errors.length ? c.red(` · ${page.errors.length} page error${page.errors.length === 1 ? "" : "s"}`) : "")] };
    } catch (err) {
      return { content: `Inspecting the scene failed: ${(err as Error).message}${errorsText(page.errors)}`, isError: true };
    } finally {
      page.close();
      target.close();
    }
  },
};
