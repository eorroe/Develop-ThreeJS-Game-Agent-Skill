Build a browser-based first-person shooter in Three.js r180 (WebGL2) whose visual and tactile quality stands next to modern Call of Duty titles. All textures, meshes, animations, and audio must be procedurally generated at load time — no external art assets, no CDN fetches, no npm dependencies beyond `three`, and the game must run fully offline.

**Hard Rules:**
1. **Directory ownership.** Each subsystem owns its directory and must never edit files outside it.
2. **No cross-subsystem imports.** Access other subsystems only at runtime via `ctx.get(id)`.
3. **No `Math.random()` in gameplay or visuals.** Use `ctx.rng` or `ctx.rng.fork()` for reproducibility.
4. **Preallocate per subsystem.** Allocate vectors, matrices, and arrays in `init()` and reuse. Never allocate per-frame in `update()`.
5. **Dispose resources.** Geometries, materials, textures, and render targets must be freed in `dispose()`.
6. **Build integrity.** `npm run build` must pass and `node tools/capture.mjs` must produce a frame after every change.

**Subsystem Interface:**
Each subsystem must export a class with the following structure:
```js
export class MySystem {
  static id = 'mysystem';       // unique identifier
  static deps = ['render'];     // dependencies that must init first

  async init(ctx) {}            // build resources; may await
  fixedUpdate(h, ctx) {}        // optional, 120 Hz, deterministic gameplay
  update(dt, ctx) {}            // optional, once per frame
  lateUpdate(dt, ctx) {}        // optional, after all update()
  resize(w, h, ctx) {}          // optional
  dispose() {}                  // optional
}
```

**Context API (`ctx`):**
- `scene`, `camera` — world space
- `viewScene`, `viewCamera` — first-person weapon space (composited separately, never clips through walls)
- `canvas`, `config`, `events`, `input`, `time`, `rng`
- `get(id)`, `peek(id)`, `has(id)` — access other subsystems at runtime
- `time` provides `{ elapsed, raw, dt, fixed, alpha, scale, frame }` — use `alpha` for interpolation between physics steps
- `config.q` — active quality preset; respect budgets: `q.taa`, `q.gtao`, `q.ssr`, `q.volumetrics`, `q.shadowMapSize`, `q.particleBudget`, `q.decalBudget`

**Ownership Map (do not edit shared code):**
| id | directory | owns |
|---|---|---|
| `render` | `src/render/` | WebGLRenderer, HDR pipeline, post-processing, CSM shadows, final composite |
| `materials` | `src/materials/` | procedural PBR texture generation, shared material library, triplanar/detail mapping |
| `sky` | `src/sky/` | physical sky, sun/moon, time of day, IBL/env map generation, volumetric fog & light shafts |
| `world` | `src/world/` | level geometry, modular building kit, props, set dressing, static collision meshes |
| `physics` | `src/physics/` | broadphase, raycasts, character controller collision, rigid bodies, ragdolls, penetration |
| `player` | `src/player/` | movement state machine, camera feel, sprint/slide/mantle/lean, health |
| `weapons` | `src/weapons/` | weapon meshes, viewmodel rig, ADS, recoil, sway, bob, reload & inspect animation, ballistics |
| `fx` | `src/fx/` | GPU particles, muzzle flash, tracers, impacts, decals, smoke, blood, shells |
| `ai` | `src/ai/` | enemy characters, navigation, perception, cover selection, combat behaviour |
| `ui` | `src/ui/` | HUD, crosshair, hitmarkers, damage indicators, ammo, killfeed, menus |
| `audio` | `src/audio/` | synthesized weapon/foley audio, spatialisation, reverb, occlusion, mix |

Shared (owned by lead, do not edit): `src/core/`, `src/main.js`, `src/dev/`, `tools/`, `vite.config.js`.

**Cross-Subsystem Events (emit/listen via `ctx.events`):**
| event | payload | emitted by |
|---|---|---|
| `weapon:fire` | `{ weapon, origin: Vector3, dir: Vector3, seed }` | weapons |
| `weapon:reload` | `{ weapon, phase: 'start'\|'magout'\|'magin'\|'end' }` | weapons |
| `weapon:shell` | `{ position, velocity }` | weapons |
| `bullet:impact` | `{ point, normal, surface, incident, damage }` | physics |
| `bullet:tracer` | `{ from, to, speed }` | weapons |
| `damage:dealt` | `{ target, amount, headshot, killed, point }` | ai / physics |
| `damage:taken` | `{ amount, from: Vector3, health }` | player |
| `actor:death` | `{ actor, point, impulse }` | ai |
| `player:land` | `{ velocity, surface }` | player |
| `player:footstep` | `{ position, surface, running }` | player |
| `player:state` | `{ stance, sprinting, sliding, ads }` | player |
| `explosion` | `{ position, radius, damage }` | any |
| `resize` | `{ width, height }` | engine |

If you need an event not listed, add a row in the same commit.

**Surface Types:**
Physics tags every collider with one of: `concrete`, `metal`, `wood`, `dirt`, `sand`, `glass`, `water`, `foliage`, `fabric`, `flesh`, `rubber`, `plaster`.

**Render Integration:**
```js
const r = ctx.get('render');
r.renderer            // THREE.WebGLRenderer — do not change its state outside a frame
r.registerPass(pass)  // insert a custom post pass
r.addLight(light)     // register a punctual light so it participates in culling/budgets
r.requestEnvMap()     // PMREM env map currently in use
r.screenSize          // { width, height } of the internal render target
r.depthTexture        // linear depth, for soft particles / SSR
r.velocityTexture     // motion vectors, for TAA / motion blur
```

Per-object opt-outs (honoured every frame by `render._collect`):
```js
mesh.userData.owNoPrepass = true  // keep out of the depth/normal/velocity prepass
mesh.userData.owNoShadow  = true  // do not cast into the CSM cascades
```

**Light Count Stability:**
`r.addLight()` puts a light under distance culling. The cull sets `light.visible = false` once the fade reaches zero. Three bakes the number of visible point lights into every material's program cache key. Keep the visible count constant. Either drive `intensity` to 0 and leave `visible` true, or park zero-intensity "ballast" lights and top the count up to a fixed slot budget every `lateUpdate`.

**Pre-warm:**
`src/core/prewarm.js` runs before the first frame and calls `prewarmMaterials(ctx)` on every subsystem that implements it (`render`, `world`, `ai`). Build and compile every material the subsystem can produce, without spawning gameplay objects, drawing a gameplay frame, or touching the clock/RNG.

**Quality Bar (Non-Negotiable):**
Every visual subsystem is reviewed by an adversarial critic against real CoD frames:
- **No flat/untextured surfaces.** Every material needs albedo variation, a normal map, roughness variation, and a detail layer visible at 0.5 m.
- **No uniform lighting.** Contact shadows, bounce, ambient occlusion, and a clear key/fill/rim separation.
- **Physically plausible values.** Albedo in 0.02–0.9, metals are 0 or 1, real-world light intensities, exposure-driven not multiplier-driven.
- **Nothing perfectly straight, clean, or repeated.** Edge wear, grime in crevices, subtle warp, varied instance rotation/scale.
- **Every action has weight.** Recoil, camera shake, screen-space impulse, audio transient, and a visual FX on every impact.

**Sub-Agent Orchestration:**
- Fan out parallel sub-agents across the 11 subsystems defined in the Ownership Map. Each sub-agent owns one or more non-overlapping subsystems and must never edit files outside its assigned directories.
- Dependencies between subsystems must be declared upfront; a sub-agent may only begin work after all subsystems listed in its `static deps` have completed.
- Use `ctx.get(id)` to access other subsystems at runtime. Never import another subsystem's module.

**Loop and Review Protocol:**
- After each module is implemented, a dedicated Reviewer agent performs a blind visual comparison between the module output and reference screenshots from Call of Duty: Modern Warfare III (2023) captured from the same camera angle and lighting condition.
- The Reviewer uses the following rubric and assigns a score from 1 to 5 for each criterion:
  - Texture resolution and detail
  - Lighting realism and shadow quality
  - Material PBR accuracy
  - Geometry complexity and silhouette
  - Post-processing polish
  - Overall visual fidelity
- The module is accepted only if the Reviewer assigns an average score of 4.0 or higher AND explicitly states that the output is indistinguishable from or better than the reference in at least 4 of the 6 criteria.
- If the module fails, the Reviewer provides a written critique, and the implementing sub-agent revises and resubmits. Repeat until the module passes.
- Continue until all modules pass. Do not proceed to integration until all modules have been accepted.

**Deliverables:**
- A single self-contained HTML file with inline JavaScript that launches the complete scene in a browser.
- A markdown file documenting the review scores and critiques for each module.

**Stop Condition:**
- Stop only when every module has passed the blind comparison rubric on the first attempt. Do not add stretch goals or additional maps unless a module passes on its first submission.