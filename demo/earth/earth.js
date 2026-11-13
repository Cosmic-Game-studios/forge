import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createOrbit, rotateOrbit, zoomOrbit, smoothOrbit, orbitPosition } from './earth-logic.js';
import {
  VERTEX_SHADER, EARTH_FRAGMENT_SHADER, CLOUD_FRAGMENT_SHADER, ATMOSPHERE_FRAGMENT_SHADER
} from './earth-shaders.js';

// Konventionen: +X rechts, +Y oben, +Z zum Betrachter. Eine Einheit = ein Erdradius,
// die Erde sitzt im Ursprung. Position eines Objekts = sein Mittelpunkt.
const EARTH_RADIUS = 1;
const CLOUD_RADIUS = 1.008;
const ATMOSPHERE_RADIUS = 1.13;
const AXIAL_TILT = THREE.MathUtils.degToRad(23.4);
const SUN_DIRECTION = new THREE.Vector3(1, 0.25, 0.45).normalize();
const SUN_DISTANCE = 100;
const SUN_SIZE = 45;
const STAR_DISTANCE = 400;
const STAR_COUNT = 6000;
// Radiant pro Sekunde: eine Erdumdrehung in zwei Minuten, Wolken ziehen langsam voraus.
const EARTH_SPIN = (2 * Math.PI) / 120;
const CLOUD_DRIFT = EARTH_SPIN * 0.12;
// Radiant pro Pixel bei Kameraabstand 1 über der Oberfläche.
const DRAG_SPEED = 0.0025;
const WHEEL_ZOOM = 0.001;
// Nach einem Tab-Wechsel keinen Sprung in der Rotation.
const MAX_FRAME_SECONDS = 0.1;
// Über der Helligkeit sonnenbeschienener Wüsten, damit nur Sonne, Glanzlicht, Wolken und Städte überstrahlen.
const BLOOM_THRESHOLD = 1.5;
const FIELD_OF_VIEW = 45;
const TEXTURE_PATH = './vendor/earth/';

const statusElement = document.getElementById('status');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);
const canvas = renderer.domElement;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(FIELD_OF_VIEW, 1, 0.05, 1000);

const loadingManager = new THREE.LoadingManager();
const textureLoader = new THREE.TextureLoader(loadingManager).setPath(TEXTURE_PATH);

function loadTexture(file, isColor) {
  const texture = textureLoader.load(file);
  if (isColor) texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return texture;
}

const sunDirection = { value: SUN_DIRECTION };
const cloudMap = { value: loadTexture('earth_clouds_1024.png', false) };
const cloudShift = { value: 0 };

function createSphere(name, radius, materialOptions) {
  const material = new THREE.ShaderMaterial({ vertexShader: VERTEX_SHADER, ...materialOptions });
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(radius, 128, 64), material);
  sphere.name = name;
  return sphere;
}

const earth = createSphere('earth', EARTH_RADIUS, {
  fragmentShader: EARTH_FRAGMENT_SHADER,
  uniforms: {
    sunDirection,
    cloudMap,
    cloudShift,
    dayMap: { value: loadTexture('earth_atmos_2048.jpg', true) },
    nightMap: { value: loadTexture('earth_lights_2048.png', true) },
    normalMap: { value: loadTexture('earth_normal_2048.jpg', false) },
    specularMap: { value: loadTexture('earth_specular_2048.jpg', false) }
  }
});
const clouds = createSphere('clouds', CLOUD_RADIUS, {
  fragmentShader: CLOUD_FRAGMENT_SHADER,
  uniforms: { sunDirection, cloudMap },
  transparent: true,
  depthWrite: false
});
const atmosphere = createSphere('atmosphere', ATMOSPHERE_RADIUS, {
  fragmentShader: ATMOSPHERE_FRAGMENT_SHADER,
  uniforms: { sunDirection },
  side: THREE.BackSide,
  blending: THREE.AdditiveBlending,
  transparent: true,
  depthWrite: false
});

const planet = new THREE.Group();
planet.name = 'planet';
planet.rotation.z = AXIAL_TILT;
planet.add(earth, clouds);
scene.add(planet, atmosphere, createSun(), createStars());

function createSun() {
  const size = 256;
  const glowCanvas = document.createElement('canvas');
  glowCanvas.width = glowCanvas.height = size;
  const context = glowCanvas.getContext('2d');
  const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
  gradient.addColorStop(0.08, 'rgba(255, 250, 230, 1)');
  gradient.addColorStop(0.2, 'rgba(255, 210, 140, 0.25)');
  gradient.addColorStop(1, 'rgba(255, 180, 100, 0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);

  const material = new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(glowCanvas),
    // Werte über 1, damit der Kern überstrahlt (Bloom).
    color: new THREE.Color(6, 5.5, 4.5),
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const sun = new THREE.Sprite(material);
  sun.name = 'sun';
  sun.position.copy(SUN_DIRECTION).multiplyScalar(SUN_DISTANCE);
  sun.scale.setScalar(SUN_SIZE);
  return sun;
}

function createStars() {
  const positions = new Float32Array(STAR_COUNT * 3);
  const colors = new Float32Array(STAR_COUNT * 3);
  const direction = new THREE.Vector3();
  const color = new THREE.Color();
  for (let index = 0; index < STAR_COUNT; index++) {
    direction.randomDirection().multiplyScalar(STAR_DISTANCE).toArray(positions, index * 3);
    // Wenige helle, viele schwache Sterne; Farbton von bläulich bis gelblich.
    const brightness = 0.15 + 1.6 * Math.random() ** 4;
    color.setHSL(Math.random() < 0.5 ? 0.6 : 0.12, 0.5, 0.75).multiplyScalar(brightness);
    color.toArray(colors, index * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({ size: 1.3, sizeAttenuation: false, vertexColors: true });
  const stars = new THREE.Points(geometry, material);
  stars.name = 'stars';
  return stars;
}

// Mehrfachabtastung im Zwischenbild, weil das Antialiasing des Canvas beim Composer nicht greift.
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, {
  type: THREE.HalfFloatType,
  samples: 4
}));
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.5, 0.7, BLOOM_THRESHOLD));
composer.addPass(new OutputPass());

function resize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  // Im Hochformat gilt der Blickwinkel für die Breite, sonst wäre die Erde seitlich abgeschnitten.
  const halfAngle = THREE.MathUtils.degToRad(FIELD_OF_VIEW / 2);
  camera.fov = camera.aspect >= 1
    ? FIELD_OF_VIEW
    : THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(halfAngle) / camera.aspect));
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', resize);
resize();

let targetOrbit = createOrbit();
let currentOrbit = targetOrbit;
let spinning = true;
const activePointers = new Map();

function pointerSpread() {
  const [first, second] = [...activePointers.values()];
  return Math.hypot(first.x - second.x, first.y - second.y);
}

canvas.addEventListener('pointerdown', event => {
  canvas.setPointerCapture(event.pointerId);
  activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
});
canvas.addEventListener('pointermove', event => {
  const previous = activePointers.get(event.pointerId);
  if (!previous) return;
  const spreadBefore = activePointers.size === 2 ? pointerSpread() : 0;
  activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (activePointers.size === 1) {
    // Nah an der Oberfläche feiner drehen, damit der Punkt unter dem Zeiger bleibt.
    const speed = DRAG_SPEED * (targetOrbit.distance - EARTH_RADIUS);
    targetOrbit = rotateOrbit(
      targetOrbit, (previous.x - event.clientX) * speed, (previous.y - event.clientY) * speed
    );
  } else if (activePointers.size === 2) {
    const spreadAfter = pointerSpread();
    if (spreadBefore > 0 && spreadAfter > 0) targetOrbit = zoomOrbit(targetOrbit, spreadBefore / spreadAfter);
  }
});
for (const type of ['pointerup', 'pointercancel']) {
  canvas.addEventListener(type, event => activePointers.delete(event.pointerId));
}
canvas.addEventListener('wheel', event => {
  event.preventDefault();
  targetOrbit = zoomOrbit(targetOrbit, Math.exp(event.deltaY * WHEEL_ZOOM));
}, { passive: false });
document.addEventListener('keydown', event => {
  if (event.key !== ' ') return;
  event.preventDefault();
  spinning = !spinning;
});

let lastTime = null;
function frame(time) {
  const deltaSeconds = lastTime === null ? 0 : Math.min((time - lastTime) / 1000, MAX_FRAME_SECONDS);
  lastTime = time;

  if (spinning) {
    earth.rotation.y += EARTH_SPIN * deltaSeconds;
    cloudShift.value = (cloudShift.value + (CLOUD_DRIFT * deltaSeconds) / (2 * Math.PI)) % 1;
    clouds.rotation.y = earth.rotation.y + cloudShift.value * 2 * Math.PI;
  }
  currentOrbit = smoothOrbit(currentOrbit, targetOrbit, deltaSeconds);
  const position = orbitPosition(currentOrbit);
  camera.position.set(position.x, position.y, position.z);
  camera.lookAt(0, 0, 0);

  composer.render();
  requestAnimationFrame(frame);
}

// onLoad feuert auch nach einem Fehler; die Meldung soll dann stehen bleiben.
let loadFailed = false;
loadingManager.onLoad = () => {
  statusElement.hidden = !loadFailed;
  requestAnimationFrame(frame);
};
loadingManager.onError = url => {
  loadFailed = true;
  statusElement.textContent = `Textur konnte nicht geladen werden: ${url}`;
};
