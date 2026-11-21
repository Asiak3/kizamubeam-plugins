// Comprehensive Node test suite for plugins/house-composer.
// Tests manifest integrity, pure roof/opening/wall geometry, 3D pose & joint alignment,
// interactive 6-view surface editing, dialog actions/onChange, and full plugin:check sweep.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const pluginDir = resolve(new URL('..', import.meta.url).pathname);
const manifest = JSON.parse(readFileSync(resolve(pluginDir, 'plugin.json'), 'utf8'));
const spec = manifest.plugins[0];
const bundleCode = readFileSync(resolve(pluginDir, 'dist/plugin.js'), 'utf8');

/** Signed area of a closed polygon (> 0 = CW in y-down screen coords, < 0 = CCW) */
function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i],
      q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Exact port of KizamuBeam's checkGeom thin-web / web-cut detector (minWeb=1, beam=0.15, tol=0.05) */
function checkWebsOnPart(subs, { minWeb = 1, beam = 0.15, tol = 0.05, kerf = 0 } = {}) {
  const findings = [];
  const reach = minWeb + beam + 0.1;
  const contours = subs.map((sp, sub) => {
    const pts = [...sp.nodes, sp.nodes[0]];
    const cum = [0];
    for (let i = 0; i < sp.nodes.length; i++) {
      cum.push(cum[i] + Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y));
    }
    return { sub, pts, cum, len: cum[cum.length - 1], area: signedArea(sp.nodes) };
  });
  // Nesting depth: outer contour = 0 (material inside), holes = 1 (material outside)
  const pip = (pt, poly) => {
    let inside = false;
    for (let i = 0, j = poly.length - 2; i < poly.length - 1; j = i++) {
      const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
      if ((yi > pt.y) !== (yj > pt.y) && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const depth = contours.map((c, ci) => contours.filter((o, oi) => oi !== ci && pip(c.pts[0], o.pts)).length);
  const acc = new Map();

  contours.forEach((c, ci) => {
    const materialInside = depth[ci] % 2 === 0;
    // In y-down coords, signedArea > 0 means CW -> inward normal is (-dy, dx)
    const sign = (c.area > 0 ? 1 : -1) * (materialInside ? 1 : -1);
    const n = Math.max(1, Math.round(c.len / 0.2));
    const st = c.len / n;
    const hits = [];
    let segIdx = 0;
    for (let k = 0; k < n; k++) {
      const at = (k + 0.5) * st;
      while (segIdx + 2 < c.cum.length && c.cum[segIdx + 1] < at) segIdx++;
      const p0 = c.pts[segIdx], p1 = c.pts[segIdx + 1];
      const l = c.cum[segIdx + 1] - c.cum[segIdx] || 1e-12;
      const f = (at - c.cum[segIdx]) / l;
      const pa = { x: p0.x + (p1.x - p0.x) * f, y: p0.y + (p1.y - p0.y) * f };
      const dx = (p1.x - p0.x) / l, dy = (p1.y - p0.y) / l;
      const nx = -dy * sign, ny = dx * sign;
      let best = null;
      for (const o of contours) {
        for (let j = 0; j < o.pts.length - 1; j++) {
          const a = o.pts[j], b = o.pts[j + 1];
          const bx = b.x - a.x, by = b.y - a.y;
          const den = nx * by - ny * bx;
          if (Math.abs(den) < 1e-12) continue;
          const wx = a.x - pa.x, wy = a.y - pa.y;
          const u = (wx * by - wy * bx) / den;
          const v = (wx * ny - wy * nx) / den;
          if (v < 0 || v > 1 || u <= tol || u > reach) continue;
          if (!best || u < best.d) best = { d: u, oi: o.sub };
        }
      }
      if (!best) hits.push(null);
      else {
        const w = best.d - beam + 2 * kerf;
        hits.push(w < minWeb ? { ...best, w } : null);
      }
    }
    // Group contiguous hit runs >= 0.4 mm
    let i = 0;
    while (i < hits.length) {
      if (!hits[i]) { i++; continue; }
      let j = i;
      while (j + 1 < hits.length && hits[j + 1]) j++;
      if ((j - i + 1) * st >= 0.4 && j > i) {
        const mid = hits[Math.floor((i + j) / 2)];
        const [x, y] = [c.sub, mid.oi].sort((a, b) => a - b);
        const key = `${x}:${y}`;
        let minW = acc.get(key) ?? Infinity;
        for (let k = i; k <= j; k++) minW = Math.min(minW, hits[k].w);
        acc.set(key, minW);
      }
      i = j + 1;
    }
  });
  for (const [k, w] of acc.entries()) {
    findings.push({ level: w <= 0 ? 'error' : 'warn', code: w <= 0 ? 'check-web-cut' : 'check-web', values: { w }, pair: k });
  }
  return findings;
}

/** Faithful mock of KizamuBeam's host functions (including real finger-joint profiles, gable/shed cap union & checkGeom) */
function createMockHost({ material = null, workArea = { width: 400, height: 300 } } = {}) {
  const jointCalls = [];
  const host = {
    context(what) {
      if (what === 'material') return material;
      if (what === 'workArea') return workArea;
      return null;
    },
    joints(input) {
      jointCalls.push(input);
      if (input.op === 'panel') {
        const w = input.width / 2,
          h = input.height / 2;
        return {
          v: input.v ?? 1,
          outline: { closed: true, nodes: [{ x: -w, y: -h }, { x: w, y: -h }, { x: w, y: h }, { x: -w, y: h }] },
        };
      }
      if (input.op === 'edge') {
        const out = {};
        for (const [k, subs] of Object.entries(input.parts)) {
          out[k] = subs.map((sp) => ({ closed: sp.closed, nodes: sp.nodes.map((n) => ({ ...n })) }));
        }
        for (const e of input.edges) {
          const subs = out[e.part];
          assert.ok(subs, `Missing part ${e.part}`);
          const sp = subs[e.sub ?? 0];
          assert.ok(sp, `Missing sub ${e.sub ?? 0} on ${e.part}`);
          const n = sp.nodes.length;
          assert.ok(e.seg >= 0 && e.seg < (sp.closed ? n : n - 1), `Invalid seg ${e.seg} on ${e.part}`);
          const a = sp.nodes[e.seg];
          const b = sp.nodes[(e.seg + 1) % n];
          const len = Math.hypot(b.x - a.x, b.y - a.y);
          assert.ok(len > 1e-5, `Degenerate segment on ${e.part} seg=${e.seg}`);
        }
        // Generate real outward finger profiles so corner fingers & web checks match KizamuBeam!
        if (input.options.kind === 'finger' && input.options.direction === 'out' && input.edges.length === 2) {
          const th = input.options.thickness ?? 3;
          const fw = input.options.fingerWidth ?? 10;
          input.edges.forEach((e, idx) => {
            const sp = out[e.part][e.sub ?? 0];
            const ns = sp.nodes;
            const n = ns.length;
            const a = ns[e.seg], b = ns[(e.seg + 1) % n];
            const len = Math.hypot(b.x - a.x, b.y - a.y);
            const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
            // Outward normal: for CW polygon (area > 0 in y-down), outward is (uy, -ux)
            const sgn = signedArea(ns) > 0 ? 1 : -1;
            const ox = uy * sgn, oy = -ux * sgn;
            let count = Math.round(len / Math.max(0.1, fw));
            if (count % 2 === 0) count += len / fw >= count ? 1 : -1;
            count = Math.max(3, count);
            const w = len / count;
            const phase = idx === 0 ? 0 : 1;
            const mat = (i) => (i + phase) % 2 === 0;
            const pt = (u, v) => ({ x: a.x + ux * u + ox * v, y: a.y + uy * u + oy * v });
            const extra = [];
            if (mat(0)) extra.push(pt(0, th));
            for (let i = 1; i < count; i++) {
              const u = i * w;
              extra.push(pt(u, mat(i - 1) ? th : 0), pt(u, mat(i) ? th : 0));
            }
            if (mat(count - 1)) extra.push(pt(len, th));
            sp.nodes = [...ns.slice(0, e.seg + 1), ...extra, ...ns.slice(e.seg + 1)];
          });
        }
        if (input.options.kind === 'tenon' && input.edges.length === 2) {
          const gKey = input.edges[1].part;
          const gSub = out[gKey][0];
          if (!gSub.closed && gSub.nodes.length === 2) {
            const [a, b] = gSub.nodes;
            const dx = b.x - a.x,
              dy = b.y - a.y;
            const L = Math.hypot(dx, dy);
            const ux = dx / L,
              uy = dy / L;
            const nx = -uy,
              ny = ux;
            const tw = (input.options.tenonWidth ?? 10) + (input.options.clearance ?? 0);
            const ht = ((input.options.thickness ?? 3) + (input.options.clearance ?? 0)) / 2;
            const mx = (a.x + b.x) / 2,
              my = (a.y + b.y) / 2;
            const hl = tw / 2;
            out[gKey] = [
              {
                closed: true,
                nodes: [
                  { x: mx - ux * hl - nx * ht, y: my - uy * hl - ny * ht },
                  { x: mx + ux * hl - nx * ht, y: my + uy * hl - ny * ht },
                  { x: mx + ux * hl + nx * ht, y: my + uy * hl + ny * ht },
                  { x: mx - ux * hl + nx * ht, y: my - uy * hl + ny * ht },
                ],
              },
            ];
          }
        }
        return { v: input.v ?? 1, parts: out, added: [], info: [] };
      }
      throw new Error('host-bad-input');
    },
    boolean({ op, a, b }) {
      if (op === 'difference') {
        // Keep interior hole cutouts as holes; boundary-crossing edge notches (extending past outer bbox) merge into perimeter in real Clipper
        const aNodes = a[0]?.nodes ?? [];
        let ax0 = Infinity, ax1 = -Infinity, ay0 = Infinity, ay1 = -Infinity;
        for (const n of aNodes) (ax0 = Math.min(ax0, n.x)), (ax1 = Math.max(ax1, n.x)), (ay0 = Math.min(ay0, n.y)), (ay1 = Math.max(ay1, n.y));
        const interior = (b ?? []).filter((sp) => {
          const xs = sp.nodes.map((n) => n.x), ys = sp.nodes.map((n) => n.y);
          return Math.min(...xs) > ax0 + 0.01 && Math.max(...xs) < ax1 - 0.01 && Math.min(...ys) > ay0 + 0.01 && Math.max(...ys) < ay1 - 0.01;
        });
        return [...a, ...interior];
      }
      if (op === 'union' && a.length === 1 && b && b.length === 1) {
        // Handle gable / shed cap union cleanly on top of the finger-jointed wall base!
        const base = a[0].nodes;
        const cap = b[0].nodes;
        const capMinY = Math.min(...cap.map((n) => n.y));
        const baseMinY = Math.min(...base.map((n) => n.y));
        if (capMinY < baseMinY - 0.5) {
          // Cap polygons always start with (minX, yL+ov), then trace the upper roof silhouette left→right, ending at (maxX, yR+ov)
          const minX = Math.min(...cap.map((n) => n.x));
          const maxX = Math.max(...cap.map((n) => n.x));
          const i0 = cap.findIndex((n, idx) => idx > 0 && Math.abs(n.x - minX) < 1e-4);
          const i1 = cap.findIndex((n, idx) => idx > i0 && Math.abs(n.x - maxX) < 1e-4);
          const topCap = i0 >= 0 && i1 > i0 ? cap.slice(i0, i1 + 1) : cap.slice(1, 4);
          const startIdx = base.findIndex((n) => Math.abs(n.x - maxX) < 1e-3 && n.y > topCap[topCap.length - 1].y + 0.1);
          const endIdx = base.length - 1 - [...base].reverse().findIndex((n) => Math.abs(n.x - minX) < 1e-3 && n.y > topCap[0].y + 0.1);
          if (startIdx >= 0 && endIdx >= startIdx) {
            return [{ closed: true, nodes: [...topCap, ...base.slice(startIdx, endIdx + 1)] }];
          }
        }
        return [...a];
      }
      return [...a];
    },
    offset({ subs }) {
      return subs.map((sp) => ({ closed: sp.closed, nodes: sp.nodes.map((n) => ({ ...n })) }));
    },
    nest({ parts, gap }) {
      let x = 0;
      return parts.map((p) => {
        let minX = Infinity,
          maxX = -Infinity;
        for (const s of p.subs) for (const n of s.nodes) (minX = Math.min(minX, n.x)), (maxX = Math.max(maxX, n.x));
        const w = Number.isFinite(minX) ? maxX - minX : 20;
        const pos = [x + w / 2, 0];
        x += w + gap;
        return pos;
      });
    },
    check({ parts, kerf = 0 }) {
      const out = [];
      for (const p of parts) {
        for (const f of checkWebsOnPart(p.subs, { kerf })) {
          out.push({ ...f, parts: [p.key] });
        }
      }
      return out;
    },
    progress() {},
  };
  return { host, jointCalls };
}

function loadPlugin(opts = {}) {
  const { host, jointCalls } = createMockHost(opts);
  const sandbox = { globalThis: {}, host, console, Math, JSON, Number, String, Boolean, Array, Object, Map, Set, RegExp, Error, Infinity, NaN, isFinite, parseInt, parseFloat };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(bundleCode, sandbox);
  return { plugin: sandbox.plugin, jointCalls };
}

function defaultParams() {
  const p = {};
  for (const field of spec.params) p[field.key] = field.def;
  return p;
}

const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const applyPose = (pose, x, y, s = 0) => [
  pose.o[0] + x * pose.u[0] + y * pose.v[0] + s * pose.n[0],
  pose.o[1] + x * pose.u[1] + y * pose.v[1] + s * pose.n[1],
  pose.o[2] + x * pose.u[2] + y * pose.v[2] + s * pose.n[2],
];

test('manifest structure, limits, and EN/DE text coverage', () => {
  assert.equal(manifest.format, 'kizamubeam-pack');
  assert.equal(manifest.formatVersion, 2);
  assert.equal(spec.type, 'generator');
  assert.equal(spec.kind, 'assembly');
  assert.equal(spec.dialog.version, 6);
  assert.ok(spec.dialog.steps.length >= 2 && spec.dialog.steps.length <= 8);
  assert.ok(spec.dialog.surface.views.length <= 6);
  assert.ok(spec.dialog.lists.length <= 4);
  assert.ok(spec.dialog.actions.length <= 8);
  assert.ok(spec.dialog.surface.help.length <= 12);
  for (const list of spec.dialog.lists) {
    assert.ok(list.columns.length <= 8);
    assert.ok((list.rowActions?.length ?? 0) <= 4);
  }

  // Every text key in EN must exist in DE and vice versa
  const enKeys = new Set(Object.keys(spec.texts.en));
  const deKeys = new Set(Object.keys(spec.texts.de));
  for (const k of enKeys) assert.ok(deKeys.has(k), `Missing DE text key: ${k}`);
  for (const k of deKeys) assert.ok(enKeys.has(k), `Missing EN text key: ${k}`);

  // Every param, enum option, step, view, help, action, list column has EN text
  for (const param of spec.params) {
    assert.ok(enKeys.has(param.key), `Missing EN label for param: ${param.key}`);
    if (param.type === 'enum') {
      for (const opt of param.options) {
        const key = Array.isArray(opt) ? opt[1] : `${param.key}.${opt}`;
        assert.ok(enKeys.has(key), `Missing EN option text: ${key}`);
      }
    }
  }
  for (const st of spec.dialog.steps) assert.ok(enKeys.has(st.label), `Missing step text: ${st.label}`);
  for (const v of spec.dialog.surface.views) assert.ok(enKeys.has(v.label), `Missing view text: ${v.label}`);
  for (const h of spec.dialog.surface.help) assert.ok(enKeys.has(h), `Missing help text: ${h}`);
  for (const a of spec.dialog.actions) assert.ok(enKeys.has(a.label), `Missing action text: ${a.label}`);
});

test('default parameters generate deterministically without errors', () => {
  const { plugin } = loadPlugin();
  const p = defaultParams();
  const issues = plugin.validate(p);
  const errs = issues.filter((i) => i.level === 'error');
  assert.equal(errs.length, 0, `Unexpected errors: ${JSON.stringify(issues)}`);
  const res1 = plugin.generate(p);
  const res2 = plugin.generate(p);
  assert.equal(JSON.stringify(res1), JSON.stringify(res2), 'Output must be deterministic');
  const keys = res1.parts.map((pt) => pt.key);
  assert.deepEqual(new Set(keys), new Set(['floor', 'front', 'back', 'left', 'right', 'roof-front', 'roof-back']));
  // Every generated part must have a 3D pose and valid EN/DE part name
  for (const pt of res1.parts) {
    assert.ok(res1.poses.poses[pt.key], `Missing 3D pose for ${pt.key}`);
    assert.ok(spec.texts.en[`part.${pt.key}`], `Missing EN part label for ${pt.key}`);
    assert.ok(spec.texts.de[`part.${pt.key}`], `Missing DE part label for ${pt.key}`);
  }
  // Engraved frames should appear as marks on all 4 outer walls
  for (const wk of ['front', 'back', 'left', 'right']) {
    const part = res1.parts.find((x) => x.key === wk);
    assert.ok(part.marks && part.marks.length > 0, `Expected engraved frame marks on ${wk}`);
  }
});

test('plugin:check sweep — every enum option and every bool switch succeeds cleanly', () => {
  const { plugin } = loadPlugin({ material: { name: 'Birch 3mm', thickness: 3, kerf: 0.1, pairPlay: 0, pairPlayTotal: 0, slotPlay: 0 } });
  const base = defaultParams();

  for (const param of spec.params) {
    if (param.type === 'enum') {
      for (const opt of param.options) {
        const val = Array.isArray(opt) ? opt[0] : opt;
        const p = { ...base, [param.key]: val };
        const issues = plugin.validate(p);
        assert.equal(issues.filter((i) => i.level === 'error').length, 0, `Error for ${param.key}=${val}: ${JSON.stringify(issues)}`);
        const res = plugin.generate(p);
        assert.ok(res.parts.length >= 4, `Too few parts for ${param.key}=${val}`);
      }
    } else if (param.type === 'bool') {
      for (const val of [true, false]) {
        const p = { ...base, [param.key]: val };
        const issues = plugin.validate(p);
        assert.equal(issues.filter((i) => i.level === 'error').length, 0, `Error for ${param.key}=${val}: ${JSON.stringify(issues)}`);
        const res = plugin.generate(p);
        assert.ok(res.parts.length >= 1, `No parts for ${param.key}=${val}`);
      }
    }
  }
});

test('all 5 roof types × options × flush/overhanging × removable generate valid 3D geometry', () => {
  const { plugin } = loadPlugin();
  const base = defaultParams();
  const cases = [
    { roofType: 'gable', ridgeAxis: 'x', roofMount: 'fixed', roofGableOverhang: 6 },
    { roofType: 'gable', ridgeAxis: 'x', roofMount: 'fixed', roofGableOverhang: 0 },
    { roofType: 'gable', ridgeAxis: 'y', roofMount: 'fixed', roofGableOverhang: 6 },
    { roofType: 'gable', ridgeAxis: 'y', roofMount: 'fixed', roofGableOverhang: 0 },
    { roofType: 'gable', ridgeAxis: 'x', roofMount: 'removable', roofGableOverhang: 6 },
    { roofType: 'gable', ridgeAxis: 'y', roofMount: 'removable', roofGableOverhang: 0 },
    { roofType: 'gable', roofSizeMode: 'height', roofHeight: 45 },
    { roofType: 'shed', shedDir: 'front', roofMount: 'fixed', roofGableOverhang: 6 },
    { roofType: 'shed', shedDir: 'back', roofMount: 'fixed', roofGableOverhang: 0 },
    { roofType: 'shed', shedDir: 'left', roofMount: 'fixed', roofGableOverhang: 6 },
    { roofType: 'shed', shedDir: 'right', roofMount: 'removable', roofGableOverhang: 4 },
    { roofType: 'flat', roofMount: 'fixed', roofOverhang: 0 },
    { roofType: 'flat', roofMount: 'fixed', roofOverhang: 8 },
    { roofType: 'flat', roofMount: 'removable', roofOverhang: 10 },
    { roofType: 'hip', width: 140, depth: 90, roofOverhang: 8 },
    { roofType: 'hip', width: 90, depth: 140, roofOverhang: 8 },
    { roofType: 'hip', width: 100, depth: 100, roofOverhang: 6 },
    { roofType: 'pyramid', width: 100, depth: 100, roofOverhang: 8 },
    { roofType: 'pyramid', width: 140, depth: 90, roofOverhang: 8 },
  ];

  for (const c of cases) {
    const p = { ...base, ...c, roofPattern: 'tiles' };
    // Avoid default openings overflowing when resizing narrow cases
    if (c.width || c.depth) p.openings = '[]';
    const errs = plugin.validate(p).filter((i) => i.level === 'error');
    assert.equal(errs.length, 0, `Case ${JSON.stringify(c)} failed validate: ${JSON.stringify(errs)}`);
    const res = plugin.generate(p);

    // Verify outer-face-up orientation (-(u×v) ≈ +n) for EVERY roof panel!
    for (const part of res.parts) {
      if (!part.key.startsWith('roof') || part.key.startsWith('roof-truss')) continue;
      const pose = res.poses.poses[part.key];
      assert.ok(pose, `Missing pose for ${part.key}`);
      const c3 = cross3(pose.u, pose.v);
      const outN = [-c3[0], -c3[1], -c3[2]];
      const align = dot3(outN, pose.n);
      assert.ok(align > 0.9999, `Roof panel ${part.key} in ${JSON.stringify(c)} not outer-face-up! dot=${align}`);
      // Tile pattern should produce engraving marks on every roof panel
      assert.ok(part.marks && part.marks.length > 0, `Expected roof tile marks on ${part.key}`);
    }

    // For hip & pyramid: verify all 4 eaves outer corners meet seamlessly in 3D space!
    if (c.roofType === 'hip' || c.roofType === 'pyramid') {
      const rf = res.parts.find((x) => x.key === 'roof-front');
      const rl = res.parts.find((x) => x.key === 'roof-left');
      const pf = res.poses.poses['roof-front'];
      const pl = res.poses.poses['roof-left'];
      // Front-left eaves corner: bottom-left of roof-front vs bottom-right of roof-left
      const fNodes = rf.subs[0].nodes;
      const lNodes = rl.subs[0].nodes;
      const fBotLeft = fNodes.reduce((best, n) => (n.y > best.y - 1e-4 && n.x < best.x ? n : best), { x: Infinity, y: -Infinity });
      const lBotRight = lNodes.reduce((best, n) => (n.y > best.y - 1e-4 && n.x > best.x ? n : best), { x: -Infinity, y: -Infinity });
      const p3F = applyPose(pf, fBotLeft.x, fBotLeft.y, 0);
      const p3L = applyPose(pl, lBotRight.x, lBotRight.y, 0);
      const dist = Math.hypot(p3F[0] - p3L[0], p3F[1] - p3L[1], p3F[2] - p3L[2]);
      assert.ok(dist < 1e-4, `Hip/pyramid eaves corner mismatch for ${JSON.stringify(c)}: dist=${dist}`);
    }
  }
});

test('all 6 opening styles, gable attic window, interior doorway, and floor=false', () => {
  const { plugin } = loadPlugin();
  const base = defaultParams();
  // Add an interior room divider wall + openings of every single style + gable round window + inner door!
  const p = {
    ...base,
    width: 140,
    depth: 100,
    height: 75,
    roofType: 'gable',
    ridgeAxis: 'x',
    roofAngle: 40,
    walls: JSON.stringify([{ id: 1, axis: 'v', pos: 67, from: 0, to: 94 }]),
    wallsRef: JSON.stringify([134, 94]),
    openings: JSON.stringify([
      { id: 1, wall: 'front', kind: 'door', style: 'arch', x: 35, y: 0, w: 22, h: 42 },
      { id: 2, wall: 'front', kind: 'window', style: 'grid', x: 105, y: 20, w: 24, h: 24 },
      { id: 3, wall: 'back', kind: 'door', style: 'double', x: 35, y: 0, w: 28, h: 42 },
      { id: 4, wall: 'back', kind: 'window', style: 'double', x: 105, y: 20, w: 22, h: 20 },
      { id: 5, wall: 'left', kind: 'window', style: 'round', x: 50, y: 76, w: 16, h: 16 }, // inside gable triangle!
      { id: 6, wall: 'right', kind: 'window', style: 'arch', x: 50, y: 20, w: 18, h: 24 },
      { id: 7, wall: 'wall-1', kind: 'door', style: 'rect', x: 47, y: 0, w: 20, h: 42 }, // interior doorway!
    ]),
  };
  const errs = plugin.validate(p).filter((i) => i.level === 'error');
  assert.equal(errs.length, 0, `Unexpected errors: ${JSON.stringify(errs)}`);
  const res = plugin.generate(p);
  assert.ok(res.parts.some((pt) => pt.key === 'wall-1'));
  // Also test floor=false (open-bottom doorways)
  const pNoFloor = { ...p, floor: false };
  const errsNoFloor = plugin.validate(pNoFloor).filter((i) => i.level === 'error');
  assert.equal(errsNoFloor.length, 0, `Unexpected errors with floor=false: ${JSON.stringify(errsNoFloor)}`);
  const resNoFloor = plugin.generate(pNoFloor);
  assert.ok(!resNoFloor.parts.some((pt) => pt.key === 'floor'));
});

test('validation catches invalid roof and opening configurations', () => {
  const { plugin } = loadPlugin();
  const base = defaultParams();

  // Opening colliding with interior wall T-joint at X = 60 (pos = 57 -> exterior X = 60)
  const hitWall = {
    ...base,
    walls: JSON.stringify([{ id: 1, axis: 'v', pos: 57, from: 0, to: 84 }]),
    wallsRef: JSON.stringify([114, 84]),
  };
  assert.ok(
    plugin.validate(hitWall).some((i) => i.code === 'opening-hits-wall'),
    'Expected opening-hits-wall when interior wall meets front door',
  );

  // Overlapping openings
  const overlap = {
    ...base,
    openings: JSON.stringify([
      { id: 1, wall: 'front', kind: 'window', style: 'rect', x: 50, y: 20, w: 20, h: 20 },
      { id: 2, wall: 'front', kind: 'window', style: 'rect', x: 60, y: 20, w: 20, h: 20 },
    ]),
  };
  assert.ok(plugin.validate(overlap).some((i) => i.code === 'openings-overlap'));

  // Gable window extending above flat roof when switched to flat
  const aboveRoof = {
    ...base,
    roofType: 'flat',
    openings: JSON.stringify([{ id: 1, wall: 'left', kind: 'window', style: 'round', x: 45, y: 72, w: 16, h: 16 }]),
  };
  assert.ok(plugin.validate(aboveRoof).some((i) => i.code === 'opening-outside'));

  // Thin-web overhang on fixed gable roof (0 < gableOverhang < thickness)
  const thinGableOh = { ...base, roofType: 'gable', roofMount: 'fixed', roofGableOverhang: 1.5 };
  assert.ok(plugin.validate(thinGableOh).some((i) => i.code === 'roof-gable-overhang-web'));

  // Thin-web overhang on fixed flat roof
  const thinFlatOh = { ...base, roofType: 'flat', roofMount: 'fixed', roofOverhang: 1.5 };
  assert.ok(plugin.validate(thinFlatOh).some((i) => i.code === 'roof-overhang-web'));
});

test('interactive surface: all 6 views draw, elevation edits, actions, and onChange work', () => {
  const { plugin } = loadPlugin();
  let p = defaultParams();

  // Draw all 6 views
  for (const v of spec.dialog.surface.views) {
    const drawing = plugin.draw({ view: v.id, state: null, selected: { openings: 0, walls: -1 }, have: [], params: p });
    assert.ok(drawing.frame && Array.isArray(drawing.items), `Failed drawing view ${v.id}`);
    assert.ok(drawing.items.length > 0, `Empty items on view ${v.id}`);
  }

  // Test double-click to add a window on 'left' elevation view (start with empty openings)
  p = { ...p, openings: '[]' };
  const added = plugin.onSurface({
    event: { type: 'dblclick', x: 45, y: 50 },
    surface: { view: 'left', state: null, selected: { openings: -1, walls: -1 } },
    params: p,
  });
  assert.ok(added?.patch?.openings, 'Double-click on elevation should add an opening');
  const opsAfter = JSON.parse(added.patch.openings);
  assert.equal(opsAfter.length, 1);
  assert.equal(opsAfter[0].wall, 'left');
  p = { ...p, ...added.patch };

  // Test field edit on selected opening
  const edited = plugin.onSurface({
    event: { type: 'field', x: 0, y: 0, field: 'ow', value: 24 },
    surface: { view: 'left', state: { selId: opsAfter[0].id }, selected: { openings: 0, walls: -1 } },
    params: p,
  });
  assert.equal(JSON.parse(edited.patch.openings)[0].w, 24);

  // Test actions: addDoor, addWindow, presetClassic, nextWall, centerOpening
  const addDoorRes = plugin.onEvent({ action: 'addDoor', params: defaultParams(), inputs: {}, surface: { view: 'back', state: null, selected: {} } });
  assert.ok(addDoorRes?.patch?.openings, 'addDoor should patch openings');

  const presetRes = plugin.onEvent({ action: 'presetClassic', params: { ...defaultParams(), width: 160, depth: 110, height: 85 }, inputs: {} });
  assert.ok(JSON.parse(presetRes.patch.openings).length >= 5);

  const nextWallRes = plugin.onEvent({ action: 'nextWall', params: defaultParams(), inputs: {}, row: 0 });
  assert.equal(JSON.parse(nextWallRes.patch.openings)[0].wall, 'right');

  // Test onChange: switching roofSizeMode syncs height from angle
  const syncMode = plugin.onChange({ key: 'roofSizeMode', old: 'angle', params: { ...defaultParams(), roofSizeMode: 'height' } });
  assert.ok(syncMode?.patch?.roofHeight > 25 && syncMode?.patch?.roofHeight < 40);

  // Test view() row labels
  const vw = plugin.view(defaultParams());
  assert.equal(vw.rows.openings.length, 7);
});

test('shaped L-footprint works cleanly with flat roof and rejects pitched roof', () => {
  const { plugin } = loadPlugin();
  const base = defaultParams();
  // L-shaped outer contour (6 edges, notch cut at top-right corner)
  const t = 3,
    w = 114,
    d = 84;
  const lWalls = [
    { id: 1, axis: 'h', pos: -t / 2, from: -t / 2, to: w / 2 },
    { id: 2, axis: 'v', pos: w / 2, from: -t / 2, to: d / 2 },
    { id: 3, axis: 'h', pos: d / 2, from: w / 2, to: w + t / 2 },
    { id: 4, axis: 'v', pos: w + t / 2, from: d / 2, to: d + t / 2 },
    { id: 5, axis: 'h', pos: d + t / 2, from: -t / 2, to: w + t / 2 },
    { id: 6, axis: 'v', pos: -t / 2, from: -t / 2, to: d + t / 2 },
  ];
  const pFlat = {
    ...base,
    roofType: 'flat',
    roofOverhang: 6,
    walls: JSON.stringify(lWalls),
    wallsRef: JSON.stringify([w, d]),
    openings: '[]',
  };
  const flatErrs = plugin.validate(pFlat).filter((i) => i.level === 'error');
  assert.equal(flatErrs.length, 0, `Shaped flat house failed: ${JSON.stringify(flatErrs)}`);
  const res = plugin.generate(pFlat);
  assert.ok(res.parts.some((pt) => pt.key === 'roof'));
  assert.ok(res.parts.some((pt) => pt.key === 'floor'));

  // Same L-shape with gable roof should produce roof-needs-rect error
  const pGable = { ...pFlat, roofType: 'gable' };
  assert.ok(plugin.validate(pGable).some((i) => i.code === 'roof-needs-rect'));
});

test('3D alignment: every roof tenon edge lines up with its roof slot guide in 3D space', () => {
  const base = defaultParams();
  const cases = [
    { roofType: 'gable', ridgeAxis: 'x', roofMount: 'fixed', roofGableOverhang: 6 },
    { roofType: 'gable', ridgeAxis: 'y', roofMount: 'fixed', roofGableOverhang: 6 },
    { roofType: 'gable', ridgeAxis: 'x', roofMount: 'removable', roofGableOverhang: 6 },
    { roofType: 'gable', ridgeAxis: 'y', roofMount: 'removable', roofGableOverhang: 6 },
    { roofType: 'shed', shedDir: 'front', roofMount: 'fixed', roofGableOverhang: 6 },
    { roofType: 'shed', shedDir: 'back', roofMount: 'fixed', roofGableOverhang: 6 },
    { roofType: 'shed', shedDir: 'left', roofMount: 'fixed', roofGableOverhang: 6 },
    { roofType: 'shed', shedDir: 'right', roofMount: 'fixed', roofGableOverhang: 6 },
    { roofType: 'flat', roofMount: 'fixed', roofOverhang: 8 },
  ];

  for (const c of cases) {
    const { plugin, jointCalls } = loadPlugin();
    const p = { ...base, ...c, openings: '[]' };
    const res = plugin.generate(p);
    const poses = res.poses.poses;
    const t = p.thickness;
    const W = p.width,
      D = p.depth;

    // Inspect every tenon call where the second part is a roof guide line (_guide)
    const roofTenons = jointCalls.filter(
      (jc) =>
        jc.op === 'edge' &&
        jc.options?.kind === 'tenon' &&
        jc.edges.length === 2 &&
        jc.edges[1].part === '_guide',
    );
    assert.ok(roofTenons.length > 0, `Expected roof tenon joints for ${JSON.stringify(c)}`);

    // For each tenon call, verify the 3D midpoint of the source edge (shifted to centered coords)
    // matches the 3D midpoint of the guide line on one of the roof panels!
    const roofKeys = Object.keys(poses).filter((k) => k.startsWith('roof') && !k.startsWith('roof-truss'));
    for (const jc of roofTenons) {
      const srcKey = jc.edges[0].part;
      const srcPose = poses[srcKey];
      assert.ok(srcPose, `Missing pose for ${srcKey}`);
      const sp = jc.parts[srcKey][0];
      const seg = jc.edges[0].seg;
      const a = sp.nodes[seg];
      const b = sp.nodes[(seg + 1) % sp.nodes.length];
      // Uncentered midpoint of source edge; recover the centering offset from the bounding box of sp vs final centered part
      const rawMidX = (a.x + b.x) / 2;
      const rawMidY = (a.y + b.y) / 2;

      // For outer walls: uncentered X ∈ [0..L], Y ∈ [0..topZ]; centered by (-L/2, -topZ/2).
      // For trusses: uncentered X ∈ [0..innerSpan], Y ∈ [0..rise]; centered by (-innerSpan/2, -rise/2).
      const finalPart = res.parts.find((x) => x.key === srcKey);
      let minX = Infinity,
        maxX = -Infinity,
        minY = Infinity,
        maxY = -Infinity;
      for (const n of sp.nodes) (minX = Math.min(minX, n.x)), (maxX = Math.max(maxX, n.x)), (minY = Math.min(minY, n.y)), (maxY = Math.max(maxY, n.y));
      // Compute centering offset: walls center X at L/2 and Y at topZ/2; trusses center at (innerSpan/2, rise/2)
      let cx, cy;
      if (srcKey === 'front' || srcKey === 'back') {
        cx = W / 2;
        cy = srcPose.o[2];
      } else if (srcKey === 'left' || srcKey === 'right') {
        cx = D / 2;
        cy = srcPose.o[2];
      } else {
        // truss
        cx = (maxX + minX) / 2;
        cy = (maxY + minY) / 2;
      }
      // Account for turnOver mirroring on back & right
      const isTurned = srcKey === 'back' || srcKey === 'right';
      const localX = isTurned ? -(rawMidX - cx) : rawMidX - cx;
      const localY = rawMidY - cy;
      // Wall/truss mid-thickness sits at s = t/2 along srcPose.n
      const p3Src = applyPose(srcPose, localX, localY, t / 2);

      const gNodes = jc.parts._guide[0].nodes;
      const gMidX = (gNodes[0].x + gNodes[1].x) / 2;
      const gMidY = (gNodes[0].y + gNodes[1].y) / 2;

      // Find minimum distance to any roof panel's underside point at (gMidX, gMidY, s=0)
      let bestDist = Infinity;
      for (const rk of roofKeys) {
        const p3Roof = applyPose(poses[rk], gMidX, gMidY, 0);
        const dist = Math.hypot(p3Src[0] - p3Roof[0], p3Src[1] - p3Roof[1], p3Src[2] - p3Roof[2]);
        bestDist = Math.min(bestDist, dist);
      }
      assert.ok(
        bestDist < 1e-3,
        `3D tenon/slot mismatch for ${JSON.stringify(c)} src=${srcKey}: dist=${bestDist.toFixed(4)} mm (src3D=${p3Src.map((v) => v.toFixed(2))}, guide=(${gMidX.toFixed(2)},${gMidY.toFixed(2)}))`,
      );
      void finalPart;
    }
  }
});

