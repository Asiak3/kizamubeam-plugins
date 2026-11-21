// Parts of the house composer: floor, outer walls (rectangular with any roof type, or shaped with flat roof),
// interior room walls, roof panels, attic trusses, door/window cutouts & engraved marks, kerf and 3D poses.
// Every wood joint comes from the app via host.joints (v: 2).
import { host, polygon, type JointOptions, type Pose, type SubPath, type V3 } from '../../../sdk/ts';
import { fields, joint, panel, tenonStretches, tenonsInto, widen, JointError, type Parts, type Pt } from './joints';
import type { End, Model, OEdgeInfo, Side, WallInfo } from './model';
import type { Pt as XY } from './outline';
import { buildWallHosts, openingCutouts, openingMarks, type Opening, type WallHost } from './openings';
import {
  buildRoofPanels,
  buildRoofTrusses,
  computeRoofMetrics,
  roofPatternMarks,
  wallProfile,
  type OuterWallKey,
  type RoofPanelGeom,
  type RoofSpec,
  type TrussSpec,
} from './roof';

export interface HouseDims {
  W: number;
  D: number;
  H: number;
  t: number;
  finger: number;
  /** Total play of a joint (both sides together) */
  clearance: number;
  kerf: number;
  floor: boolean;
  sides: Record<Side, boolean>;
  drop: number;
  roof: RoofSpec;
  engraveFrames: boolean;
  frameWidth: number;
  mullionWidth: number;
}

export interface JointMsg {
  code: string;
  values?: Record<string, number | string>;
}

export interface WallPanel {
  key: string;
  it: WallInfo;
  s: number;
  e: number;
  h: number;
  fromTop: boolean;
  part: string;
  ox: number;
  oy: number;
}

export interface Board {
  key: string;
  axis: 'h' | 'v';
  pos: number;
  edges: OEdgeInfo[];
  members: WallPanel[];
  bs: number;
  be: number;
  h: number;
}

export interface BuiltHouse {
  parts: Parts;
  marks: Record<string, SubPath[]>;
  info: JointMsg[];
  walls: WallPanel[];
  boards: Board[];
  roofPanels: RoofPanelGeom[];
  trusses: TrussSpec[];
  /** Uncentered panel height (maxZ - floorZ or maxZ) for each outer wall, used by 3D poses */
  outerHeights: Partial<Record<OuterWallKey, { topZ: number; botZ: number }>>;
  hosts: Map<string, WallHost>;
}

export const OUTER: Record<Side, OuterWallKey> = { x0: 'left', x1: 'right', y0: 'back', y1: 'front' };
export const wallKey = (id: number) => `wall-${id}`;
export const outerKey = (k: number) => `outer-${k + 1}`;

const EPS = 1e-6;
export const anyOuter = (d: HouseDims) => d.sides.x0 || d.sides.x1 || d.sides.y0 || d.sides.y1;

/** Clear height of interior walls */
export function innerHeight(d: HouseDims): number {
  const m = computeRoofMetrics(d.W, d.D, d.H, d.t, d.roof);
  const floorZ = d.floor ? d.t : 0;
  const lidT = m.flushFlat && anyOuter(d) ? d.t : 0;
  return anyOuter(d) ? d.H - floorZ - lidT - d.drop : d.H - floorZ;
}

/** Height of shaped-outline outer boards (flat roof only) */
export function outerBoardHeight(d: HouseDims): number {
  const m = computeRoofMetrics(d.W, d.D, d.H, d.t, d.roof);
  const floorZ = d.floor ? d.t : 0;
  const lidT = m.flushFlat ? d.t : 0;
  return d.H - floorZ - lidT;
}

const lapHalf = (d: HouseDims) => Math.max(1.5 * d.t, d.t + Math.max(0, d.clearance) + 0.5);

function endAt(end: End, at: number, dir: -1 | 1, d: HouseDims): number {
  if (end.kind === 'outer') return d.sides[end.side] ? at : at + dir * d.t;
  if (end.kind === 'free' || end.kind === 'edge' || end.kind === 'open' || end.kind === 'board') return at;
  if (end.kind === 'step' && end.at !== undefined) return end.at;
  return at - (dir * d.t) / 2;
}

export function wallPanels(m: Model, d: HouseDims): WallPanel[] {
  const h = innerHeight(d);
  return m.walls.map((it) => ({
    key: wallKey(it.wall.id),
    it,
    s: endAt(it.start, it.wall.from, -1, d),
    e: endAt(it.end, it.wall.to, 1, d),
    h,
    fromTop: it.wall.axis === 'h',
    part: wallKey(it.wall.id),
    ox: 0,
    oy: 0,
  }));
}

/** Stretches of the bottom edge of an inner wall with one tooth in the middle of each (when floor is enabled) */
export function floorSpans(p: WallPanel, d: HouseDims): { a: number; b: number; width: number }[] {
  if (!d.floor) return [];
  const { t, finger } = d;
  const cuts = p.fromTop ? [] : p.it.crosses.map((c) => c.at).sort((x, y) => x - y);
  const lh = lapHalf(d);
  const spans: { a: number; b: number }[] = [];
  let a = p.s;
  for (const c of cuts) {
    spans.push({ a, b: c - lh });
    a = c + lh;
  }
  spans.push({ a, b: p.e });
  const out: { a: number; b: number; width: number }[] = [];
  const endSpan = finger + t;
  spans.forEach((sp, i) => {
    const freeStart = i === 0 && p.it.start.kind === 'free',
      freeEnd = i === spans.length - 1 && p.it.end.kind === 'free';
    const len = sp.b - sp.a;
    const nFree = (freeStart ? 1 : 0) + (freeEnd ? 1 : 0);
    if (!nFree) return out.push(...tenonStretches(sp.a, sp.b, finger));
    if (len < nFree * endSpan + finger) return out.push({ a: sp.a, b: sp.b, width: Math.min(finger, len - t) });
    let sa = sp.a,
      sb = sp.b;
    if (freeStart) {
      out.push({ a: sa, b: sa + endSpan, width: finger });
      sa += endSpan;
    }
    const tail = freeEnd ? { a: sb - endSpan, b: sb, width: finger } : null;
    if (freeEnd) sb -= endSpan;
    out.push(...tenonStretches(sa, sb, finger));
    if (tail) out.push(tail);
  });
  return out.filter((sp) => sp.b - sp.a > EPS);
}

type OuterTenon = (end: End, p: WallPanel) => { into: string; at: (y: number) => Pt } | null;

function wallSplits(p: WallPanel, d: HouseDims, tenoned: (e: End) => boolean) {
  const lh = lapHalf(d);
  const laps = p.it.crosses.flatMap((c) => [c.at - lh - p.s, c.at + lh - p.s]);
  const top = p.fromTop ? laps : [];
  const bottom = [...(p.fromTop ? [] : laps), ...floorSpans(p, d).flatMap((sp) => [sp.a - p.s, sp.b - p.s])];
  const ends = tenonStretches(0, p.h, d.finger).flatMap((sp) => [sp.a, sp.b]);
  return { top, bottom, left: tenoned(p.it.start) ? ends : [], right: tenoned(p.it.end) ? ends : [] };
}

function innerJoints(parts: Parts, walls: WallPanel[], d: HouseDims, info: JointMsg[], outerTenon: OuterTenon): Parts {
  const { W, D, t, finger } = d;
  const byId = new Map(walls.map((p) => [p.it.wall.id, p]));
  const lh = lapHalf(d);
  const P = (p: WallPanel, x: number, y: number): Pt => ({ x: x + p.ox, y: y + p.oy });
  const opts = (o: JointOptions): JointOptions => ({ thickness: t, clearance: d.clearance, ...o });
  const keep = (r: { parts: Parts; info: JointMsg[] }) => {
    parts = r.parts;
    info.push(...r.info);
  };

  for (const p of walls) {
    if (!p.fromTop) continue;
    for (const c of p.it.crosses) {
      const q = byId.get(c.wall)!;
      const at = q.it.crosses.find((x) => x.wall === p.it.wall.id)!.at;
      const x1 = c.at - p.s,
        x2 = at - q.s;
      keep(
        joint(parts, { kind: 'lap', thickness: t, clearance: d.clearance, lapCount: 1, lapDepth: 50 }, [
          { part: p.part, a: P(p, x1 - lh, 0), b: P(p, x1 + lh, 0) },
          { part: q.part, a: P(q, x2 + lh, q.h), b: P(q, x2 - lh, q.h) },
        ]),
      );
    }
  }

  for (const p of walls) {
    for (const which of ['start', 'end'] as const) {
      const end = p.it[which];
      const x = which === 'start' ? 0 : p.e - p.s;
      const edge = { part: p.part, a: P(p, x, 0), b: P(p, x, p.h) };
      const tenons = (into: string, at: (y: number) => Pt) => {
        for (const sp of tenonStretches(0, p.h, finger))
          parts = tenonsInto(parts, opts({ kind: 'tenon', tenonCount: 1, tenonWidth: sp.width }), { part: p.part, a: P(p, x, sp.a), b: P(p, x, sp.b) }, into, at(sp.a), at(sp.b));
      };
      if (end.kind === 'corner') {
        const q = byId.get(end.other)!;
        if (q.it.wall.id < p.it.wall.id) continue;
        const qWhich = q.it.start.kind === 'corner' && q.it.start.other === p.it.wall.id ? 'start' : 'end';
        const qx = qWhich === 'start' ? 0 : q.e - q.s;
        keep(joint(parts, opts({ kind: 'finger', fingerWidth: finger, direction: 'out' }), [edge, { part: q.part, a: P(q, qx, 0), b: P(q, qx, q.h) }]));
      } else if (end.kind === 'tee') {
        const hWall = byId.get(end.host)!;
        const at = hWall.it.tees.find((x) => x.wall === p.it.wall.id)!.at - hWall.s;
        tenons(hWall.part, (y) => P(hWall, at, y));
      } else {
        const o = outerTenon(end, p);
        if (o) tenons(o.into, o.at);
      }
    }
  }

  if (d.floor && parts.floor) {
    for (const p of walls) {
      const w = p.it.wall;
      for (const sp of floorSpans(p, d)) {
        const map = (along: number) =>
          w.axis === 'h' ? { x: along + t - W / 2, y: w.pos + t - D / 2 } : { x: w.pos + t - W / 2, y: along + t - D / 2 };
        parts = tenonsInto(
          parts,
          opts({ kind: 'tenon', tenonCount: 1, tenonWidth: sp.width }),
          { part: p.part, a: P(p, sp.b - p.s, p.h), b: P(p, sp.a - p.s, p.h) },
          'floor',
          map(sp.a),
          map(sp.b),
        );
      }
    }
  }
  return parts;
}

/** Tenon stretches along a sloped or horizontal roof edge between u0 and u1 (returns empty if too short) */
function roofTenonSpans(u0: number, u1: number, t: number, finger: number): { a: number; b: number; width: number }[] {
  const len = u1 - u0;
  if (len < 2.2 * t) return [];
  if (len < Math.max(3 * t, 1.5 * finger)) {
    const w = Math.min(finger, len * 0.45);
    return w >= Math.max(1.5, t * 0.6) ? [{ a: u0, b: u1, width: w }] : [];
  }
  return tenonStretches(u0, u1, finger);
}

/**
 * Put tenons on an edge of `srcKey` and cut matching slots (or flush edge notches when flushSide is set) into `dstKey`.
 * `flushSide`: when the slot lies flush with the left (-1) or right (+1) edge of `dstKey` (gableOverhang === 0),
 * expand the notch outward past that edge and subtract via boolean difference so no thin sliver remains.
 */
function roofTenonInto(
  parts: Parts,
  opts: JointOptions,
  srcEdge: { part: string; a: Pt; b: Pt },
  dstKey: string,
  from: Pt,
  to: Pt,
  flushSide: -1 | 0 | 1,
): Parts {
  if (flushSide === 0) {
    return tenonsInto(parts, opts, srcEdge, dstKey, from, to);
  }
  const GUIDE = '_rguide';
  const r = joint({ ...parts, [GUIDE]: [{ closed: false, nodes: [from, to] }] }, { ...opts, kind: 'tenon' }, [
    srcEdge,
    { part: GUIDE, a: from, b: to },
  ]);
  const slots = r.parts[GUIDE] ?? [];
  const out = { ...r.parts };
  delete out[GUIDE];
  if (slots.length) {
    // Expand each slot rectangle outward past the flush edge by 1 mm so boolean difference cleanly opens the edge
    const notches = slots.map((sp): SubPath => {
      let x0 = Infinity,
        x1 = -Infinity,
        y0 = Infinity,
        y1 = -Infinity;
      for (const n of sp.nodes) {
        x0 = Math.min(x0, n.x);
        x1 = Math.max(x1, n.x);
        y0 = Math.min(y0, n.y);
        y1 = Math.max(y1, n.y);
      }
      if (flushSide < 0) x0 -= 1;
      else x1 += 1;
      return polygon([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
    });
    out[dstKey] = host.boolean({ op: 'difference', a: parts[dstKey], b: notches });
  }
  return out;
}

/** Linearly interpolate point along segment A → B at distance s from A */
function alongSeg(a: Pt, b: Pt, s: number): Pt {
  const L = Math.hypot(b.x - a.x, b.y - a.y);
  const f = L > EPS ? s / L : 0;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

/** Push point onto node array if distinct from last */
function pushNode(nodes: Pt[], x: number, y: number) {
  const last = nodes[nodes.length - 1];
  if (!last || Math.abs(last.x - x) > 1e-7 || Math.abs(last.y - y) > 1e-7) nodes.push({ x, y });
}

/** Build WallHost map for the current house model (used by validateOpenings and surface elevation views) */
export function houseWallHosts(m: Model, d: HouseDims): Map<string, WallHost> {
  const walls = wallPanels(m, d);
  const innerList = walls.map((p) => {
    const startOuter = p.it.start.kind === 'outer' ? p.it.start.side : undefined;
    const endOuter = p.it.end.kind === 'outer' ? p.it.end.side : undefined;
    const joints = [...p.it.tees.map((x) => x.at), ...p.it.crosses.map((x) => x.at)];
    return {
      id: p.it.wall.id,
      axis: p.it.wall.axis,
      pos: p.it.wall.pos,
      s: p.s,
      e: p.e,
      h: p.h,
      startOuter,
      endOuter,
      joints,
    };
  });
  return buildWallHosts(d.W, d.D, d.H, d.t, d.floor, d.sides, d.roof, innerList);
}

/**
 * Build all house parts (without kerf; call withKerf afterwards), marks (engravings), wall/roof metadata and hosts.
 */
export function buildHouseParts(m: Model, d: HouseDims, openings: Opening[]): BuiltHouse {
  if (m.outline) return shapedHouseParts(m, d, openings);

  const { W, D, H, t, finger, sides, roof } = d;
  const info: JointMsg[] = [];
  const marks: Record<string, SubPath[]> = {};
  const floorZ = d.floor ? t : 0;
  const rm = computeRoofMetrics(W, D, H, t, roof);
  const opts = (o: JointOptions): JointOptions => ({ thickness: t, clearance: d.clearance, ...o });
  const keep = (r: { parts: Parts; info: JointMsg[] }) => {
    parts = r.parts;
    info.push(...r.info);
  };

  let parts: Parts = {};

  // 1. Floor plate (inner rectangle between closed walls, reaching outer edge on open sides)
  if (d.floor) {
    const fx0 = sides.x0 ? -W / 2 + t : -W / 2;
    const fx1 = sides.x1 ? W / 2 - t : W / 2;
    const fy0 = sides.y0 ? -D / 2 + t : -D / 2;
    const fy1 = sides.y1 ? D / 2 - t : D / 2;
    parts.floor = [polygon([[fx0, fy0], [fx1, fy0], [fx1, fy1], [fx0, fy1]])];
  }

  // 2. Roof panels (centered in their own 2D planes, outer face UP)
  const roofPanels = buildRoofPanels(W, D, H, t, roof);
  for (const rp of roofPanels) {
    parts[rp.key] = [polygon(rp.pts)];
    if (rp.marks.length) marks[rp.key] = [...rp.marks];
  }

  // If flush flat roof, rebuild roof outline as inner rectangle (like floor) for perimeter finger joints
  if (rm.flushFlat && anyOuter(d)) {
    const rx0 = sides.x0 ? -W / 2 + t : -W / 2;
    const rx1 = sides.x1 ? W / 2 - t : W / 2;
    const ry0 = sides.y0 ? -D / 2 + t : -D / 2;
    const ry1 = sides.y1 ? D / 2 - t : D / 2;
    parts.roof = [polygon([[rx0, ry0], [rx1, ry0], [rx1, ry1], [rx0, ry1]])];
  }

  // 3. Prepare the 4 outer walls with exact profiles and top tenon split points
  type WallSetup = {
    key: OuterWallKey;
    L: number;
    topZ: number;
    botZ: number;
    xL: number;
    xR: number;
    yCornerL: number;
    yCornerR: number;
    yBot: number;
    kind: 'flat' | 'gable' | 'shed-slope' | 'shed-high';
    /** Sloped roof tenon attachments: edge segment endpoints in uncentered wall coords + roof mapping */
    slopeJoints: {
      a: Pt;
      b: Pt;
      roofKey: string;
      xRoof: number;
      yRoofAt: (s: number) => number;
      flushSide: -1 | 0 | 1;
      spans: { a: number; b: number; width: number }[];
    }[];
    /** Flat overhanging roof tenon attachments along top edge (flat roof fixed with overhang >= t) */
    flatRoofSpans: { a: number; b: number; width: number }[];
  };

  const setups = new Map<OuterWallKey, WallSetup>();
  const outerHeights: Partial<Record<OuterWallKey, { topZ: number; botZ: number }>> = {};

  const wallEnabled: Record<OuterWallKey, boolean> = {
    front: sides.y1,
    back: sides.y0,
    left: sides.x0,
    right: sides.x1,
  };
  // Adjacent walls in UNMIRRORED panel coordinates (x=0 on left, x=L on right):
  //   front & back: x=0 is x0 (left), x=W is x1 (right)
  //   left & right: x=0 is y0 (back), x=D is y1 (front)
  const panelAdj: Record<OuterWallKey, { left: Side; right: Side }> = {
    front: { left: 'x0', right: 'x1' },
    back: { left: 'x0', right: 'x1' },
    left: { left: 'y0', right: 'y1' },
    right: { left: 'y0', right: 'y1' },
  };

  const rpByKey = new Map(roofPanels.map((rp) => [rp.key, rp]));

  for (const key of ['front', 'back', 'left', 'right'] as OuterWallKey[]) {
    if (!wallEnabled[key]) continue;
    const prof = wallProfile(key, W, D, H, t, roof);
    const L = prof.width;
    const flipX = key === 'back' || key === 'right';
    const zAtPanel = (xp: number) => prof.zAt(flipX ? L - xp : xp);
    const topZ = rm.flushFlat ? H - t : prof.maxZ;
    const botZ = floorZ;
    const adjL = sides[panelAdj[key].left];
    const adjR = sides[panelAdj[key].right];
    const xL = adjL ? t : 0;
    const xR = adjR ? L - t : L;

    // Corner top Z at x=0 and x=L (for shed-slope, corner meets the adjacent flat wall at its topZ!)
    const opp: Record<OuterWallKey, OuterWallKey> = { front: 'back', back: 'front', left: 'right', right: 'left' };
    const adjWallZ = (side: Side) => {
      const k = OUTER[side];
      const p = wallProfile(k, W, D, H, t, roof);
      return rm.flushFlat ? H - t : p.maxZ;
    };
    const cornerZL = adjL ? Math.min(zAtPanel(xL), adjWallZ(panelAdj[key].left)) : zAtPanel(0);
    const cornerZR = adjR ? Math.min(zAtPanel(xR), adjWallZ(panelAdj[key].right)) : zAtPanel(L);

    const yOfZ = (z: number) => topZ - z;
    const yCornerL = yOfZ(cornerZL);
    const yCornerR = yOfZ(cornerZR);
    const yBot = yOfZ(botZ);

    const slopeJoints: WallSetup['slopeJoints'] = [];
    let flatRoofSpans: { a: number; b: number; width: number }[] = [];

    // Flat roof overhanging tenons (fixed mount, overhang >= t)
    if (roof.type === 'flat' && roof.mount === 'fixed' && roof.overhang >= t - EPS) {
      flatRoofSpans = roofTenonSpans(xL, xR, t, finger);
    }

    // Gable roof sloped tenons on gable walls (fixed mount)
    if (roof.type === 'gable' && roof.mount === 'fixed' && prof.kind === 'gable') {
      const ca = Math.cos(rm.pitchRad);
      const tanA = Math.tan(rm.pitchRad);
      const Ls = L / 2 / ca;
      const sRidge = Math.max(t, t * tanA) + t;
      const sEaves = Math.max(t, t / ca) + t;
      const spans = roofTenonSpans(sRidge, Ls - sEaves, t, finger);
      const flush: -1 | 0 | 1 = roof.gableOverhang < EPS ? 1 : 0; // sign determined per roof panel below
      const peak: Pt = { x: L / 2, y: 0 };
      const pL: Pt = { x: 0, y: yOfZ(H) };
      const pR: Pt = { x: L, y: yOfZ(H) };

      if (roof.ridgeAxis === 'x') {
        // key is 'left' (X = t/2) or 'right' (X = W - t/2).
        // Unmirrored panel x=0 is Back (Y=D), x=D is Front (Y=0).
        // So segment pL→peak is BACK slope (roof-back), segment peak→pR is FRONT slope (roof-front)!
        const rpF = rpByKey.get('roof-front')!;
        const rpB = rpByKey.get('roof-back')!;
        const xF = key === 'left' ? -W / 2 + t / 2 : W / 2 - t / 2;
        const xB = key === 'left' ? W / 2 - t / 2 : -W / 2 + t / 2; // roof-back has u = -X
        const fSideF: -1 | 0 | 1 = flush ? (key === 'left' ? -1 : 1) : 0;
        const fSideB: -1 | 0 | 1 = flush ? (key === 'left' ? 1 : -1) : 0;
        // Back slope: from peak toward pL (u = 0 at peak, u = Ls at pL)
        if (spans.length) {
          slopeJoints.push({
            a: peak,
            b: pL,
            roofKey: 'roof-back',
            xRoof: xB,
            yRoofAt: (u) => -rpB.height / 2 + u,
            flushSide: fSideB,
            spans,
          });
          // Front slope: from peak toward pR (u = 0 at peak, u = Ls at pR)
          slopeJoints.push({
            a: peak,
            b: pR,
            roofKey: 'roof-front',
            xRoof: xF,
            yRoofAt: (u) => -rpF.height / 2 + u,
            flushSide: fSideF,
            spans,
          });
        }
      } else {
        // ridgeAxis === 'y': key is 'front' (Y = t/2) or 'back' (Y = D - t/2).
        // Unmirrored panel x=0 is Left (X=0), x=W is Right (X=W).
        // Segment peak→pL is LEFT slope (roof-left), segment peak→pR is RIGHT slope (roof-right).
        const rpL = rpByKey.get('roof-left')!;
        const rpR = rpByKey.get('roof-right')!;
        // roof-left has u = -Y (back at -D/2, front at +D/2)
        const xL_r = key === 'front' ? D / 2 - t / 2 : -D / 2 + t / 2;
        // roof-right has u = +Y (front at -D/2, back at +D/2)
        const xR_r = key === 'front' ? -D / 2 + t / 2 : D / 2 - t / 2;
        const fSideL: -1 | 0 | 1 = flush ? (key === 'front' ? 1 : -1) : 0;
        const fSideR: -1 | 0 | 1 = flush ? (key === 'front' ? -1 : 1) : 0;
        if (spans.length) {
          slopeJoints.push({
            a: peak,
            b: pL,
            roofKey: 'roof-left',
            xRoof: xL_r,
            yRoofAt: (u) => -rpL.height / 2 + u,
            flushSide: fSideL,
            spans,
          });
          slopeJoints.push({
            a: peak,
            b: pR,
            roofKey: 'roof-right',
            xRoof: xR_r,
            yRoofAt: (u) => -rpR.height / 2 + u,
            flushSide: fSideR,
            spans,
          });
        }
      }
    }

    // Shed roof sloped tenons on the two trapezoidal side walls (fixed mount)
    if (roof.type === 'shed' && roof.mount === 'fixed' && prof.kind === 'shed-slope') {
      const ca = Math.cos(rm.pitchRad);
      const Ls = L / ca;
      const pad = Math.max(t, t / ca) + t;
      const spans = roofTenonSpans(pad, Ls - pad, t, finger);
      const rp = rpByKey.get('roof')!;
      const flush = roof.gableOverhang < EPS;
      const z0 = zAtPanel(0),
        zL = zAtPanel(L);
      const highAtLeft = z0 > zL;
      const pHigh: Pt = highAtLeft ? { x: 0, y: 0 } : { x: L, y: 0 };
      const pLow: Pt = highAtLeft ? { x: L, y: yOfZ(H) } : { x: 0, y: yOfZ(H) };

      // Map wall center onto roof local x (remember roof.u depends on shedDir)
      let xRoof = 0;
      let fSide: -1 | 0 | 1 = 0;
      if (roof.shedDir === 'front') {
        // u = +X: left wall at -W/2 + t/2, right wall at +W/2 - t/2
        xRoof = key === 'left' ? -W / 2 + t / 2 : W / 2 - t / 2;
        fSide = flush ? (key === 'left' ? -1 : 1) : 0;
      } else if (roof.shedDir === 'back') {
        // u = -X: left wall at +W/2 - t/2, right wall at -W/2 + t/2
        xRoof = key === 'left' ? W / 2 - t / 2 : -W / 2 + t / 2;
        fSide = flush ? (key === 'left' ? 1 : -1) : 0;
      } else if (roof.shedDir === 'left') {
        // u = -Y: back wall at -D/2 + t/2, front wall at +D/2 - t/2
        xRoof = key === 'back' ? -D / 2 + t / 2 : D / 2 - t / 2;
        fSide = flush ? (key === 'back' ? -1 : 1) : 0;
      } else {
        // shedDir === 'right', u = +Y: front wall at -D/2 + t/2, back wall at +D/2 - t/2
        xRoof = key === 'front' ? -D / 2 + t / 2 : D / 2 - t / 2;
        fSide = flush ? (key === 'front' ? -1 : 1) : 0;
      }

      if (spans.length) {
        // u = 0 at high edge (yRoof = -Ls/2), u = Ls at low edge (yRoof = +Ls/2)
        slopeJoints.push({
          a: pHigh,
          b: pLow,
          roofKey: 'roof',
          xRoof,
          yRoofAt: (u) => -Ls / 2 + u,
          flushSide: fSide,
          spans,
        });
      }
      void opp;
    }

    // Build clockwise outer wall polygon in uncentered coords [0..L] × [0..yBot]
    const nodes: Pt[] = [];
    if (prof.kind === 'gable') {
      const peak: Pt = { x: L / 2, y: 0 };
      const pL: Pt = { x: 0, y: yOfZ(H) };
      const pR: Pt = { x: L, y: yOfZ(H) };
      // Back/left slope: pL → peak (reverse of peak→pL)
      pushNode(nodes, pL.x, pL.y);
      const jL = slopeJoints.find((j) => Math.abs(j.b.x - pL.x) < EPS);
      if (jL) {
        const Ls = Math.hypot(pL.x - peak.x, pL.y - peak.y);
        const pts = [...new Set(jL.spans.flatMap((sp) => [Ls - sp.b, Ls - sp.a]))].sort((u, v) => u - v);
        for (const s of pts) {
          const q = alongSeg(pL, peak, s);
          pushNode(nodes, q.x, q.y);
        }
      }
      pushNode(nodes, peak.x, peak.y);
      // Front/right slope: peak → pR
      const jR = slopeJoints.find((j) => Math.abs(j.b.x - pR.x) < EPS);
      if (jR) {
        const pts = [...new Set(jR.spans.flatMap((sp) => [sp.a, sp.b]))].sort((u, v) => u - v);
        for (const s of pts) {
          const q = alongSeg(peak, pR, s);
          pushNode(nodes, q.x, q.y);
        }
      }
      pushNode(nodes, pR.x, pR.y);
      if (adjR) pushNode(nodes, xR, yCornerR);
      pushNode(nodes, xR, yBot);
      pushNode(nodes, xL, yBot);
      if (adjL) pushNode(nodes, xL, yCornerL);
    } else if (prof.kind === 'shed-slope') {
      const p0: Pt = { x: 0, y: yOfZ(zAtPanel(0)) };
      const pL: Pt = { x: L, y: yOfZ(zAtPanel(L)) };
      pushNode(nodes, p0.x, p0.y);
      if (slopeJoints.length) {
        const j = slopeJoints[0];
        const forward = Math.abs(j.a.x - p0.x) < EPS;
        const Ls = Math.hypot(pL.x - p0.x, pL.y - p0.y);
        const pts = [...new Set(j.spans.flatMap((sp) => (forward ? [sp.a, sp.b] : [Ls - sp.b, Ls - sp.a])))].sort((u, v) => u - v);
        for (const s of pts) {
          const q = alongSeg(p0, pL, s);
          pushNode(nodes, q.x, q.y);
        }
      }
      pushNode(nodes, pL.x, pL.y);
      if (Math.abs(yCornerR - pL.y) > EPS) pushNode(nodes, L, yCornerR);
      if (adjR) pushNode(nodes, xR, yCornerR);
      pushNode(nodes, xR, yBot);
      pushNode(nodes, xL, yBot);
      if (adjL) pushNode(nodes, xL, yCornerL);
      if (Math.abs(yCornerL - p0.y) > EPS) pushNode(nodes, 0, yCornerL);
    } else {
      // Flat or shed-high rectangular wall
      pushNode(nodes, xL, 0);
      const topSplits = [...new Set(flatRoofSpans.flatMap((sp) => [sp.a, sp.b]))].filter((x) => x > xL + EPS && x < xR - EPS).sort((a, b) => a - b);
      for (const x of topSplits) pushNode(nodes, x, 0);
      pushNode(nodes, xR, 0);
      pushNode(nodes, xR, yBot);
      pushNode(nodes, xL, yBot);
    }

    parts[key] = [{ closed: true, nodes }];
    setups.set(key, { key, L, topZ, botZ, xL, xR, yCornerL, yCornerR, yBot, kind: prof.kind, slopeJoints, flatRoofSpans });
    outerHeights[key] = { topZ, botZ };
  }

  // 4. Floor & flush-flat-roof finger joints with all closed outer walls (floor/roof FIRST so they own corner squares)
  const floorEdge = (k: OuterWallKey): [Pt, Pt] => {
    const fx0 = sides.x0 ? -W / 2 + t : -W / 2;
    const fx1 = sides.x1 ? W / 2 - t : W / 2;
    const fy0 = sides.y0 ? -D / 2 + t : -D / 2;
    const fy1 = sides.y1 ? D / 2 - t : D / 2;
    if (k === 'front') return [{ x: fx0, y: fy1 }, { x: fx1, y: fy1 }];
    if (k === 'back') return [{ x: fx0, y: fy0 }, { x: fx1, y: fy0 }];
    if (k === 'left') return [{ x: fx0, y: fy0 }, { x: fx0, y: fy1 }];
    return [{ x: fx1, y: fy0 }, { x: fx1, y: fy1 }];
  };

  for (const s of setups.values()) {
    const [fa, fb] = floorEdge(s.key);
    if (d.floor && parts.floor) {
      keep(
        joint(parts, opts({ kind: 'finger', fingerWidth: finger, direction: 'out' }), [
          { part: 'floor', a: fa, b: fb },
          { part: s.key, a: { x: s.xL, y: s.yBot }, b: { x: s.xR, y: s.yBot } },
        ]),
      );
    }
    if (rm.flushFlat && parts.roof) {
      keep(
        joint(parts, opts({ kind: 'finger', fingerWidth: finger, direction: 'out' }), [
          { part: 'roof', a: fa, b: fb },
          { part: s.key, a: { x: s.xL, y: 0 }, b: { x: s.xR, y: 0 } },
        ]),
      );
    }
  }

  // Corner squares on floor and flush flat roof where two adjacent outer walls meet
  const cornerSq: SubPath[] = [];
  for (const [ys, ySign] of [['y0', -1], ['y1', 1]] as const) {
    for (const [xs, xSign] of [['x0', -1], ['x1', 1]] as const) {
      if (!sides[ys] || !sides[xs]) continue;
      const x0 = xSign < 0 ? -W / 2 : W / 2 - t;
      const y0 = ySign < 0 ? -D / 2 : D / 2 - t;
      cornerSq.push(polygon([[x0, y0], [x0 + t, y0], [x0 + t, y0 + t], [x0, y0 + t]]));
    }
  }
  if (cornerSq.length) {
    if (d.floor && parts.floor) parts.floor = host.boolean({ op: 'union', a: parts.floor, b: cornerSq });
    if (rm.flushFlat && parts.roof) parts.roof = host.boolean({ op: 'union', a: parts.roof, b: cornerSq });
  }

  // 5. Vertical corner finger joints between adjacent outer walls
  // Rule: flat wall is ALWAYS first; between two flat walls, front/back is first.
  const corners: [OuterWallKey, 'left' | 'right', OuterWallKey, 'left' | 'right'][] = [
    ['front', 'left', 'left', 'right'],
    ['front', 'right', 'right', 'right'],
    ['back', 'left', 'left', 'left'],
    ['back', 'right', 'right', 'left'],
  ];
  for (const [k1, s1, k2, s2] of corners) {
    const w1 = setups.get(k1),
      w2 = setups.get(k2);
    if (!w1 || !w2) continue;
    const isSloped = (w: WallSetup) => w.kind === 'gable' || w.kind === 'shed-slope';
    const [first, fSide, second, sSide] = isSloped(w1) && !isSloped(w2) ? [w2, s2, w1, s1] : [w1, s1, w2, s2];
    const edgeOf = (w: WallSetup, side: 'left' | 'right') => {
      const x = side === 'left' ? w.xL : w.xR;
      const yTop = side === 'left' ? w.yCornerL : w.yCornerR;
      return { part: w.key, a: { x, y: yTop }, b: { x, y: w.yBot } };
    };
    keep(joint(parts, opts({ kind: 'finger', fingerWidth: finger, direction: 'out' }), [edgeOf(first, fSide), edgeOf(second, sSide)]));
  }

  // 6. Roof tenons (overhanging flat roof, fixed gable roof, fixed shed roof)
  for (const s of setups.values()) {
    // Overhanging fixed flat roof tenons
    if (s.flatRoofSpans.length && parts.roof) {
      for (const sp of s.flatRoofSpans) {
        const map = (u: number): Pt => {
          if (s.key === 'front') return { x: u - W / 2, y: D / 2 - t / 2 };
          if (s.key === 'back') return { x: u - W / 2, y: -D / 2 + t / 2 };
          if (s.key === 'left') return { x: -W / 2 + t / 2, y: u - D / 2 };
          return { x: W / 2 - t / 2, y: u - D / 2 };
        };
        parts = tenonsInto(
          parts,
          opts({ kind: 'tenon', tenonCount: 1, tenonWidth: sp.width }),
          { part: s.key, a: { x: sp.a, y: 0 }, b: { x: sp.b, y: 0 } },
          'roof',
          map(sp.a),
          map(sp.b),
        );
      }
    }

    // Sloped gable / shed roof tenons
    for (const sj of s.slopeJoints) {
      for (const sp of sj.spans) {
        const pa = alongSeg(sj.a, sj.b, sp.a);
        const pb = alongSeg(sj.a, sj.b, sp.b);
        parts = roofTenonInto(
          parts,
          opts({ kind: 'tenon', tenonCount: 1, tenonWidth: sp.width }),
          { part: s.key, a: pa, b: pb },
          sj.roofKey,
          { x: sj.xRoof, y: sj.yRoofAt(sp.a) },
          { x: sj.xRoof, y: sj.yRoofAt(sp.b) },
          sj.flushSide,
        );
      }
    }
  }

  // 7. Removable gable attic trusses (with tenons into the two roof panels so the roof lifts off as one rigid piece)
  const trusses = buildRoofTrusses(W, D, H, t, roof);
  for (const tr of trusses) {
    const half = tr.innerSpan / 2;
    const h = tr.rise;
    const ca = Math.cos(tr.pitchRad);
    const tanA = Math.tan(tr.pitchRad);
    const LsInner = half / ca;
    const sRidge = Math.max(t, t * tanA) + t;
    const sHeel = Math.max(t, t / ca) + t * 0.5;
    const spans = roofTenonSpans(sRidge, LsInner - sHeel, t, finger);

    // Uncentered truss coords: x ∈ [0..innerSpan] (peak at x=half, y=0; base at y=h)
    const peak: Pt = { x: half, y: 0 };
    const pL: Pt = { x: 0, y: h - tr.heel };
    const pR: Pt = { x: tr.innerSpan, y: h - tr.heel };
    const nodes: Pt[] = [];
    pushNode(nodes, pL.x, pL.y);
    if (spans.length) {
      const pts = [...new Set(spans.flatMap((sp) => [LsInner - sp.b, LsInner - sp.a]))].sort((a, b) => a - b);
      for (const s of pts) {
        const q = alongSeg(pL, peak, s);
        pushNode(nodes, q.x, q.y);
      }
    }
    pushNode(nodes, peak.x, peak.y);
    if (spans.length) {
      const pts = [...new Set(spans.flatMap((sp) => [sp.a, sp.b]))].sort((a, b) => a - b);
      for (const s of pts) {
        const q = alongSeg(peak, pR, s);
        pushNode(nodes, q.x, q.y);
      }
    }
    pushNode(nodes, pR.x, pR.y);
    pushNode(nodes, tr.innerSpan, h);
    pushNode(nodes, 0, h);
    parts[tr.key] = [{ closed: true, nodes }];

    if (spans.length) {
      if (roof.ridgeAxis === 'x') {
        const rpF = rpByKey.get('roof-front')!;
        const rpB = rpByKey.get('roof-back')!;
        // tr.at is 3D X center; roof-front has u=+X (x = tr.at - W/2), roof-back has u=-X (x = W/2 - tr.at)
        const xF = tr.at - W / 2;
        const xB = W / 2 - tr.at;
        for (const sp of spans) {
          parts = tenonsInto(
            parts,
            opts({ kind: 'tenon', tenonCount: 1, tenonWidth: sp.width }),
            { part: tr.key, a: alongSeg(peak, pL, sp.a), b: alongSeg(peak, pL, sp.b) },
            'roof-back',
            { x: xB, y: -rpB.height / 2 + sp.a },
            { x: xB, y: -rpB.height / 2 + sp.b },
          );
          parts = tenonsInto(
            parts,
            opts({ kind: 'tenon', tenonCount: 1, tenonWidth: sp.width }),
            { part: tr.key, a: alongSeg(peak, pR, sp.a), b: alongSeg(peak, pR, sp.b) },
            'roof-front',
            { x: xF, y: -rpF.height / 2 + sp.a },
            { x: xF, y: -rpF.height / 2 + sp.b },
          );
        }
      } else {
        const rpL = rpByKey.get('roof-left')!;
        const rpR = rpByKey.get('roof-right')!;
        // tr.at is 3D Y center; roof-left has u=-Y (x = D/2 - tr.at), roof-right has u=+Y (x = tr.at - D/2)
        const xL_r = D / 2 - tr.at;
        const xR_r = tr.at - D / 2;
        for (const sp of spans) {
          parts = tenonsInto(
            parts,
            opts({ kind: 'tenon', tenonCount: 1, tenonWidth: sp.width }),
            { part: tr.key, a: alongSeg(peak, pL, sp.a), b: alongSeg(peak, pL, sp.b) },
            'roof-left',
            { x: xL_r, y: -rpL.height / 2 + sp.a },
            { x: xL_r, y: -rpL.height / 2 + sp.b },
          );
          parts = tenonsInto(
            parts,
            opts({ kind: 'tenon', tenonCount: 1, tenonWidth: sp.width }),
            { part: tr.key, a: alongSeg(peak, pR, sp.a), b: alongSeg(peak, pR, sp.b) },
            'roof-right',
            { x: xR_r, y: -rpR.height / 2 + sp.a },
            { x: xR_r, y: -rpR.height / 2 + sp.b },
          );
        }
      }
    }

    // Center the truss around (half, h/2)
    parts[tr.key] = shiftSubs(parts[tr.key], -half, -h / 2);
  }

  // 8. Interior walls & their joints (crossings, corners, T-joints into inner & outer walls, floor teeth)
  const walls = wallPanels(m, d);
  const tenoned = (e: End) => e.kind === 'tee' || (e.kind === 'outer' && d.sides[e.side]);
  for (const p of walls) parts[p.key] = [panel(p.e - p.s, p.h, wallSplits(p, d, tenoned))];
  parts = innerJoints(parts, walls, d, info, (end, p) => {
    if (end.kind !== 'outer' || !d.sides[end.side]) return null;
    const key = OUTER[end.side];
    const s = setups.get(key);
    if (!s) return null;
    // Unmirrored outer wall coords: x = p.it.wall.pos + t, y = s.yBot - p.h + y_inner
    const u = p.it.wall.pos + t;
    return { into: key, at: (y) => ({ x: u, y: s.yBot - p.h + y }) };
  });

  // 9. Cut doors & windows and add engraved frame marks on outer walls & interior walls (BEFORE centering!)
  const hosts = houseWallHosts(m, d);
  for (const s of setups.values()) {
    const wallOps = openings.filter((o) => o.wall === s.key);
    if (!wallOps.length) continue;
    const flipX = s.key === 'back' || s.key === 'right';
    const cuts: SubPath[] = [];
    const wallMarks: SubPath[] = [];
    for (const op of wallOps) {
      const cx = flipX ? s.L - op.x : op.x;
      const yBot = s.topZ - (floorZ + op.y);
      const cutThrough = !d.floor && op.y <= 0.01;
      cuts.push(...openingCutouts(op, cx, yBot, d.mullionWidth, cutThrough));
      if (d.engraveFrames) wallMarks.push(...openingMarks(op, cx, yBot, d.frameWidth));
    }
    if (cuts.length) parts[s.key] = host.boolean({ op: 'difference', a: parts[s.key], b: cuts });
    if (wallMarks.length) marks[s.key] = wallMarks;
  }

  for (const p of walls) {
    const wallOps = openings.filter((o) => o.wall === p.key);
    if (!wallOps.length) continue;
    const cuts: SubPath[] = [];
    const wallMarks: SubPath[] = [];
    for (const op of wallOps) {
      const yBot = p.h - op.y;
      const cutThrough = !d.floor && op.y <= 0.01;
      cuts.push(...openingCutouts(op, op.x, yBot, d.mullionWidth, cutThrough));
      if (d.engraveFrames) wallMarks.push(...openingMarks(op, op.x, yBot, d.frameWidth));
    }
    if (cuts.length) parts[p.key] = host.boolean({ op: 'difference', a: parts[p.key], b: cuts });
    if (wallMarks.length) marks[p.key] = wallMarks;
  }

  // 10. Center outer walls and inner walls around their bounding centers
  for (const s of setups.values()) {
    const cx = s.L / 2;
    // Center Y so 3D pose o.z = (topZ + (floor ? 0 : 0)) / 2 — wait: keep wall panel center at (L/2, topZ/2)
    // so bottom Z=0 is at y = +topZ/2 and top Z=topZ is at y = -topZ/2!
    const cy = s.topZ / 2;
    parts[s.key] = shiftSubs(parts[s.key], -cx, -cy);
    if (marks[s.key]) marks[s.key] = shiftSubs(marks[s.key], -cx, -cy);
  }
  for (const p of walls) {
    const cx = (p.e - p.s) / 2,
      cy = p.h / 2;
    parts[p.key] = shiftSubs(parts[p.key], -cx, -cy);
    if (marks[p.key]) marks[p.key] = shiftSubs(marks[p.key], -cx, -cy);
  }

  return { parts, marks, info: dedupeInfo(info), walls, boards: [], roofPanels, trusses, outerHeights, hosts };
}

/** Translate every node and Bezier handle in a list of SubPaths by (dx, dy) */
function shiftSubs(subs: SubPath[], dx: number, dy: number): SubPath[] {
  return subs.map((sp) => ({
    closed: sp.closed,
    nodes: sp.nodes.map((n) => ({
      ...n,
      x: n.x + dx,
      y: n.y + dy,
      ...(n.cin ? { cin: { x: n.cin.x + dx, y: n.cin.y + dy } } : {}),
      ...(n.cout ? { cout: { x: n.cout.x + dx, y: n.cout.y + dy } } : {}),
    })),
  }));
}

// ---------- Shaped outline (L / U / C footprints with flat roof, adapted from box-composer-advanced) ----------

const reachOf = (q: OEdgeInfo['start'], t: number) => (q.kind === 'through' ? t / 2 : q.kind === 'line' && q.wall === undefined ? 0 : -t / 2);
const given = (q: OEdgeInfo['start']) => (q.kind === 'open' || (q.kind === 'through' && q.at !== undefined) ? q.at : undefined);
const edgeRange = (e: OEdgeInfo, t: number): [number, number] => [given(e.start) ?? e.from - reachOf(e.start, t), given(e.end) ?? e.to + reachOf(e.end, t)];
const crossed = (q: OEdgeInfo['start']) => q.kind === 'through' && q.cross !== undefined;
const jointRange = (e: OEdgeInfo, t: number): [number, number] => {
  const [a, b] = edgeRange(e, t);
  return [crossed(e.start) ? e.from + t / 2 : a, crossed(e.end) ? e.to - t / 2 : b];
};

export function boards(m: Model, d: HouseDims, walls: WallPanel[]): Board[] {
  const es = m.outline!.edges.filter((e) => !e.open);
  const t = d.t;
  const ho = outerBoardHeight(d);
  const byId = new Map(walls.map((p) => [p.it.wall.id, p]));
  const group = m.outline!.edges.map((e) => e.k);
  const find = (k: number): number => (group[k] === k ? k : (group[k] = find(group[k])));
  const memberOf = new Map<number, number>();
  for (const e of es)
    for (const q of [e.start, e.end])
      if (q.kind === 'through') {
        const prev = memberOf.get(q.wall);
        if (prev !== undefined) group[find(prev)] = find(e.k);
        memberOf.set(q.wall, e.k);
      }
  const out = new Map<number, Board>();
  for (const e of es) {
    const g = find(e.k);
    let b = out.get(g);
    if (!b) out.set(g, (b = { key: outerKey(e.k), axis: e.axis, pos: e.pos, edges: [], members: [], bs: Infinity, be: -Infinity, h: ho }));
    b.edges.push(e);
    const [a, z] = edgeRange(e, t);
    b.bs = Math.min(b.bs, a);
    b.be = Math.max(b.be, z);
  }
  for (const [id, k] of memberOf) {
    const b = out.get(find(k))!;
    const p = byId.get(id)!;
    if (!b.members.includes(p)) b.members.push(p);
    b.bs = Math.min(b.bs, p.s);
    b.be = Math.max(b.be, p.e);
  }
  const list = [...out.values()];
  for (const b of list) {
    b.key = outerKey(Math.min(...b.edges.map((e) => e.k)));
    for (const p of b.members) Object.assign(p, { part: b.key, ox: p.s - b.bs, oy: ho - p.h });
  }
  return list;
}

function boardOutline(b: Board, els: { a: number; b: number; top: number }[], splits: { top: number[]; bottom: number[]; left: number[]; right: number[] }): SubPath {
  const L = b.be - b.bs,
    h = b.h;
  const e = [...els].sort((p, q) => p.a - q.a);
  const nodes: Pt[] = [];
  const push = (x: number, y: number) => {
    const last = nodes[nodes.length - 1];
    if (!last || Math.abs(last.x - x) > 1e-9 || Math.abs(last.y - y) > 1e-9) nodes.push({ x, y });
  };
  const inside = (v: number[], lo: number, hi: number, desc = false) => [...new Set(v.filter((x) => x > lo + EPS && x < hi - EPS))].sort((p, q) => (desc ? q - p : p - q));
  for (const el of e) {
    push(el.a, el.top);
    for (const x of inside(splits.top.filter((x) => x > el.a && x < el.b), el.a, el.b)) push(x, el.top);
    push(el.b, el.top);
  }
  const t0 = e[0].top,
    t1 = e[e.length - 1].top;
  for (const y of inside(splits.right, t1, h)) push(L, y);
  push(L, h);
  for (const x of inside(splits.bottom, 0, L, true)) push(x, h);
  push(0, h);
  for (const y of inside(splits.left, t0, h, true)) push(0, y);
  return { closed: true, nodes };
}

function shapedHouseParts(m: Model, d: HouseDims, openings: Opening[]): BuiltHouse {
  const { W, D, H, t, finger, roof } = d;
  const info: JointMsg[] = [];
  const marks: Record<string, SubPath[]> = {};
  const rm = computeRoofMetrics(W, D, H, t, roof);
  const ol = m.outline!;
  const ho = outerBoardHeight(d);
  const floorZ = d.floor ? t : 0;
  const walls = wallPanels(m, d);
  const bs = boards(m, d, walls);
  const boardOf = new Map<number, Board>();
  for (const b of bs) for (const e of b.edges) boardOf.set(e.k, b);
  const memberIds = new Set(bs.flatMap((b) => b.members.map((p) => p.it.wall.id)));
  const byId = new Map(walls.map((p) => [p.it.wall.id, p]));
  const fl = (x: number, y: number): Pt => ({ x: x + t - W / 2, y: y + t - D / 2 });
  const tenoned = (e: End) => e.kind === 'tee' || e.kind === 'edge';
  const drop = ho - innerHeight(d);
  const intoStretches = () => tenonStretches(drop, ho, finger);
  let parts: Parts = {};

  const n = ol.edges.length;
  const off = (e: OEdgeInfo) => e.pos + ((e.open ? -1 : 1) * e.inside * t) / 2;
  const ends = (e: OEdgeInfo, o: OEdgeInfo, p: XY): [number, number] => {
    const along = o.axis === e.axis ? (e.axis === 'h' ? p[0] : p[1]) : off(o);
    return e.axis === 'h' ? [along, off(e)] : [off(e), along];
  };
  const makePlate = (outer = false): SubPath => {
    const nodes: Pt[] = [];
    const push = (x: number, y: number) => {
      const q = fl(x, y),
        last = nodes[nodes.length - 1];
      if (!last || Math.abs(last.x - q.x) > 1e-9 || Math.abs(last.y - q.y) > 1e-9) nodes.push(q);
    };
    const offFn = (e: OEdgeInfo) => (outer ? e.pos - (e.inside * t) / 2 : off(e));
    const endsFn = (e: OEdgeInfo, o: OEdgeInfo, p: XY): [number, number] => {
      const along = o.axis === e.axis ? (e.axis === 'h' ? p[0] : p[1]) : offFn(o);
      return e.axis === 'h' ? [along, offFn(e)] : [offFn(e), along];
    };
    for (let k = 0; k < n; k++) {
      const e = ol.edges[k];
      const [a, b] = endsFn(e, ol.edges[(k + n - 1) % n], ol.pts[k]),
        [c, dd] = endsFn(e, ol.edges[(k + 1) % n], ol.pts[(k + 1) % n]);
      push(a, b);
      if (!outer && !e.open) {
        const [r0, r1] = edgeRange(e, t),
          [j0, j1] = jointRange(e, t);
        const along0 = e.axis === 'h' ? a : b,
          along1 = e.axis === 'h' ? c : dd;
        const dir = Math.sign(along1 - along0);
        const marksPos = [...new Set([r0, r1, j0, j1])].filter((v) => (v - along0) * dir > EPS && (along1 - v) * dir > EPS).sort((p, q) => (p - q) * dir);
        for (const v of marksPos) e.axis === 'h' ? push(v, b) : push(a, v);
      }
      push(c, dd);
    }
    if (nodes.length > 1 && Math.abs(nodes[0].x - nodes[nodes.length - 1].x) < 1e-9 && Math.abs(nodes[0].y - nodes[nodes.length - 1].y) < 1e-9) nodes.pop();
    return { closed: true, nodes };
  };

  if (d.floor) parts.floor = [makePlate(false)];
  const overhangingFlat = roof.type === 'flat' && !rm.flushFlat;
  if (rm.flushFlat) {
    parts.roof = [makePlate(false)];
  } else {
    const outerRoof = makePlate(true);
    parts.roof = roof.overhang > EPS ? host.offset({ subs: [outerRoof], delta: roof.overhang, join: 'miter' }) : [outerRoof];
  }

  // Track flat roof tenon spans per outer edge
  const edgeRoofSpans = new Map<number, { a: number; b: number; width: number }[]>();
  for (const b of bs) {
    const els = [
      ...b.edges.map((e) => {
        const [a, z] = edgeRange(e, t);
        return { a: a - b.bs, b: z - b.bs, top: 0 };
      }),
      ...b.members.map((p) => ({ a: p.ox, b: p.ox + p.e - p.s, top: p.oy })),
    ];
    const top: number[] = [],
      bottom: number[] = [],
      left: number[] = [],
      right: number[] = [];
    for (const el of els) top.push(el.a, el.b), bottom.push(el.a, el.b);
    for (const e of b.edges) {
      for (const v of jointRange(e, t)) top.push(v - b.bs), bottom.push(v - b.bs);
      if (overhangingFlat && roof.mount === 'fixed' && roof.overhang >= t - EPS) {
        const [j0, j1] = jointRange(e, t);
        const sps = roofTenonSpans(j0, j1, t, finger);
        edgeRoofSpans.set(e.k, sps);
        for (const sp of sps) top.push(sp.a - b.bs, sp.b - b.bs);
      }
    }
    for (const p of b.members) {
      const s = wallSplits(p, d, tenoned);
      top.push(...s.top.map((x) => x + p.ox));
      bottom.push(...s.bottom.map((x) => x + p.ox));
      if (p.ox < EPS) left.push(...s.left.map((y) => y + p.oy));
      if (p.ox + p.e - p.s > b.be - b.bs - EPS) right.push(...s.right.map((y) => y + p.oy));
    }
    for (const e of b.edges) {
      const [a, z] = edgeRange(e, t);
      const ys = intoStretches().flatMap((sp) => [sp.a, sp.b]);
      if (e.start.kind === 'into' && a - b.bs < EPS) left.push(...ys);
      if (e.end.kind === 'into' && z - b.bs > b.be - b.bs - EPS) right.push(...ys);
      const lower = (q: OEdgeInfo['start']) => (q.kind === 'line' && q.wall !== undefined ? [ho - (byId.get(q.wall)?.h ?? ho)] : []);
      if (a - b.bs < EPS) left.push(...lower(e.start));
      if (z - b.bs > b.be - b.bs - EPS) right.push(...lower(e.end));
    }
    parts[b.key] = [boardOutline(b, els, { top, bottom, left, right })];
  }

  for (const p of walls) if (!memberIds.has(p.it.wall.id)) parts[p.key] = [panel(p.e - p.s, p.h, wallSplits(p, d, tenoned))];

  const opts = (o: JointOptions): JointOptions => ({ thickness: t, clearance: d.clearance, ...o });
  const keep = (r: { parts: Parts; info: JointMsg[] }) => {
    parts = r.parts;
    info.push(...r.info);
  };

  for (const e of ol.edges) {
    if (e.open) continue;
    const b = boardOf.get(e.k)!;
    const [r0, r1] = jointRange(e, t);
    const f = e.pos + (e.inside * t) / 2;
    const P = (v: number) => (e.axis === 'h' ? fl(v, f) : fl(f, v));
    if (d.floor && parts.floor)
      keep(joint(parts, opts({ kind: 'finger', fingerWidth: finger, direction: 'out' }), [{ part: 'floor', a: P(r0), b: P(r1) }, { part: b.key, a: { x: r0 - b.bs, y: ho }, b: { x: r1 - b.bs, y: ho } }]));
    if (rm.flushFlat && parts.roof)
      keep(joint(parts, opts({ kind: 'finger', fingerWidth: finger, direction: 'out' }), [{ part: 'roof', a: P(r0), b: P(r1) }, { part: b.key, a: { x: r0 - b.bs, y: 0 }, b: { x: r1 - b.bs, y: 0 } }]));
    // Overhanging flat roof tenons
    const sps = edgeRoofSpans.get(e.k);
    if (sps && parts.roof) {
      const Pc = (v: number) => (e.axis === 'h' ? fl(v, e.pos) : fl(e.pos, v));
      for (const sp of sps) {
        parts = tenonsInto(
          parts,
          opts({ kind: 'tenon', tenonCount: 1, tenonWidth: sp.width }),
          { part: b.key, a: { x: sp.a - b.bs, y: 0 }, b: { x: sp.b - b.bs, y: 0 } },
          'roof',
          Pc(sp.a),
          Pc(sp.b),
        );
      }
    }
  }

  const squares: SubPath[] = [];
  const square = (cx: number, cy: number): SubPath => {
    const p0 = fl(cx - t / 2, cy - t / 2),
      p1 = fl(cx + t / 2, cy + t / 2);
    return { closed: true, nodes: [p0, { x: p1.x, y: p0.y }, p1, { x: p0.x, y: p1.y }] };
  };
  for (const e of ol.edges)
    for (const which of ['start', 'end'] as const) {
      if (e.open) continue;
      const q = e[which];
      const v = which === 'start' ? e.from : e.to;
      const b = boardOf.get(e.k)!;
      const x = (which === 'start' ? edgeRange(e, t)[0] : edgeRange(e, t)[1]) - b.bs;
      if (q.kind === 'line' && q.wall !== undefined) {
        const p = byId.get(q.wall)!;
        const px = p.it.start.kind === 'board' && p.it.start.edge === e.k ? 0 : p.e - p.s;
        const P = (y: number): Pt => ({ x: px + p.ox, y: y + p.oy });
        keep(joint(parts, opts({ kind: 'finger', fingerWidth: finger, direction: 'out' }), [{ part: b.key, a: { x, y: ho - p.h }, b: { x, y: ho } }, { part: p.part, a: P(0), b: P(p.h) }]));
        squares.push(e.axis === 'h' ? square(v, e.pos) : square(e.pos, v));
      } else if (q.kind === 'corner') {
        if (q.edge < e.k) continue;
        const o = ol.edges[q.edge];
        const ob = boardOf.get(o.k)!;
        const oWhich = Math.abs(o.from - e.pos) < EPS ? 0 : 1;
        const ox = edgeRange(o, t)[oWhich] - ob.bs;
        keep(joint(parts, opts({ kind: 'finger', fingerWidth: finger, direction: 'out' }), [{ part: b.key, a: { x, y: 0 }, b: { x, y: ho } }, { part: ob.key, a: { x: ox, y: 0 }, b: { x: ox, y: ho } }]));
        squares.push(e.axis === 'h' ? square(v, e.pos) : square(e.pos, v));
      } else if (crossed(q) && e.axis === 'h') {
        squares.push(square(v, e.pos));
      } else if (q.kind === 'into') {
        const hb = boardOf.get(q.edge)!;
        const u = e.pos - hb.bs;
        for (const sp of intoStretches())
          parts = tenonsInto(parts, opts({ kind: 'tenon', tenonCount: 1, tenonWidth: sp.width }), { part: b.key, a: { x, y: sp.a }, b: { x, y: sp.b } }, hb.key, { x: u, y: sp.a }, { x: u, y: sp.b });
      }
    }
  if (squares.length) {
    if (d.floor && parts.floor) parts.floor = host.boolean({ op: 'union', a: parts.floor, b: squares });
    if (rm.flushFlat && parts.roof) parts.roof = host.boolean({ op: 'union', a: parts.roof, b: squares });
  }

  parts = innerJoints(parts, walls, d, info, (end, p) => {
    if (end.kind !== 'edge') return null;
    const b = boardOf.get(end.edge)!;
    const u = p.it.wall.pos - b.bs;
    return { into: b.key, at: (y) => ({ x: u, y: ho - p.h + y }) };
  });

  for (const e of ol.edges)
    for (const which of ['start', 'end'] as const) {
      const q = e[which];
      if (q.kind !== 'through' || q.cross === undefined || e.axis !== 'h') continue;
      const o = ol.edges[q.cross];
      const v = which === 'start' ? e.from : e.to;
      const half = (t + d.clearance) / 2;
      const cut = (b: Board, at: number, top: boolean): SubPath => {
        const x0 = at - b.bs - half,
          x1 = at - b.bs + half;
        const [y0, y1] = top ? [-1, ho / 2] : [ho / 2, ho + t + 1];
        return polygon([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
      };
      const hb = boardOf.get(e.k)!,
        vb = boardOf.get(o.k)!;
      parts[hb.key] = host.boolean({ op: 'difference', a: parts[hb.key], b: [cut(hb, v, true)] });
      parts[vb.key] = host.boolean({ op: 'difference', a: parts[vb.key], b: [cut(vb, e.pos, false)] });
    }

  // Cut interior-wall openings on standalone inner walls
  for (const p of walls) {
    if (memberIds.has(p.it.wall.id)) continue;
    const wallOps = openings.filter((o) => o.wall === p.key);
    if (!wallOps.length) continue;
    const cuts: SubPath[] = [];
    const wallMarks: SubPath[] = [];
    for (const op of wallOps) {
      const yBot = p.h - op.y;
      const cutThrough = !d.floor && op.y <= 0.01;
      cuts.push(...openingCutouts(op, op.x, yBot, d.mullionWidth, cutThrough));
      if (d.engraveFrames) wallMarks.push(...openingMarks(op, op.x, yBot, d.frameWidth));
    }
    if (cuts.length) parts[p.key] = host.boolean({ op: 'difference', a: parts[p.key], b: cuts });
    if (wallMarks.length) marks[p.key] = wallMarks;
  }

  // Cut outer-side openings onto matching bounding-box outer boards
  const wInner = W - 2 * t,
    dInner = D - 2 * t;
  const sidePos: Record<OuterWallKey, { axis: 'h' | 'v'; pos: number; len: number; flipX: boolean }> = {
    front: { axis: 'h', pos: dInner + t / 2, len: W, flipX: false },
    back: { axis: 'h', pos: -t / 2, len: W, flipX: true },
    left: { axis: 'v', pos: -t / 2, len: D, flipX: false },
    right: { axis: 'v', pos: wInner + t / 2, len: D, flipX: true },
  };
  for (const b of bs) {
    const cuts: SubPath[] = [];
    const bMarks: SubPath[] = [];
    for (const [wk, sp] of Object.entries(sidePos) as [OuterWallKey, (typeof sidePos)[OuterWallKey]][]) {
      if (b.axis !== sp.axis || Math.abs(b.pos - sp.pos) > 0.05) continue;
      for (const op of openings.filter((o) => o.wall === wk)) {
        const panelX = (sp.flipX ? sp.len - op.x : op.x) - t;
        const bx = panelX - b.bs;
        if (bx - op.w / 2 > t && bx + op.w / 2 < b.be - b.bs - t && op.y + op.h < ho - t) {
          const yBot = ho - op.y;
          const cutThrough = !d.floor && op.y <= 0.01;
          cuts.push(...openingCutouts(op, bx, yBot, d.mullionWidth, cutThrough));
          if (d.engraveFrames) bMarks.push(...openingMarks(op, bx, yBot, d.frameWidth));
        }
      }
    }
    if (cuts.length) parts[b.key] = host.boolean({ op: 'difference', a: parts[b.key], b: cuts });
    if (bMarks.length) marks[b.key] = bMarks;
  }

  // Roof engraving pattern for shaped flat roof (approximated by bounding rect clipped to roof outline if needed)
  if (roof.pattern !== 'none' && parts.roof?.[0]) {
    const pts = parts.roof[0].nodes.map((nd): [number, number] => [nd.x, nd.y]);
    if (pts.length <= 4) {
      const mks = roofPatternMarks(pts, roof.pattern, roof.patternSize, 2);
      if (mks.length) marks.roof = mks;
    }
  }

  for (const b of bs) {
    const cx = (b.be - b.bs) / 2,
      cy = ho / 2;
    parts[b.key] = shiftSubs(parts[b.key], -cx, -cy);
    if (marks[b.key]) marks[b.key] = shiftSubs(marks[b.key], -cx, -cy);
  }
  for (const p of walls) {
    if (memberIds.has(p.it.wall.id)) continue;
    const cx = (p.e - p.s) / 2,
      cy = p.h / 2;
    parts[p.key] = shiftSubs(parts[p.key], -cx, -cy);
    if (marks[p.key]) marks[p.key] = shiftSubs(marks[p.key], -cx, -cy);
  }

  const roofZ = rm.flushFlat ? H - t : H;
  const roofPanels: RoofPanelGeom[] = [
    {
      key: 'roof',
      pts: [],
      width: W + 2 * roof.overhang,
      height: D + 2 * roof.overhang,
      slopeLen: D,
      pose: { o: [W / 2, D / 2, roofZ], u: [1, 0, 0], v: [0, -1, 0], n: [0, 0, 1] },
      marks: [],
    },
  ];
  return {
    parts,
    marks,
    info: dedupeInfo(info),
    walls: walls.filter((p) => !memberIds.has(p.it.wall.id)),
    boards: bs,
    roofPanels,
    trusses: [],
    outerHeights: {},
    hosts: houseWallHosts(m, d),
  };
}

// ---------- Orientation (outer face up on laser bed), kerf, and 3D poses ----------

const X: V3 = [1, 0, 0],
  Y: V3 = [0, 1, 0],
  Z: V3 = [0, 0, 1];
const neg = (a: V3): V3 => [-a[0], -a[1], -a[2]];

export const TURNED_OVER = ['floor', 'back', 'right'];
export const boardTurned = (b: Board) => (b.axis === 'h') === (b.edges[0]?.inside === 1);

export function mirrorX(sp: SubPath): SubPath {
  const f = (p: { x: number; y: number }) => ({ x: -p.x, y: p.y });
  const ns = !sp.closed ? [...sp.nodes].reverse() : sp.nodes.length ? [sp.nodes[0], ...sp.nodes.slice(1).reverse()] : [];
  return {
    ...sp,
    nodes: ns.map((n) => {
      const { cin, cout, ...rest } = n;
      return { ...rest, ...f(n), ...(cout ? { cin: f(cout) } : {}), ...(cin ? { cout: f(cin) } : {}) };
    }),
  };
}

export function turnOver(
  parts: Parts,
  marks: Record<string, SubPath[]>,
  keys: string[],
): { parts: Parts; marks: Record<string, SubPath[]> } {
  const outParts: Parts = { ...parts };
  const outMarks: Record<string, SubPath[]> = { ...marks };
  for (const k of keys) {
    if (outParts[k]) outParts[k] = outParts[k].map(mirrorX);
    if (outMarks[k]) outMarks[k] = outMarks[k].map(mirrorX);
  }
  return { parts: outParts, marks: outMarks };
}

/** 3D assembly poses for every part of the house (floor, walls, boards, roof panels, attic trusses) */
export function housePoses(built: BuiltHouse, d: HouseDims, keys: string[]): Record<string, Pose> {
  const { W, D, H, t } = d;
  const floorZ = d.floor ? t : 0;
  const down = neg(Z);
  const turn = (k: string, a: V3) => (TURNED_OVER.includes(k) ? neg(a) : a);
  const zMid = (k: OuterWallKey) => (built.outerHeights[k]?.topZ ?? H) / 2;

  const all: Record<string, Pose> = {
    floor: { o: [W / 2, D / 2, 0], u: turn('floor', X), v: neg(Y), n: Z },
    front: { o: [W / 2, 0, zMid('front')], u: X, v: down, n: Y },
    back: { o: [W / 2, D - t, zMid('back')], u: turn('back', X), v: down, n: Y },
    left: { o: [0, D / 2, zMid('left')], u: neg(Y), v: down, n: X },
    right: { o: [W - t, D / 2, zMid('right')], u: turn('right', neg(Y)), v: down, n: X },
  };

  for (const rp of built.roofPanels) all[rp.key] = rp.pose;
  for (const tr of built.trusses) all[tr.key] = tr.pose;

  const along = (key: string, axis: 'h' | 'v', pos: number, mid: number, z: number, over = false) => {
    const u = axis === 'h' ? X : neg(Y);
    all[key] =
      axis === 'h'
        ? { o: [t + mid, D - t - pos - t / 2, z], u: over ? neg(u) : u, v: down, n: Y }
        : { o: [t + pos - t / 2, D - t - mid, z], u: over ? neg(u) : u, v: down, n: X };
  };
  for (const p of built.walls) along(p.key, p.it.wall.axis, p.it.wall.pos, p.s + (p.e - p.s) / 2, floorZ + p.h / 2);
  for (const b of built.boards) along(b.key, b.axis, b.pos, (b.bs + b.be) / 2, floorZ + b.h / 2, boardTurned(b));

  return Object.fromEntries(keys.filter((k) => all[k]).map((k) => [k, all[k]]));
}

export function withKerf(parts: Parts, kerf: number): Parts {
  const out: Parts = {};
  for (const [k, subs] of Object.entries(parts)) out[k] = widen(subs, kerf);
  return out;
}

function dedupeInfo(list: JointMsg[]): JointMsg[] {
  const seen = new Set<string>();
  return list.filter((i) => {
    const k = i.code + JSON.stringify(i.values ?? {});
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

export { JointError };
