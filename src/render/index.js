import * as THREE from 'three';

import { hdrTarget, blit } from './pass.js';
import { CascadedShadowMaps } from './csm.js';
import { MaterialPatcher } from './materialpatch.js';
import { GBuffer } from './prepass.js';
import { Gtao } from './gtao.js';
import { ContactShadows } from './contact.js';
import { Ssr } from './ssr.js';
import { Taa } from './taa.js';
import { MotionBlur } from './motionblur.js';
import { DepthOfField } from './dof.js';
import { Bloom } from './bloom.js';
import { AutoExposure } from './exposure.js';
import { createGradeLut } from './lut.js';
import { createComposite, createFxaa, createDebug, createViewComposite } from './composite.js';
import { buildFallbackEnvironment } from './env.js';
import { RenderProbeScene } from './probe.js';

const QUALITY_LEVEL = { low: 0, medium: 1, high: 2, ultra: 3 };

/**
 * Registration range at or below which a punctual light counts as a room/street
 * PRACTICAL rather than as an effect flash. See `settings.practicalGain`.
 */
const PRACTICAL_RANGE = 30;

// Full-daylight key intensity (SUN_ILLUMINANCE_TOP through a clear atmosphere).
// Only used to normalise the viewmodel rig, never to light anything.
const REF_DAYLIGHT = 4.6;

/**
 * OVERWATCH renderer.
 */
export class RenderSystem {
  static id = 'render';
  static deps = [];

  async init(ctx) {
    this.ctx = ctx;
    const cfg = ctx.config;
    const q = cfg.q;
    this.q = q;
    this.qLevel = QUALITY_LEVEL[cfg.quality] ?? 3;
    this.rng = ctx.rng.fork();
    this.frame = 0;

    // ---- renderer -------------------------------------------------------
    const renderer = new THREE.WebGLRenderer({
      canvas: ctx.canvas,
      antialias: false,
      alpha: false,
      depth: true,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false,
    });
    if (!renderer.capabilities.isWebGL2) {
      throw new Error('[render] WebGL2 is required');
    }
    renderer.autoClear = false;
    renderer.autoClearColor = false;
    renderer.autoClearDepth = false;
    renderer.info.autoReset = false;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = true;
    renderer.setClearColor(0x000000, 1);
    this.renderer = renderer;

    const rawCompile = renderer.compile.bind(renderer);
    renderer.compile = (target, cam, targetScene) => {
      if (target === ctx.scene) this._patchLikeFrame(ctx.scene, false);
      else if (target === ctx.viewScene) this._patchLikeFrame(ctx.viewScene, true);
      return rawCompile(target, cam, targetScene);
    };

    this.maxAnisotropy = Math.min(
      q.anisotropy,
      renderer.capabilities.getMaxAnisotropy()
    );

    // ---- subsystems of the pipeline --------------------------------------
    this.csm = new CascadedShadowMaps(renderer, {
      cascades: q.cascades,
      mapSize: q.shadowMapSize,
      maxDistance: q.shadowDistance,
    });
    this.patcher = new MaterialPatcher(this.csm.uniforms, {
      cascades: this.csm.cascades,
      quality: this.qLevel,
    });

    this.gbuffer = new GBuffer();
    this.gtao = q.gtao ? new Gtao() : null;
    this.contact = this.qLevel >= 1 ? new ContactShadows() : null;
    this.ssr = q.ssr ? new Ssr() : null;
    this.taa = q.taa ? new Taa() : null;
    this.motionBlur = q.motionBlur ? new MotionBlur() : null;
    this.dof = this.qLevel >= 1 ? new DepthOfField() : null;
    this.bloom = q.bloom ? new Bloom(this.qLevel >= 2 ? 6 : 5) : null;
    this.exposure = new AutoExposure();
    this.exposure.setLimits(-4.3, 20);
    this.lut = createGradeLut('default');
    this.composite = createComposite(this.lut);
    this.viewComposite = createViewComposite();
    this.fxaa = q.taa ? null : createFxaa();
    this._viewSamples = this.qLevel >= 2 ? 4 : this.qLevel >= 1 ? 2 : 0;

    this.needsPrepass = true;

    this.hdrRt = null;
    this.viewRt = null;
    this.ldrRt = null;
    this.pingRt = [null, null];
    this._pingIndex = 0;
    this._adsT = 0;
    this._weapons = null;

    this._tmpV3 = new THREE.Vector3();
    this._tmpV3b = new THREE.Vector3();
    this._fillHue = new THREE.Vector3();
    this._fillHue2 = new THREE.Vector3();
    this._fillSkySave = new THREE.Vector3();
    this._fillGroundSave = new THREE.Vector3();
    this._ambLevel = 0.6;
    this._roomsReady = false;
    this._skyExposureBias = 0;

    // ---- lighting defaults ------------------------------------------------
    this.sun = new THREE.DirectionalLight(0xffe8c4, 4.3);
    this.sun.name = 'ow-fallback-sun';
    this.sun.position.set(-42, 46, 26);
    this.sun.castShadow = false;
    this.sun.target.position.set(0, 0, 0);
    ctx.scene.add(this.sun);
    ctx.scene.add(this.sun.target);
    this.activeSun = this.sun;
    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.sunDirView = new THREE.Vector3(0, 1, 0);

    // ---- viewmodel light rig ---------------------------------------------
    this.viewSun = new THREE.DirectionalLight(0xffe8c4, 2.0);
    this.viewSun.name = 'ow-viewmodel-key';
    this.viewKeyFill = new THREE.DirectionalLight(0x9ec4ff, 0.6);
    this.viewKeyFill.name = 'ow-viewmodel-fill';
    this.viewRim = new THREE.DirectionalLight(0xffd7a8, 1.0);
    this.viewRim.name = 'ow-viewmodel-rim';
    this.viewFill = new THREE.HemisphereLight(0x8fb6ff, 0x36302a, 0.35);
    this.viewBounce = new THREE.DirectionalLight(0xffb87a, 0.5);
    this.viewBounce.name = 'ow-viewmodel-bounce';
    this._viewKeyDir = new THREE.Vector3(-0.45, 0.75, 0.55).normalize();
    this._viewFillDir = new THREE.Vector3(0.6, -0.15, 0.5).normalize();
    this._viewRimDir = new THREE.Vector3(0.2, 0.35, -0.9).normalize();
    this._viewBounceDir = new THREE.Vector3(-0.2, -0.86, 0.47).normalize();
    this._tmpV3c = new THREE.Vector3();
    for (const l of [this.viewSun, this.viewKeyFill, this.viewRim, this.viewBounce]) {
      l.castShadow = false;
      ctx.viewScene.add(l, l.target);
    }
    ctx.viewScene.add(this.viewFill);
    this._viewRigChildren = ctx.viewScene.children.length;

    const env = buildFallbackEnvironment(renderer, this._dirFromLight(this.sun, this.sunDir));
    this.envTarget = env.target;
    this.envEquirect = env.equirect;
    this.envMap = this.envTarget.texture;
    if (!ctx.scene.environment) ctx.scene.environment = this.envMap;
    if (!ctx.scene.background) ctx.scene.background = this.envEquirect;
    ctx.viewScene.environment = ctx.scene.environment;
    this._assignedViewEnv = ctx.scene.environment;

    // ---- bookkeeping ------------------------------------------------------
    this.passes = [];
    this.lights = [];
    this._draw = [];
    this._nDraw = 0;
    this._hide = [];
    this._nHide = 0;
    this._noShadow = [];
    this._nNoShadow = 0;
    this._dirLights = [];
    this._nDirLights = 0;
    this._foreignMeshes = 0;

    this._currVP = new THREE.Matrix4();
    this._prevVP = new THREE.Matrix4();
    this._invVP = new THREE.Matrix4();
    this._camPos = new THREE.Vector3();
    this._jitterSaved = new THREE.Vector2();
    this._viewVisible = false;
    this._readback = new Float32Array(4);
    this._readback2 = new Float32Array(4);
    this._jittered = false;
    this._firstFrame = true;

    this.screenSize = { width: 1, height: 1 };
    this.displaySize = { width: 1, height: 1 };
    this.depthTexture = null;
    this.velocityTexture = null;
    this.normalTexture = null;
    this.aoTexture = null;
    this.exposureTexture = this.exposure.texture;

    this.settings = {
      exposureBias: 0,
      exposureKey: 1.06,
      autoExposure: true,
      bloomStrength: 0.14,
      bloomThreshold: 1.6,
      bloomKnee: 0.9,
      chromatic: 0.0011,
      vignette: 0.24,
      adsVignette: 0.34,
      grain: 0.010,
      dofMaxCoc: 3.3,
      dofNearRatio: 0.38,
      dofFocusMin: 3.0,
      dofFocusMax: 18.0,
      dofFarStart: 1.15,
      dofFarRange: 18.0,
      dofNearScale: 0.55,
      sharpen: 0.25,
      lutStrength: 1.0,
      shutter: 0.42,
      aoRadius: 1.35,
      aoIntensity: 1.1,
      contactLength: 0.4,
      contactStrength: 1.0,
      skyFill: 0.32,
      groundFill: 0.013,
      bounceFill: 0.008,
      iblDiffuse: 0.030,
      interiorIndirect: 0.035,
      practicalGain: 0.55,
      viewFillOcclusion: 0.45,
      viewKeyScale: 0.55,
      viewKeyMax: 2.6,
      viewFillRatio: 0.3,
      viewRimRatio: 0.5,
      viewHemiRatio: 0.16,
      viewBounceRatio: 0.34,
      viewKeyGamma: 0.65,
      shadowStrength: 1.0,
      sunSoftness: 0.024,
    };
    this._applySettings();

    this.probe = new RenderProbeScene(this.rng.fork());
    this.probeActive = false;
    this._probeExposure = ctx.config.deterministic === true;
    this.debugView = new URLSearchParams(location.search).get('rview') || null;
    this._debugPass = null;
    this._noCascadeCull = /[?&]owNoCascadeCull=1/.test(location.search);
    this._visit = this._visit.bind(this);
    this._visitView = this._visitView.bind(this);

    const w = ctx.canvas.clientWidth || 1920;
    const h = ctx.canvas.clientHeight || 1080;
    this.resize(w, h, ctx);

    console.info(
      `[render] WebGL2 · ${cfg.quality} · ${this.csm.cascades}x${this.csm.mapSize} CSM · ` +
        `taa:${!!this.taa} gtao:${!!this.gtao} ssr:${!!this.ssr} mb:${!!this.motionBlur}`
    );

    // Fast first paint on initialization
    this.paintInitialFrame();
  }

  /**
   * Immediately clear and paint the initial frame to canvas without waiting
   * for remaining background subsystems or prewarm shaders to complete.
   */
  paintInitialFrame() {
    if (!this.renderer || !this.ctx) return;
    try {
      this.renderer.setRenderTarget(null);
      this.renderer.setClearColor(0x0a0d12, 1);
      this.renderer.clear(true, true, true);
      if (this.ctx.camera && this.ctx.scene) {
        this.renderer.render(this.ctx.scene, this.ctx.camera);
      }
    } catch (err) {
      console.warn('[render] paintInitialFrame fallback:', err);
    }
  }

  // ==========================================================================
  //  public API (see ARCHITECTURE.md "Render integration")
  // ==========================================================================

  registerPass(pass) {
    this.passes.push(pass);
    this.passes.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    if (pass.resize) pass.resize(this.screenSize.width, this.screenSize.height);
    return () => {
      const i = this.passes.indexOf(pass);
      if (i >= 0) this.passes.splice(i, 1);
    };
  }

  addLight(light, opts = {}) {
    if (!light || this.lights.some((l) => l.light === light)) return light;
    this.lights.push({
      light,
      range: opts.range ?? light.distance ?? 25,
      priority: opts.priority ?? 1,
      baseIntensity: light.intensity,
    });
    return light;
  }

  removeLight(light) {
    const i = this.lights.findIndex((l) => l.light === light);
    if (i >= 0) this.lights.splice(i, 1);
  }

  requestEnvMap() {
    return this.ctx?.scene.environment ?? this.envMap;
  }

  setEnvMap(texture) {
    this.ctx.scene.environment = texture;
    this.ctx.viewScene.environment = texture;
    this.envMap = texture;
  }

  patchMaterials(root) {
    root.traverse((o) => {
      const m = o.material;
      if (!m) return;
      if (Array.isArray(m)) for (const mm of m) this.patcher.patch(mm);
      else this.patcher.patch(m);
    });
  }

  _patchLikeFrame(root, isViewScene) {
    root.traverseVisible((o) => {
      if (isViewScene) {
        if (o.isMesh !== true) return;
      } else if (
        o.isMesh !== true &&
        o.isPoints !== true &&
        o.isSprite !== true &&
        o.isLine !== true
      ) {
        return;
      }
      const m = o.material;
      if (Array.isArray(m)) for (let i = 0; i < m.length; i++) this.patcher.patch(m[i]);
      else if (m) this.patcher.patch(m);
    });
  }

  setExposureBias(ev) {
    this.settings.exposureBias = ev;
  }

  async prewarmMaterials({ post = true, shadow = this.frame === 0 } = {}) {
    const t0 = performance.now();
    const renderer = this.renderer;
    const ctx = this.ctx;
    if (!renderer || !ctx) return { ok: false, reason: 'not initialised' };
    const programsBefore = renderer.info.programs?.length ?? 0;
    const prevTarget = renderer.getRenderTarget();

    try {
      this._patchLikeFrame(ctx.scene, false);
      this._patchLikeFrame(ctx.viewScene, true);

      try {
        await renderer.compileAsync(ctx.scene, ctx.camera);
        await renderer.compileAsync(ctx.viewScene, ctx.viewCamera);
      } catch {
        renderer.compile(ctx.scene, ctx.camera);
        renderer.compile(ctx.viewScene, ctx.viewCamera);
      }

      if (shadow) {
        const camera = ctx.camera;
        camera.updateMatrixWorld();
        this._collect(ctx.scene);
        this._syncSun(camera);
        const bg = ctx.scene.background;
        const fit = this.csm.snapshotFit();
        const sunSave = {
          dir: this.sunDir.clone(),
          dirView: this.sunDirView.clone(),
          active: this.activeSun,
          fallbackVisible: this.sun.visible,
          ambLevel: this._ambLevel,
        };
        ctx.scene.background = null;
        this._hideList(this._hide, this._nHide);
        this._hideList(this._noShadow, this._nNoShadow);
        this.csm.update(camera, this.sunDir, this.settings.sunSoftness);
        this.csm.render(renderer, ctx.scene, this._noCascadeCull ? null : this._draw, this._nDraw);
        this._showList(this._noShadow, this._nNoShadow);
        this.gbuffer.render(
          renderer,
          ctx.scene,
          camera,
          this._currVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
          this._currVP,
          true
        );
        this._showList(this._hide, this._nHide);
        ctx.scene.background = bg;
        this.csm.restoreFit(fit);
        this.sunDir.copy(sunSave.dir);
        this.sunDirView.copy(sunSave.dirView);
        this.activeSun = sunSave.active;
        this.sun.visible = sunSave.fallbackVisible;
        this._ambLevel = sunSave.ambLevel;
      }

      if (post) {
        const scratch = hdrTarget(4, 4, { name: 'prewarm-scratch' });
        const mats = [];
        this._collectPassMaterials(mats);
        for (const m of mats) {
          try {
            blit(renderer, m, scratch);
          } catch {}
        }
        scratch.dispose();
      }
    } catch (e) {
      return { ok: false, reason: String(e && e.message ? e.message : e) };
    } finally {
      renderer.setRenderTarget(prevTarget);
    }

    const programsAfter = renderer.info.programs?.length ?? 0;
    return {
      ok: true,
      ms: Math.round(performance.now() - t0),
      programsBefore,
      programsAfter,
      compiled: programsAfter - programsBefore,
      parallel: !!renderer.getContext().getExtension('KHR_parallel_shader_compile'),
    };
  }

  _collectPassMaterials(out) {
    const add = (p) => {
      if (p && p.material) out.push(p.material);
    };
    add(this.composite);
    add(this.viewComposite);
    add(this.fxaa);
    if (this.gtao) {
      add(this.gtao.core);
      add(this.gtao.temporal);
      add(this.gtao.blur);
    }
    if (this.contact) {
      add(this.contact.pass);
      add(this.contact.blur);
    }
    if (this.ssr) {
      add(this.ssr.pass);
      add(this.ssr.blur);
    }
    if (this.taa) add(this.taa.pass);
    if (this.motionBlur) {
      add(this.motionBlur.tilePass);
      add(this.motionBlur.blurPass);
    }
    if (this.dof) {
      add(this.dof.pre);
      add(this.dof.gather);
      add(this.dof.combine);
    }
    if (this.bloom) {
      add(this.bloom.down);
      add(this.bloom.up);
    }
    add(this.exposure.logPass);
    add(this.exposure.reducePass);
    add(this.exposure.adaptPass);
    return out;
  }

  get hdrTexture() {
    return this.hdrRt?.texture ?? null;
  }

  probeHdr(u0, v0, u1, v1) {
    const rt = this.hdrRt;
    if (!rt) return null;
    const W = this.screenSize.width;
    const H = this.screenSize.height;
    const x = Math.max(0, Math.round(u0 * W));
    const y = Math.max(0, Math.round((1 - v1) * H));
    const w = Math.max(1, Math.min(W - x, Math.round((u1 - u0) * W)));
    const h = Math.max(1, Math.min(H - y, Math.round((v1 - v0) * H)));
    const half = rt.texture.type === THREE.HalfFloatType;
    const buf = half ? new Uint16Array(w * h * 4) : new Float32Array(w * h * 4);
    this.renderer.readRenderTargetPixels(rt, x, y, w, h, buf);
    const dec = half ? THREE.DataUtils.fromHalfFloat : (v) => v;
    let r = 0;
    let g = 0;
    let b = 0;
    let mx = 0;
    const n = w * h;
    for (let i = 0; i < n; i++) {
      const cr = dec(buf[i * 4]);
      const cg = dec(buf[i * 4 + 1]);
      const cb = dec(buf[i * 4 + 2]);
      r += cr;
      g += cg;
      b += cb;
      mx = Math.max(mx, cr, cg, cb);
    }
    return { r: r / n, g: g / n, b: b / n, max: mx, n };
  }

  probeHdrGrid(cols = 32, rows = 18) {
    const rt = this.hdrRt;
    if (!rt) return null;
    const W = this.screenSize.width;
    const H = this.screenSize.height;
    const half = rt.texture.type === THREE.HalfFloatType;
    const buf = half ? new Uint16Array(W * H * 4) : new Float32Array(W * H * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
    const dec = half ? THREE.DataUtils.fromHalfFloat : (v) => v;
    const out = new Float32Array(cols * rows * 3);
    const cnt = new Float32Array(cols * rows);
    for (let y = 0; y < H; y++) {
      const gy = Math.min(rows - 1, Math.floor(((H - 1 - y) / H) * rows));
      for (let x = 0; x < W; x++) {
        const gx = Math.min(cols - 1, Math.floor((x / W) * cols));
        const s = (y * W + x) * 4;
        const d = (gy * cols + gx) * 3;
        out[d] += dec(buf[s]);
        out[d + 1] += dec(buf[s + 1]);
        out[d + 2] += dec(buf[s + 2]);
        cnt[gy * cols + gx]++;
      }
    }
    const res = [];
    for (let i = 0; i < cols * rows; i++) {
      const c = Math.max(1, cnt[i]);
      res.push([out[i * 3] / c, out[i * 3 + 1] / c, out[i * 3 + 2] / c]);
    }
    return { cols, rows, cells: res };
  }

  _applySettings() {
    const s = this.settings;
    const cu = this.composite.uniforms;
    cu.uLens.value.set(s.chromatic, s.vignette, s.grain, 0);
    cu.uGrade.value.set(s.bloomStrength, s.lutStrength, this.taa ? s.sharpen : 0, this.lut.size);
    this.csm.setStrength(s.shadowStrength);
    if (this.bloom) {
      this.bloom.threshold = s.bloomThreshold;
      this.bloom.knee = s.bloomKnee;
    }
    if (this.gtao) {
      this.gtao.setRadius(s.aoRadius);
      this.gtao.setIntensity(s.aoIntensity);
    }
    if (this.contact) {
      this.contact.setLength(s.contactLength);
      this.contact.setStrength(s.contactStrength);
    }
  }

  resize(w, h, ctx) {
    const pr = Math.min(globalThis.devicePixelRatio || 1, 1.5);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);

    const dw = Math.max(1, Math.floor(w * pr));
    const dh = Math.max(1, Math.floor(h * pr));
    const rw = Math.max(1, Math.floor(dw * this.q.renderScale));
    const rh = Math.max(1, Math.floor(dh * this.q.renderScale));

    this.displaySize.width = dw;
    this.displaySize.height = dh;
    if (this.screenSize.width === rw && this.screenSize.height === rh && this.hdrRt) return;
    this.screenSize.width = rw;
    this.screenSize.height = rh;

    this.hdrRt?.dispose();
    this.hdrRt = hdrTarget(rw, rh, { depthBuffer: true, name: 'hdr' });
    this.viewRt?.dispose();
    this.viewRt = hdrTarget(rw, rh, {
      depthBuffer: true,
      samples: this._viewSamples,
      name: 'viewmodel',
    });
    this.pingRt[0]?.dispose();
    this.pingRt[1]?.dispose();
    this.pingRt[0] = hdrTarget(rw, rh, { name: 'ping0' });
    this.pingRt[1] = hdrTarget(rw, rh, { name: 'ping1' });
    this.ldrRt?.dispose();
    this.ldrRt = null;
    if (this.fxaa) this.ldrRt = new THREE.WebGLRenderTarget(rw, rh, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });

    this.gbuffer.setSize(rw, rh);
    this.gtao?.setSize(rw, rh);
    this.contact?.setSize(rw, rh);
    this.ssr?.setSize(rw, rh);
    this.taa?.setSize(rw, rh);
    this.motionBlur?.setSize(rw, rh);
    this.dof?.setSize(rw, rh);
    this.bloom?.setSize(rw, rh);

    this.patcher.setScreenSize(rw, rh);
    this.viewComposite.uniforms.uTexel.value.set(1 / rw, 1 / rh);
    this.composite.uniforms.uTexel.value.set(1 / rw, 1 / rh);
    this.composite.uniforms.uResolution.value.set(rw, rh);
    if (this.fxaa) this.fxaa.uniforms.uTexel.value.set(1 / rw, 1 / rh);

    this.depthTexture = this.gbuffer.depthTexture;
    this.velocityTexture = this.gbuffer.velocityTexture;
    this.normalTexture = this.gbuffer.normalTexture;

    for (const p of this.passes) p.resize?.(rw, rh);
    this.taa?.reset();
    this.exposure.reset();
  }

  _visit(o) {
    if (o.isMesh === true || o.isPoints === true || o.isSprite === true || o.isLine === true) {
      const mat = o.material;
      let transparent = false;
      if (Array.isArray(mat)) {
        for (let i = 0; i < mat.length; i++) {
          this.patcher.patch(mat[i]);
          if (mat[i] && mat[i].transparent === true) transparent = true;
        }
      } else if (mat) {
        this.patcher.patch(mat);
        transparent = mat.transparent === true;
      }

      if (o.isMesh !== true) transparent = true;
      if (o.userData.owProbe !== true) this._foreignMeshes++;

      const ud = o.userData;
      if (transparent || ud.owNoPrepass === true) {
        this._hide[this._nHide++] = o;
      } else {
        this._draw[this._nDraw++] = o;
        if (ud.owNoShadow === true) this._noShadow[this._nNoShadow++] = o;
      }
    } else if (o.isDirectionalLight === true) {
      this._dirLights[this._nDirLights++] = o;
    }
  }

  _collect(scene) {
    this._nDraw = 0;
    this._nHide = 0;
    this._nNoShadow = 0;
    this._nDirLights = 0;
    this._foreignMeshes = 0;
    scene.traverseVisible(this._visit);
  }

  _hideList(list, n) {
    for (let i = 0; i < n; i++) list[i].visible = false;
  }
  _showList(list, n) {
    for (let i = 0; i < n; i++) list[i].visible = true;
  }

  _dirFromLight(light, out) {
    light.updateWorldMatrix(true, false);
    out.setFromMatrixPosition(light.matrixWorld);
    if (light.target) {
      light.target.updateWorldMatrix(true, false);
      this._tmpV3b.setFromMatrixPosition(light.target.matrixWorld);
      out.sub(this._tmpV3b);
    }
    if (out.lengthSq() < 1e-8) out.set(0, 1, 0);
    return out.normalize();
  }

  _syncSun(camera) {
    let best = null;
    let bestI = -1;
    for (let i = 0; i < this._nDirLights; i++) {
      const l = this._dirLights[i];
      if (l === this.sun) continue;
      if (l.intensity > bestI) {
        best = l;
        bestI = l.intensity;
      }
    }

    if (best && bestI > 0.01) {
      if (this.sun.visible) this.sun.visible = false;
      if (best.castShadow) best.castShadow = false;
      this.activeSun = best;
    } else {
      this.sun.visible = true;
      this.activeSun = this.sun;
    }

    this._dirFromLight(this.activeSun, this.sunDir);
    this.sunDirView.copy(this.sunDir).transformDirection(camera.matrixWorldInverse).normalize();
  }

  _updateViewRig(viewCamera) {
    const s = this.settings;
    const ref = Math.max(this.activeSun.intensity, this._ambLevel / 0.15);
    const shaped = REF_DAYLIGHT * Math.pow(Math.min(ref / REF_DAYLIGHT, 1), s.viewKeyGamma);
    const keyI = Math.min(shaped * s.viewKeyScale, s.viewKeyMax);
    this.viewSun.color.copy(this.activeSun.color);
    this.viewSun.intensity = keyI;

    const h = this._fillHue;
    this.viewKeyFill.color.setRGB(h.x, h.y, h.z);
    this.viewKeyFill.intensity = keyI * s.viewFillRatio;
    const sc = this.activeSun.color;
    this.viewRim.color.setRGB(sc.r, sc.g * 0.94, sc.b * 0.82);
    this.viewRim.intensity = keyI * s.viewRimRatio;
    this.viewFill.intensity = keyI * s.viewHemiRatio;

    const g = this._fillHue2;
    if (Math.max(g.x, g.y, g.z) > 1e-5) {
      this.viewBounce.color.setRGB(g.x, g.y * 0.86, g.z * 0.62);
    }
    this.viewBounce.intensity = keyI * s.viewBounceRatio;

    this._placeViewLight(this.viewSun, this._viewKeyDir, viewCamera);
    this._placeViewLight(this.viewKeyFill, this._viewFillDir, viewCamera);
    this._placeViewLight(this.viewRim, this._viewRimDir, viewCamera);
    this._placeViewLight(this.viewBounce, this._viewBounceDir, viewCamera);
  }

  _placeViewLight(light, dirView, viewCamera) {
    const d = this._tmpV3c.copy(dirView).transformDirection(viewCamera.matrixWorld);
    light.target.position.setFromMatrixPosition(viewCamera.matrixWorld);
    light.position.copy(light.target.position).addScaledVector(d, 4);
    light.updateMatrixWorld(true);
    light.target.updateMatrixWorld(true);
  }

  _updateBounceFill() {
    const s = this.settings;
    const u = this.patcher.uniforms;
    const sunI = Math.max(0, this.activeSun.intensity);

    const sky = this.ctx.peek('sky');
    const amb = sky?.ambientColor;
    const hue = this._fillHue;
    if (amb && Math.max(amb.r, amb.g, amb.b) > 1e-5) {
      hue.set(amb.r, amb.g, amb.b);
      this._ambLevel = Math.max(hue.x, hue.y, hue.z);
    } else {
      hue.set(0.36, 0.56, 1.0);
      this._ambLevel = 0.15 * sunI;
    }
    hue.divideScalar(Math.max(hue.x, hue.y, hue.z));
    {
      const l = 0.2126 * hue.x + 0.7152 * hue.y + 0.0722 * hue.z;
      const k = 1.18;
      hue.set(
        Math.max(0, l + (hue.x - l) * k),
        Math.max(0, l + (hue.y - l) * k),
        Math.max(0, l + (hue.z - l) * k)
      );
      hue.divideScalar(Math.max(hue.x, hue.y, hue.z, 1e-6));
    }

    const skyRef = this._ambLevel / 0.15;
    const skyLevel = s.skyFill * skyRef;
    u.owSkyFill.value.set(hue.x * skyLevel, hue.y * skyLevel, hue.z * skyLevel);

    const sc = this.activeSun.color;
    const g = this._fillHue2.set(sc.r * 0.33, sc.g * 0.29, sc.b * 0.225);
    g.divideScalar(Math.max(g.x, g.y, g.z, 1e-6));
    const groundLevel = s.groundFill * sunI;
    u.owGroundFill.value.set(g.x * groundLevel, g.y * groundLevel, g.z * groundLevel);

    u.owFillGain.value.set(1, s.bounceFill / Math.max(s.groundFill, 1e-6));
    u.owIndirect.value.x = s.iblDiffuse * (sky?.indirectScale ?? 1);
    u.owIndirect.value.y = s.interiorIndirect;
    this._skyExposureBias = sky?.exposureBias ?? 0;
  }

  _updateRooms() {
    if (this._roomsReady) return;
    const world = this.ctx.peek('world');
    const list = world?.buildings;
    if (!list || !world.levelToWorld) return;
    this._roomsReady = true;

    const o = world.levelToWorld(0, 0, 0, this._tmpV3);
    const ox = o.x;
    const oz = o.z;
    const ex = world.levelToWorld(1, 0, 0, this._tmpV3b);
    const c = ex.x - ox;
    const sn = ex.z - oz;
    const inv = 1 / Math.max(1e-6, Math.hypot(c, sn));
    const cs = c * inv;
    const sni = sn * inv;
    this.patcher.uniforms.owRoomXf.value.set(
      cs,
      sni,
      -(ox * cs + oz * sni),
      -(-ox * sni + oz * cs)
    );

    const rooms = this.patcher.rooms;
    const roomsY = this.patcher.roomsY;
    let n = 0;
    for (const b of list) {
      const sp = b?.spec;
      if (!sp || sp.enterable !== true) continue;
      if (sp.collapse === true || sp.ruin === true) continue;
      if (n >= rooms.length) break;
      rooms[n].set(sp.x, sp.z, sp.w * 0.5, sp.d * 0.5);
      let top = (b.roofY ?? 12) - 0.06;
      const sb = sp.setback?.from;
      if (sb !== undefined && b.floorY?.[sb] !== undefined) top = b.floorY[sb] - 0.06;
      roomsY[n].set(-0.8, top, 0, 0);
      n++;
    }
    this.patcher.uniforms.owIndirect.value.z = n;
    if (n > 0) console.info(`[render] indirect gate: ${n} interior volumes`);
  }

  _ensureProbe(ctx) {
    const FOREIGN_LIMIT = 6;
    if (this.probeActive) {
      if (this._foreignMeshes >= FOREIGN_LIMIT) {
        ctx.scene.remove(this.probe.group);
        this.probe.dispose();
        this.probeActive = false;
        this.taa?.reset();
      }
      return;
    }
    if (this.frame > 4 || this._foreignMeshes >= FOREIGN_LIMIT) return;
    const g = this.probe.build();
    g.traverse((o) => {
      o.userData.owProbe = true;
    });
    ctx.scene.add(g);
    this.probeActive = true;
  }

  _cullLights(camPos) {
    const s = this.settings;
    for (let i = 0; i < this.lights.length; i++) {
      const e = this.lights[i];
      if (e.applied !== undefined && e.light.intensity !== e.applied) {
        e.baseIntensity = e.light.intensity;
      }
      const d = e.light.position.distanceTo(camPos);
      const fade = 1 - THREE.MathUtils.smoothstep(d, e.range * 0.75, e.range * 1.15);
      const gain = e.range <= PRACTICAL_RANGE ? s.practicalGain : 1;
      e.applied = e.baseIntensity * fade * gain;
      e.light.intensity = e.applied;
      e.light.visible = fade > 0.002;
    }
  }

  // ==========================================================================
  //  the frame
  // ==========================================================================

  render(ctx) {
    const renderer = this.renderer;
    const { scene, camera, viewScene, viewCamera } = ctx;
    const dt = Math.min(0.1, Math.max(1 / 480, ctx.time.dt || 1 / 60));
    this.frame++;
    renderer.info.reset();

    camera.updateMatrixWorld();
    viewCamera.updateMatrixWorld();

    this._collect(scene);
    this._ensureProbe(ctx);
    this._syncSun(camera);
    this._updateRooms();
    this._updateBounceFill();
    this._updateViewRig(viewCamera);
    this._camPos.setFromMatrixPosition(camera.matrixWorld);
    this._cullLights(this._camPos);
    this._adsT = this._readAds();

    if (ctx.scene.environment !== this.envMap) {
      this.envMap = ctx.scene.environment;
    }
    if (
      ctx.viewScene.environment !== ctx.scene.environment &&
      (ctx.viewScene.environment === null ||
        ctx.viewScene.environment === this._assignedViewEnv)
    ) {
      ctx.viewScene.environment = ctx.scene.environment;
      this._assignedViewEnv = ctx.scene.environment;
    }

    this._currVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._invVP.copy(this._currVP).invert();
    if (this._firstFrame) this._prevVP.copy(this._currVP);

    const bg = scene.background;
    if (this.csm.enabled) {
      this.csm.update(camera, this.sunDir, this.settings.sunSoftness);
      this.csm.setJitter(this.taa ? this.frame % 8 : 0);
      scene.background = null;
      this._hideList(this._hide, this._nHide);
      this._hideList(this._noShadow, this._nNoShadow);
      this.csm.render(renderer, scene, this._noCascadeCull ? null : this._draw, this._nDraw);
      this._showList(this._noShadow, this._nNoShadow);
      this._showList(this._hide, this._nHide);
      scene.background = bg;
    }

    if (this.taa) this._applyJitter(camera);

    const gb = this.gbuffer;
    if (this.needsPrepass) {
      scene.background = null;
      this._hideList(this._hide, this._nHide);
      gb.render(renderer, scene, camera, this._currVP, this._prevVP, true);
      this._showList(this._hide, this._nHide);
      scene.background = bg;
    }

    const feat = this.patcher.uniforms.owFeat.value;
    feat.set(0, 0, 0, 1);

    if (this.gtao && this.needsPrepass) {
      this.patcher.uniforms.owAoTex.value = this.gtao.render(
        renderer,
        gb,
        camera,
        this.frame,
        !!this.taa
      );
      this.aoTexture = this.patcher.uniforms.owAoTex.value;
      feat.x = 1;
    }
    if (this.contact && this.needsPrepass) {
      this.patcher.uniforms.owContactTex.value = this.contact.render(
        renderer,
        gb,
        camera,
        this.sunDirView,
        this.frame
      );
      feat.y = 1;
    }
    if (this.ssr && this.needsPrepass && !this._firstFrame) {
      const src = this.taa ? this.taa.previousTexture : this.hdrRt.texture;
      this.patcher.uniforms.owSsrTex.value = this.ssr.render(renderer, gb, src, camera, this.frame);
      feat.z = 1;
    }

    this.csm.uniforms.owSunDirView.value.copy(this.sunDirView);
    renderer.setRenderTarget(this.hdrRt);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);

    this._viewVisible = viewScene.children.length > this._viewRigChildren;
    if (this._viewVisible) {
      this._tmpV3.setFromMatrixPosition(viewCamera.matrixWorld);
      const coherent = this._tmpV3.distanceToSquared(this._camPos) < 0.25;
      const prevStrength = this.csm.uniforms.owCsmParams.value.x;
      const prevFeat = feat.y;
      if (!coherent) this.csm.uniforms.owCsmParams.value.x = 0;
      feat.y = 0;
      this.csm.uniforms.owSunDirView.value
        .copy(this.sunDir)
        .transformDirection(viewCamera.matrixWorldInverse)
        .normalize();

      const uSky = this.patcher.uniforms.owSkyFill.value;
      const uGnd = this.patcher.uniforms.owGroundFill.value;
      this._fillSkySave.copy(uSky);
      this._fillGroundSave.copy(uGnd);
      uSky.multiplyScalar(this.settings.viewFillOcclusion);
      uGnd.multiplyScalar(this.settings.viewFillOcclusion);
      const roomN = this.patcher.uniforms.owIndirect.value.z;
      this.patcher.uniforms.owIndirect.value.z = 0;

      this._collectViewScene(viewScene);

      renderer.setRenderTarget(this.viewRt);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, false);
      renderer.render(viewScene, viewCamera);
      renderer.setClearColor(0x000000, 1);

      this.csm.uniforms.owCsmParams.value.x = prevStrength;
      feat.y = prevFeat;
      uSky.copy(this._fillSkySave);
      uGnd.copy(this._fillGroundSave);
      this.patcher.uniforms.owIndirect.value.z = roomN;
    }

    if (this.taa) this._removeJitter(camera);

    let color = this.hdrRt.texture;
    if (this.taa) {
      color = this.taa.render(renderer, color, gb, this._invVP, this._prevVP);
    }

    if (this.motionBlur) {
      const shutter = this.settings.shutter * (1 / 60 / dt);
      color = this.motionBlur.render(renderer, color, gb, this.frame, shutter);
    }

    if (this.dof && this._adsT > 0.01 && this.needsPrepass) {
      const dofOut = this.pingRt[this._pingIndex];
      color = this.dof.render(
        renderer,
        color,
        gb,
        dofOut,
        this._adsT,
        this.settings,
        this.frame
      );
      this._pingIndex ^= 1;
    }

    for (let i = 0; i < this.passes.length; i++) {
      const p = this.passes[i];
      if (p.enabled === false) continue;
      const out = this.pingRt[this._pingIndex];
      p.render(renderer, color, out, this);
      color = out.texture;
      this._pingIndex ^= 1;
    }

    if (this._viewVisible) {
      const vu = this.viewComposite.uniforms;
      const out = this.pingRt[this._pingIndex];
      vu.tColor.value = color;
      vu.tView.value = this.viewRt.texture;
      this.viewComposite.render(renderer, out);
      color = out.texture;
      this._pingIndex ^= 1;
    }

    const s = this.settings;
    const exposureTex = this.exposure.update(
      renderer,
      color,
      this.screenSize.width,
      this.screenSize.height,
      s.autoExposure ? dt : 1e3,
      s.exposureBias + this._skyExposureBias,
      s.exposureKey,
      this.needsPrepass ? this.depthTexture : null
    );
    this.exposureTexture = exposureTex;

    let bloomTex = null;
    if (this.bloom) {
      bloomTex = this.bloom.render(
        renderer,
        color,
        this.screenSize.width,
        this.screenSize.height,
        exposureTex
      );
    }

    const cu = this.composite.uniforms;
    cu.tColor.value = color;
    cu.tBloom.value = bloomTex ?? color;
    cu.tExposure.value = exposureTex;
    cu.uGrade.value.x = bloomTex ? s.bloomStrength : 0;
    cu.uGrade.value.z = this.taa ? s.sharpen : 0;
    cu.uLens.value.y = s.vignette + (s.adsVignette - s.vignette) * this._adsT;
    cu.uLens.value.w = ctx.time.elapsed;
    cu.uLook.value.w = this.ctx.config.exposure ?? 1;

    if (this.debugView) {
      this._renderDebug(renderer, color);
    } else if (this.fxaa) {
      this.composite.render(renderer, this.ldrRt);
      this.fxaa.uniforms.tColor.value = this.ldrRt.texture;
      this.fxaa.render(renderer, null);
    } else {
      this.composite.render(renderer, null);
    }

    gb.beginRecord();
    gb.recordMatrices(this._draw, this._nDraw);
    gb.endRecord();
    this._prevVP.copy(this._currVP);
    this._firstFrame = false;
    renderer.setRenderTarget(null);

    if (this._probeExposure) this._logExposure();
  }

  _visitView(o) {
    if (o.isMesh === true) {
      const m = o.material;
      if (Array.isArray(m)) for (let i = 0; i < m.length; i++) this.patcher.patch(m[i]);
      else if (m) this.patcher.patch(m);
    }
  }

  _renderDebug(renderer, color) {
    if (!this._debugPass) this._debugPass = createDebug();
    const u = this._debugPass.uniforms;
    const gb = this.gbuffer;
    const map = {
      ao: [this.aoTexture, 0],
      normal: [gb.normalTexture, 1],
      velocity: [gb.velocityTexture, 2],
      depth: [gb.depthTexture, 3],
      ssr: [this.ssr?.texture, 4],
      ssrmask: [this.ssr?.texture, 5],
      contact: [this.contact?.texture, 0],
      bloom: [this.bloom?.texture, 4],
      view: [this.viewRt?.texture, 4],
      viewalpha: [this.viewRt?.texture, 5],
      color: [color, 4],
    };
    const entry = map[this.debugView] ?? map.color;
    u.tSrc.value = entry[0] ?? color;
    u.uMode.value = entry[1];
    this._debugPass.render(renderer, null);
  }

  debugExposure() {
    const buf = this._readback;
    this.renderer.readRenderTargetPixels(this.exposure.rt1, 0, 0, 1, 1, buf);
    const avgLog = buf[0] / Math.max(buf[1], 1e-4);
    const out = this._readback2;
    this.renderer.readRenderTargetPixels(
      this.exposure.adapt[this.exposure._flip],
      0,
      0,
      1,
      1,
      out
    );
    return { avgLum: Math.pow(2, avgLog), ev100: out[1], exposure: out[0] };
  }

  _logExposure() {
    if (this.frame % 90 !== 0) return;
    const d = this.debugExposure();
    const u = this.patcher.uniforms;
    const v3 = (x) => `${x.x.toFixed(3)},${x.y.toFixed(3)},${x.z.toFixed(3)}`;
    console.info(
      `[render] frame ${this.frame} avgLum ${d.avgLum.toFixed(4)} ev100 ${d.ev100.toFixed(2)} exposure ${d.exposure.toFixed(4)} ` +
        `sun=${this.activeSun.intensity.toFixed(3)} skyFill=${v3(u.owSkyFill.value)} gndFill=${v3(u.owGroundFill.value)} ` +
        `ibl=${u.owIndirect.value.x.toFixed(3)} indoor=${u.owIndirect.value.y.toFixed(3)} rooms=${u.owIndirect.value.z}`
    );
  }

  _collectViewScene(viewScene) {
    viewScene.traverseVisible(this._visitView);
  }

  _applyJitter(camera) {
    const j = this.taa.nextJitter();
    const jx = (j.x * 2) / this.screenSize.width;
    const jy = (j.y * 2) / this.screenSize.height;
    this._jitterSaved.set(camera.projectionMatrix.elements[8], camera.projectionMatrix.elements[9]);
    camera.projectionMatrix.elements[8] += jx;
    camera.projectionMatrix.elements[9] += jy;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    this._jittered = true;
  }

  _removeJitter(camera) {
    if (!this._jittered) return;
    camera.projectionMatrix.elements[8] = this._jitterSaved.x;
    camera.projectionMatrix.elements[9] = this._jitterSaved.y;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    this._jittered = false;
  }

  _readAds() {
    if (!this._weapons) this._weapons = this.ctx.peek('weapons') || null;
    const w = this._weapons;
    if (!w) return 0;
    const t = w.adsProgress;
    return typeof t === 'number' && t === t ? Math.min(1, Math.max(0, t)) : 0;
  }

  dispose() {
    this.csm.dispose();
    this.gbuffer.dispose();
    this.gtao?.dispose();
    this.contact?.dispose();
    this.ssr?.dispose();
    this.taa?.dispose();
    this.motionBlur?.dispose();
    this.dof?.dispose();
    this.bloom?.dispose();
    this.exposure.dispose();
    this.composite.dispose();
    this.viewComposite.dispose();
    this.fxaa?.dispose();
    this.lut.texture.dispose();
    this.envEquirect?.dispose();
    this.hdrRt?.dispose();
    this.viewRt?.dispose();
    this.ldrRt?.dispose();
    this.pingRt[0]?.dispose();
    this.pingRt[1]?.dispose();
    this.envTarget?.dispose();
    if (this.probeActive) {
      this.ctx?.scene.remove(this.probe.group);
      this.probe.dispose();
    }
    this._debugPass?.dispose();
    this.patcher.dispose();
    this.renderer.dispose();
  }
}
