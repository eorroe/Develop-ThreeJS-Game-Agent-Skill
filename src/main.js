import { Engine } from './core/engine.js';
import { createConfig } from './core/config.js';

import { RenderSystem } from './render/index.js';
import { MaterialSystem } from './materials/index.js';
import { SkySystem } from './sky/index.js';
import { WorldSystem } from './world/index.js';
import { PhysicsSystem } from './physics/index.js';
import { PlayerSystem } from './player/index.js';
import { WeaponSystem } from './weapons/index.js';
import { FxSystem } from './fx/index.js';
import { AiSystem } from './ai/index.js';
import { UiSystem } from './ui/index.js';
import { AudioSystem } from './audio/index.js';

import { installShotApi } from './dev/shots.js';
import { prewarm } from './core/prewarm.js';

const params = new URLSearchParams(location.search);
const capture = params.get('capture') === '1';
// Deterministic shutter for the pixel gate: the engine does not schedule its own
// frames, the driver advances exactly N of them through window.__PUMP__. Opt-in,
// because tools that measure real frame pacing (tools/perf.mjs) need the loop to
// free-run. See the long comment in src/dev/shots.js.
const lockstep = capture && params.get('lockstep') === '1';
const progressive = !capture && !lockstep;

const config = createConfig({
  quality: params.get('q') ?? 'ultra',
  deterministic: capture,
});

const canvas = document.getElementById('game');

const engine = new Engine({ canvas, config });

// Registration order is irrelevant — Registry topo-sorts on static deps.
engine
  .add(RenderSystem)
  .add(MaterialSystem)
  .add(SkySystem)
  .add(WorldSystem)
  .add(PhysicsSystem)
  .add(PlayerSystem)
  .add(WeaponSystem)
  .add(FxSystem)
  .add(AiSystem)
  .add(UiSystem)
  .add(AudioSystem);

try {
  // In interactive mode, progressive initialization paints the 1st frame to canvas
  // in <16-30ms instead of waiting for full world & BVH tree construction.
  await engine.init({ progressive });
} catch (err) {
  console.error('[boot] init failed', err);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<pre style="position:fixed;inset:0;padding:2rem;color:#f66;background:#000;
       font:12px/1.5 ui-monospace,monospace;overflow:auto;z-index:9999;white-space:pre-wrap">
BOOT FAILURE\n\n${err.stack ?? err.message}</pre>`
  );
  throw err;
}

const shotApi = installShotApi(engine, { capture, lockstep });

// Start the engine loop immediately so canvas paints from frame 0
engine.start();

// Prewarm shaders: in capture/lockstep mode, await readiness and warmup synchronously for
// deterministic pixel testing. In interactive mode, warm shaders lazily in the background
// without blocking initial gameplay paints.
let warmupPromise = null;
if (params.get('prewarm') === '0') {
  window.__PREWARM__ = { ok: false, reason: 'disabled by ?prewarm=0' };
} else if (capture || lockstep) {
  await engine.whenReady();
  const warmup = await prewarm(engine);
  console.info('[boot] prewarm', warmup);
  window.__PREWARM__ = warmup;
} else {
  warmupPromise = engine.whenReady().then(async () => {
    const warmup = await prewarm(engine);
    console.info('[boot] lazy prewarm complete', warmup);
    window.__PREWARM__ = warmup;
    return warmup;
  }).catch((err) => {
    console.warn('[boot] lazy prewarm error', err);
  });
}

// Capture harness handshake: only flag ready once a frame has actually landed.
//
// BOOT_FRAMES is deliberately a frame COUNT, not a rAF race. In lockstep mode the
// engine has no loop of its own, so we hand-pump exactly this many frames and only
// then raise __READY__; the shot is therefore always applied at engine frame 3, no
// matter how long boot (or pre-warm) took in wall-clock terms.
const BOOT_FRAMES = 3;
if (lockstep) {
  await engine.whenReady();
  await shotApi.pump(BOOT_FRAMES);
  window.__READY__ = true;
} else if (capture) {
  await engine.whenReady();
  if (warmupPromise) await warmupPromise;
  let warm = 0;
  const readyProbe = () => {
    if (++warm >= BOOT_FRAMES) {
      window.__READY__ = true;
      return;
    }
    requestAnimationFrame(readyProbe);
  };
  requestAnimationFrame(readyProbe);
} else {
  let warm = 0;
  const readyProbe = () => {
    if (++warm >= BOOT_FRAMES) {
      window.__READY__ = true;
      return;
    }
    requestAnimationFrame(readyProbe);
  };
  requestAnimationFrame(readyProbe);
}

window.__ENGINE__ = engine;

if (import.meta.hot) {
  import.meta.hot.dispose(() => engine.dispose());
}
