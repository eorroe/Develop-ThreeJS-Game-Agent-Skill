---
name: develop-threeJS-game
description: "Execute the Improved-Prompt.md workflow to build a browser-based first-person shooter in Three.js r180 with strict engine contract, procedural assets, parallel sub-agents, and blind visual review against user-specified AAA-quality game benchmarks."
category: game-development
risk: safe
source: self
source_type: self
date_added: "2026-08-17"
author: kilo
tags: [threejs, fps, game-development, sub-agents, procedural-generation]
tools: []
---

# develop-threeJS-game

## Overview

This skill executes the improved prompt workflow for building a browser-based first-person shooter in Three.js r180 (WebGL2) whose visual and tactile quality stands next to a user-specified AAA-quality game title. It enforces a strict engine contract including directory ownership, no cross-subsystem imports, procedural-only assets, reproducibility via `ctx.rng`, preallocation, disposal, and build integrity. The skill fans out parallel sub-agents across 11 subsystems, runs a blind visual review loop with a harsh critic rubric, and stops only when every subsystem passes the quality bar against the chosen reference title.

## When to Use This Skill

- Use when you need to build a browser-based FPS in Three.js with AAA-quality visuals
- Use when working with the OVERWATCH engine contract and subsystem architecture
- Use when the user asks to execute the Improved-Prompt.md workflow
- Use when fanning out sub-agents across subsystems with blind visual review loops

## How It Works

**Mandatory Precondition:** Before writing any code, all agents must read `ARCHITECTURE.md` completely. `ARCHITECTURE.md` is the only coordination mechanism between parallel agents. It defines the OVERWATCH engine contract, including hard rules, subsystem interface, ownership map, cross-subsystem events, render integration rules, light-count stability requirements, pre-warm procedures, and the non-negotiable quality bar. Every agent must understand and adhere to this contract before executing any skill behavior.

### Step 1: Ask User for Desired Goal and Reference Title

Before executing any skill behavior, use the `question` tool to ask the user:

"What is your explicit desired goal for using this skill? Specifically: what should the resulting FPS project enable you to do, and what subsystems or features should be prioritized?"

Also ask:

"What AAA-quality game title should be used as the visual reference or recreation target? Provide the exact game name and, if possible, the specific title/edition (e.g., 'Call of Duty: Modern Warfare III (2023)', 'Valorant', 'Counter-Strike 2')."

Repeat questioning until a clear, unambiguous goal and reference title are derived.

### Step 2: Ask User for Reference Material

Use the `question` tool to ask the user how they will provide visual reference material for the blind visual review:

"How will you provide visual references for the blind comparison? Choose one of the following options:
- **Images**: Provide one or more image file paths (local paths or URLs)
- **Directory of images**: Provide a local directory path containing reference images
- **Videos**: Provide one or more video file paths (local paths or URLs) from which frames will be extracted"

If the user provides videos, inform them that the skill will automatically extract 1 frame per second from each video using FFmpeg to create the reference image set. Do not proceed to Step 3 until the user confirms the reference material source.

### Step 2a: Video Reference Handling

If the user provides video references (local paths or URLs), execute the following substeps before proceeding to Step 3:

**Substep 2a.1: Install or verify FFmpeg availability**
- Check if `ffmpeg` is available on the system by running `ffmpeg -version`
- If not available, instruct the user to install FFmpeg from https://ffmpeg.org/download.html or use a package manager (`choco install ffmpeg`, `brew install ffmpeg`, `apt install ffmpeg`, etc.)
- Do not proceed until FFmpeg is confirmed available

**Substep 2a.2: Create reference frames directory**
- Create a directory named `references/frames/` in the project root or skill directory
- If the directory already exists, clear its contents to avoid stale frames

**Substep 2a.3: Extract frames from each video**
- For each video file provided by the user, run the following FFmpeg command to extract exactly 1 frame per second:
  ```bash
  ffmpeg -i "INPUT_VIDEO_PATH" -vf fps=1 "references/frames/INPUT_VIDEO_NAME_%04d.jpg"
  ```
  - Replace `INPUT_VIDEO_PATH` with the actual video file path
  - Replace `INPUT_VIDEO_NAME` with the video filename without extension
  - Use `-q:v 2` for JPEG quality if needed: `ffmpeg -i "INPUT_VIDEO_PATH" -vf fps=1 -q:v 2 "references/frames/INPUT_VIDEO_NAME_%04d.jpg"`
- Process each video sequentially; do not use `&&` in shell commands
- Verify that frames were created by checking the output directory
- If frame extraction fails for any video, report the error to the user and ask whether to continue with available references or abort

**Substep 2a.4: Confirm reference set**
- After extraction, report to the user:
  - Number of videos processed
  - Number of frames extracted per video
  - Total reference frames available
  - Location of reference frames directory
- Ask the user to confirm whether the reference set is sufficient or if additional references are needed
- Do not proceed to Step 3 until the user confirms the reference set is adequate

### Step 3: Check Session Context

Check if the session context is at 50% or more. If context is below 50%, proceed with skill execution in the current session. If context is at 50% or more, inform the user and provide the option to execute skill behavior in a new session.

### Step 4: Check for Existing Metrics

Check if a file named `IP-BUILD-FPS-THREEJS-ENGINE-Execution-Metrics.md` exists in the project root or skill directory. If it exists, read it and analyze previous execution results to avoid repeating mistakes. Document findings before proceeding.

### Step 5: Execute Skill Behavior

Execute the improved prompt workflow exactly as specified in the source content. This includes:

**Hard Rules Enforcement:**
1. Directory ownership: each subsystem owns its directory and must never edit files outside it.
2. No cross-subsystem imports: access other subsystems only at runtime via `ctx.get(id)`.
3. No new bun or npm dependencies. `three` only. No CDN fetches, no external images, HDRIs, models, or audio files — the game must run fully offline.
4. Procedural assets only: all textures, meshes, animations, and audio must be generated procedurally at load time. No external art assets of any kind are permitted.
5. No `Math.random()` in gameplay or visuals: use `ctx.rng` or `ctx.rng.fork()` for reproducibility.
6. Preallocate per subsystem: allocate vectors, matrices, and arrays in `init()` and reuse. Never allocate per-frame in `update()`.
7. Dispose resources: geometries, materials, textures, and render targets must be freed in `dispose()`.
8. Build integrity: `bun run build` must pass and `node tools/capture.mjs` must produce a frame after every change.

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
| ↳ | means *damage dealt **to** `target`*. `target` is the local player when an enemy round connects (`'player'`, the player system, or anything with `isPlayer === true`) — filter it out before drawing a hitmarker. Damage is applied by the target's own listener, never by the emitter as well. | |
| `damage:taken` | `{ amount, from: Vector3, health }` | player |
| `actor:death` | `{ actor, point, impulse }` | ai |
| `player:land` | `{ velocity, surface }` | player |
| `player:footstep` | `{ position, surface, running }` | player |
| `player:state` | `{ stance, sprinting, sliding, ads }` | player |
| `explosion` | `{ position, radius, damage }` | any |
| `resize` | `{ width, height }` | engine |

If you need an event that is not listed, add a row here in the same commit.

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

`owNoShadow` is the ONLY shadow-caster switch: the cascades draw with `scene.overrideMaterial` and never consult `mesh.castShadow`. `src/ai` relies on this for its off-screen actor LOD.

### The point-light count is a shader permutation key

`r.addLight()` puts a light under distance culling, and the cull sets `light.visible = false` once the fade reaches zero. Three bakes the number of **visible** point lights into every material's program cache key, so one lamp crossing its radius recompiles every lit material in the scene — measured at +33 to +36 programs and 640-900 ms on that single frame, five times in 900 frames. Anything that registers distance-culled point lights must keep the visible count constant. Two ways, both pixel-exact:

- drive `intensity` to 0 and leave `visible` true (what `src/fx/lights.js` does), or
- park zero-intensity "ballast" lights and top the count up to a fixed slot budget every `lateUpdate` (what `src/world` does for its 17 practicals — see `_stabiliseLightCount`, which mirrors the renderer's own fade test because the cull runs *after* `lateUpdate`).

A light whose colour × intensity is exactly 0 adds a float `0.0` to the irradiance accumulator, so extra lit slots cannot move a pixel.

**Light Count Stability:**
`r.addLight()` puts a light under distance culling. The cull sets `light.visible = false` once the fade reaches zero. Three bakes the number of visible point lights into every material's program cache key. Keep the visible count constant. Either drive `intensity` to 0 and leave `visible` true, or park zero-intensity "ballast" lights and top the count up to a fixed slot budget every `lateUpdate`.

**Pre-warm:**
`src/core/prewarm.js` runs before the first frame and calls `prewarmMaterials(ctx)` on every subsystem that implements it (`render`, `world`, `ai`). Build and compile every material the subsystem can produce, without spawning gameplay objects, drawing a gameplay frame, or touching the clock/RNG. `renderer.compileAsync(scene, camera)` alone only reaches the forward lit variant — not the CSM depth pass, the MRT prepass, or the post chain. Two traps:

- A render target must be bound while compiling. `outputColorSpace` and `toneMapping` are part of the cache key and are read off the *currently bound* target, so compiling with the canvas bound warms the wrong variant.
- `fx` is excluded and self-warms on frame 2: its key depends on the visible light count, which is only settled inside the first rendered frame.

**Quality Bar (Non-Negotiable):**
Every visual subsystem is reviewed by an adversarial critic against frames from the user-specified AAA-quality game title. Non-negotiables:
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
- After each module is implemented, a dedicated Reviewer agent performs a blind visual comparison between the module output and reference screenshots from the user-specified AAA-quality game title captured from the same camera angle and lighting condition.
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

### Step 6: Create Execution Metrics

After executing the skill behavior, create or append to `IP-BUILD-FPS-THREEJS-ENGINE-Execution-Metrics.md` in the project root or skill directory. Populate it with:
- Timestamp of execution
- Prompt provided to skill
- Goal and verification method
- Execution results
- Any mistakes made and lessons learned
- Next steps or recommendations

This metrics file must be created every time the skill is executed.

## Examples

### Example 1: Execute Improved Prompt for New Project

User asks: "Execute the Improved-Prompt.md workflow to build a new FPS project."

Skill behavior:
1. Ask user for desired goal, reference title, and reference material source
2. If videos provided, extract 1 frame per second using FFmpeg
3. Check session context
4. Check for existing metrics file
5. Execute the improved prompt workflow with hard rules, subsystem interface, ownership map, events, quality bar, sub-agent orchestration, and loop/review protocol
6. Create execution metrics file

### Example 2: Execute Improved Prompt for Existing Project

User asks: "Run the IP-BUILD-FPS-THREEJS-ENGINE skill on my existing Three.js project."

Skill behavior:
1. Ask user for desired goal, reference title, and reference material source
2. If videos provided, extract 1 frame per second using FFmpeg
3. Check session context
4. Check for existing metrics file and analyze previous results
5. Execute the improved prompt workflow, adapting to existing project structure while enforcing the engine contract
6. Create/append execution metrics file

## Best Practices

- Always ask the user for their explicit desired goal and verification method before executing any skill behavior
- Always check for existing execution metrics before proceeding to avoid repeating previous mistakes
- Always check session context and offer to execute in a new session if context is at 50% or more
- Follow the engine contract exactly: directory ownership, no cross-subsystem imports, no Math.random(), preallocation, disposal, build integrity
- Use `ctx.get(id)` for runtime access to other subsystems; never import another subsystem's module
- Maintain light count stability to avoid shader recompilation
- Implement pre-warm procedures for all materials before the first frame
- Use the blind visual review protocol with the 1-5 rubric and 4.0 average threshold
- Create execution metrics after every run to track progress and lessons learned

## Limitations

- This skill does not replace environment-specific validation, testing, or expert review.
- Stop and ask for clarification if required inputs, permissions, or safety boundaries are missing.
- The blind visual review requires reference screenshots from the user-specified AAA-quality game title; without them, the review protocol cannot be executed.
- The skill assumes a Node.js/Vite build environment with `bun run build` and `node tools/capture.mjs` available.
- The skill requires Three.js r180 and WebGL2 support; it will not work on older browsers or hardware.

## Security & Safety Notes

- This skill does not include shell commands that fetch external resources or execute arbitrary code.
- All assets are procedurally generated; no external images, HDRIs, models, or audio files are fetched.
- The skill respects the "no new bun or npm dependencies" rule and uses only `three`.
- Before deleting files or using git reset/restore/checkout, always ask for permission to avoid losing untracked changes.
- The skill operates in a local-only context and does not require network access.

## Common Pitfalls

- **Problem:** Forgetting to ask the user for their desired goal and verification method
  **Solution:** Always start with the `question` tool to grill the user for explicit goals and verification criteria before executing any skill behavior.

- **Problem:** Not checking for existing execution metrics before proceeding
  **Solution:** Always check for `IP-BUILD-FPS-THREEJS-ENGINE-Execution-Metrics.md` and read it before executing skill behavior to avoid repeating previous mistakes.

- **Problem:** Proceeding in a session with 50% or more context usage
  **Solution:** Always check session context and offer to execute in a new session if context is at 50% or more.

- **Problem:** Importing another subsystem's module directly
  **Solution:** Always use `ctx.get(id)` for runtime access. Direct imports break parallel safety and violate the engine contract.

- **Problem:** Allocating per-frame in `update()`
  **Solution:** Preallocate all vectors, matrices, and arrays in `init()` and reuse them. A `new THREE.Vector3()` inside `update()` is a bug.

- **Problem:** Breaking light count stability
  **Solution:** Keep the visible point light count constant. Either drive `intensity` to 0 and leave `visible` true, or park zero-intensity "ballast" lights and top the count up to a fixed slot budget every `lateUpdate`.

- **Problem:** Skipping pre-warm
  **Solution:** Implement `prewarmMaterials(ctx)` for all materials in `render`, `world`, and `ai` subsystems. Without pre-warm, the first frame will suffer shader compilation stutters.

- **Problem:** Not following the blind visual review protocol
  **Solution:** Always use the dedicated Reviewer agent with the 1-5 rubric. Do not accept modules that score below 4.0 average or fail 3 or more criteria.

## Related Skills

- `@text-to-agent-skills` - Create skills from text content
- `@html-to-agent-skills` - Create skills from HTML content
- `@github-repo-to-agent-skills` - Create skills from GitHub repositories
- `@youtube-to-agent-skills` - Create skills from YouTube content
- `@explain` - Analyze and explain prompts in detail
- `@plan-create-current-implementation` - Create implementation plans
