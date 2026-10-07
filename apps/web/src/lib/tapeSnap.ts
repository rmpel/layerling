import * as THREE from "three";

/**
 * Where the tape measure can snap on a body, worked out from the body's own
 * triangles rather than from the lines drawn on screen. Those lines exist only
 * for selected or "complex" bodies, so an ordinary box gave the tape nothing
 * to hold on to but a random point on its surface.
 *
 * Everything here is in the geometry's own coordinates and is computed once per
 * geometry, then kept as long as the geometry lives.
 */

/** Two faces meeting at more than this angle form an edge the tape can snap to. */
export const SNAP_CREASE_ANGLE_DEGREES = 20;
/** Above this many triangles a body is only measured on its surface: the analysis would stall the pointer. */
export const SNAP_TRIANGLE_LIMIT = 250_000;

export type SnapPath = {
  /** Corner points along the edge, x y z after each other. */
  points: Float32Array;
  closed: boolean;
  length: number;
  /** Halfway along an open edge. A closed loop has no midpoint. */
  midpoint: [number, number, number] | null;
  /** The centre when the edge is a circle or an arc of one. */
  centre: [number, number, number] | null;
};

export type SnapAnalysis = {
  triangleCount: number;
  paths: SnapPath[];
  /** Where edges end or turn sharply, x y z after each other. */
  vertices: Float32Array;
  /** The face a triangle belongs to: triangles reached without crossing an edge. */
  regionOf: (triangle: number) => number;
  /** The face's triangles as plain positions, ready to draw. */
  regionPositions: (region: number) => Float32Array;
  /** Whether the face is flat: only then can a point on it keep to a grid. */
  regionIsPlanar: (region: number) => boolean;
};

const cache = new WeakMap<THREE.BufferGeometry, { version: number; tree: unknown; analysis: SnapAnalysis | null }>();

export function analyzeSnapGeometry(geometry: THREE.BufferGeometry): SnapAnalysis | null {
  const position = geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (!position) return null;
  const version = position.version + (geometry.getIndex()?.version ?? 0) * 1e6;
  // Building a BVH for fast picking reorders the index in place, which would
  // leave the face numbers of an earlier analysis pointing at other triangles.
  const tree = (geometry as THREE.BufferGeometry & { boundsTree?: unknown }).boundsTree;
  const cached = cache.get(geometry);
  if (cached && cached.version === version && cached.tree === tree) return cached.analysis;
  const analysis = analyze(geometry, position);
  cache.set(geometry, { version, tree, analysis });
  return analysis;
}

function analyze(geometry: THREE.BufferGeometry, position: THREE.BufferAttribute): SnapAnalysis | null {
  const index = geometry.getIndex();
  const cornerCount = index ? index.count : position.count;
  const triangleCount = Math.floor(cornerCount / 3);
  if (triangleCount === 0 || triangleCount > SNAP_TRIANGLE_LIMIT) return null;

  // Weld corners that share a position: meshes split them for hard normals.
  geometry.computeBoundingBox();
  const size = geometry.boundingBox?.getSize(new THREE.Vector3()) ?? new THREE.Vector3(1, 1, 1);
  const extent = Math.max(size.x, size.y, size.z, 1e-6);
  const weld = extent * 1e-6;
  const welded = new Map<string, number>();
  const weldedPositions: number[] = [];
  const cornerVertex = new Int32Array(triangleCount * 3);
  for (let corner = 0; corner < triangleCount * 3; corner += 1) {
    const source = index ? index.getX(corner) : corner;
    const x = position.getX(source);
    const y = position.getY(source);
    const z = position.getZ(source);
    const key = `${Math.round(x / weld)},${Math.round(y / weld)},${Math.round(z / weld)}`;
    let id = welded.get(key);
    if (id === undefined) {
      id = weldedPositions.length / 3;
      welded.set(key, id);
      weldedPositions.push(x, y, z);
    }
    cornerVertex[corner] = id;
  }
  const vertexCount = weldedPositions.length / 3;

  const normals = new Float64Array(triangleCount * 3);
  const valid = new Uint8Array(triangleCount);
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const a = cornerVertex[triangle * 3] * 3;
    const b = cornerVertex[triangle * 3 + 1] * 3;
    const c = cornerVertex[triangle * 3 + 2] * 3;
    if (a === b || b === c || a === c) continue;
    const ux = weldedPositions[b] - weldedPositions[a];
    const uy = weldedPositions[b + 1] - weldedPositions[a + 1];
    const uz = weldedPositions[b + 2] - weldedPositions[a + 2];
    const vx = weldedPositions[c] - weldedPositions[a];
    const vy = weldedPositions[c + 1] - weldedPositions[a + 1];
    const vz = weldedPositions[c + 2] - weldedPositions[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    if (!(length > extent * extent * 1e-12)) continue;
    normals[triangle * 3] = nx / length;
    normals[triangle * 3 + 1] = ny / length;
    normals[triangle * 3 + 2] = nz / length;
    valid[triangle] = 1;
  }

  // Every welded edge and the triangles on it.
  const edgeKey = (a: number, b: number) => (a < b ? a * vertexCount + b : b * vertexCount + a);
  const firstTriangle = new Map<number, number>();
  const secondTriangle = new Map<number, number>();
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    if (!valid[triangle]) continue;
    for (let side = 0; side < 3; side += 1) {
      const key = edgeKey(cornerVertex[triangle * 3 + side], cornerVertex[triangle * 3 + ((side + 1) % 3)]);
      if (!firstTriangle.has(key)) firstTriangle.set(key, triangle);
      else if (!secondTriangle.has(key)) secondTriangle.set(key, triangle);
      else secondTriangle.set(key, -1); // more than two faces: always an edge
    }
  }

  const creaseCos = Math.cos(THREE.MathUtils.degToRad(SNAP_CREASE_ANGLE_DEGREES));
  const neighbours = new Int32Array(triangleCount * 3).fill(-1);
  const featureEdges: Array<[number, number]> = [];
  for (const [key, first] of firstTriangle) {
    const second = secondTriangle.get(key);
    const a = Math.floor(key / vertexCount);
    const b = key - a * vertexCount;
    let feature = second === undefined || second < 0;
    if (!feature && second !== undefined) {
      const dot = normals[first * 3] * normals[second * 3] + normals[first * 3 + 1] * normals[second * 3 + 1] + normals[first * 3 + 2] * normals[second * 3 + 2];
      feature = dot < creaseCos;
      if (!feature) {
        linkNeighbour(neighbours, cornerVertex, first, second, a, b);
        linkNeighbour(neighbours, cornerVertex, second, first, a, b);
      }
    }
    if (feature) featureEdges.push([a, b]);
  }

  const { paths, vertices } = chainFeatureEdges(featureEdges, weldedPositions, vertexCount);

  const regionIds = new Int32Array(triangleCount).fill(-1);
  const regions: number[][] = [];
  const regionOf = (seed: number) => {
    if (seed < 0 || seed >= triangleCount) return -1;
    if (regionIds[seed] >= 0) return regionIds[seed];
    const id = regions.length;
    const members: number[] = [];
    const stack = [seed];
    regionIds[seed] = id;
    while (stack.length > 0) {
      const triangle = stack.pop() as number;
      members.push(triangle);
      for (let side = 0; side < 3; side += 1) {
        const next = neighbours[triangle * 3 + side];
        if (next >= 0 && regionIds[next] < 0) {
          regionIds[next] = id;
          stack.push(next);
        }
      }
    }
    regions.push(members);
    return id;
  };
  const regionPositionCache = new Map<number, Float32Array>();
  const regionPositions = (region: number) => {
    const cachedPositions = regionPositionCache.get(region);
    if (cachedPositions) return cachedPositions;
    const members = regions[region] ?? [];
    const result = new Float32Array(members.length * 9);
    members.forEach((triangle, slot) => {
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = cornerVertex[triangle * 3 + corner] * 3;
        result[slot * 9 + corner * 3] = weldedPositions[vertex];
        result[slot * 9 + corner * 3 + 1] = weldedPositions[vertex + 1];
        result[slot * 9 + corner * 3 + 2] = weldedPositions[vertex + 2];
      }
    });
    regionPositionCache.set(region, result);
    return result;
  };

  const planarCache = new Map<number, boolean>();
  const regionIsPlanar = (region: number) => {
    const cachedPlanar = planarCache.get(region);
    if (cachedPlanar !== undefined) return cachedPlanar;
    const members = regions[region] ?? [];
    const first = members[0];
    const planar = first !== undefined && members.every((triangle) => (
      normals[triangle * 3] * normals[first * 3] + normals[triangle * 3 + 1] * normals[first * 3 + 1] + normals[triangle * 3 + 2] * normals[first * 3 + 2] > 0.99999
    ));
    planarCache.set(region, planar);
    return planar;
  };

  return { triangleCount, paths, vertices, regionOf, regionPositions, regionIsPlanar };
}

function linkNeighbour(neighbours: Int32Array, cornerVertex: Int32Array, triangle: number, other: number, a: number, b: number) {
  for (let side = 0; side < 3; side += 1) {
    const p = cornerVertex[triangle * 3 + side];
    const q = cornerVertex[triangle * 3 + ((side + 1) % 3)];
    if ((p === a && q === b) || (p === b && q === a)) {
      neighbours[triangle * 3 + side] = other;
      return;
    }
  }
}

/**
 * Joins the edge pieces into the edges a person would point at: a run goes on
 * through a corner where exactly two pieces meet without turning sharply, and
 * stops everywhere else. Where it stops is a vertex.
 */
function chainFeatureEdges(edges: Array<[number, number]>, positions: number[], vertexCount: number) {
  const incident = new Map<number, number[]>();
  edges.forEach(([a, b], edge) => {
    if (!incident.has(a)) incident.set(a, []);
    if (!incident.has(b)) incident.set(b, []);
    (incident.get(a) as number[]).push(edge);
    (incident.get(b) as number[]).push(edge);
  });
  const turnCos = Math.cos(THREE.MathUtils.degToRad(SNAP_CREASE_ANGLE_DEGREES));
  const isJoint = (vertex: number) => {
    const list = incident.get(vertex) ?? [];
    if (list.length !== 2) return true;
    const [e1, e2] = list;
    const p = edges[e1][0] === vertex ? edges[e1][1] : edges[e1][0];
    const q = edges[e2][0] === vertex ? edges[e2][1] : edges[e2][0];
    const ix = positions[vertex * 3] - positions[p * 3];
    const iy = positions[vertex * 3 + 1] - positions[p * 3 + 1];
    const iz = positions[vertex * 3 + 2] - positions[p * 3 + 2];
    const ox = positions[q * 3] - positions[vertex * 3];
    const oy = positions[q * 3 + 1] - positions[vertex * 3 + 1];
    const oz = positions[q * 3 + 2] - positions[vertex * 3 + 2];
    const lengths = Math.hypot(ix, iy, iz) * Math.hypot(ox, oy, oz);
    return !(lengths > 0) || (ix * ox + iy * oy + iz * oz) / lengths < turnCos;
  };

  const used = new Uint8Array(edges.length);
  const walk = (start: number, firstEdge: number) => {
    const chain = [start];
    let vertex = start;
    let edge = firstEdge;
    for (;;) {
      used[edge] = 1;
      const next = edges[edge][0] === vertex ? edges[edge][1] : edges[edge][0];
      chain.push(next);
      vertex = next;
      if (next === start || isJoint(next)) break;
      const onward = (incident.get(next) ?? []).find((candidate) => !used[candidate]);
      if (onward === undefined) break;
      edge = onward;
    }
    return chain;
  };

  const chains: number[][] = [];
  const joints = new Set<number>();
  for (const vertex of incident.keys()) {
    if (!isJoint(vertex)) continue;
    joints.add(vertex);
    for (const edge of incident.get(vertex) as number[]) {
      if (!used[edge]) chains.push(walk(vertex, edge));
    }
  }
  // What is left are loops without a single joint: circles and the like.
  edges.forEach(([a], edge) => {
    if (!used[edge]) chains.push(walk(a, edge));
  });

  const paths = chains.map((chain) => toPath(chain, positions));
  const vertices = new Float32Array(joints.size * 3);
  let slot = 0;
  for (const vertex of joints) {
    vertices[slot++] = positions[vertex * 3];
    vertices[slot++] = positions[vertex * 3 + 1];
    vertices[slot++] = positions[vertex * 3 + 2];
  }
  void vertexCount;
  return { paths, vertices };
}

function toPath(chain: number[], positions: number[]): SnapPath {
  const closed = chain.length > 3 && chain[0] === chain[chain.length - 1];
  const points = new Float32Array(chain.length * 3);
  chain.forEach((vertex, slot) => {
    points[slot * 3] = positions[vertex * 3];
    points[slot * 3 + 1] = positions[vertex * 3 + 1];
    points[slot * 3 + 2] = positions[vertex * 3 + 2];
  });
  const length = polylineLength(points);
  return {
    points,
    closed,
    length,
    midpoint: closed ? null : polylinePointAt(points, length / 2),
    centre: circleCentre(points, closed),
  };
}

export function polylineLength(points: ArrayLike<number>) {
  let length = 0;
  for (let offset = 0; offset + 5 < points.length; offset += 3) {
    length += Math.hypot(points[offset + 3] - points[offset], points[offset + 4] - points[offset + 1], points[offset + 5] - points[offset + 2]);
  }
  return length;
}

function polylinePointAt(points: ArrayLike<number>, distance: number): [number, number, number] {
  let travelled = 0;
  for (let offset = 0; offset + 5 < points.length; offset += 3) {
    const piece = Math.hypot(points[offset + 3] - points[offset], points[offset + 4] - points[offset + 1], points[offset + 5] - points[offset + 2]);
    if (travelled + piece >= distance && piece > 0) {
      const amount = (distance - travelled) / piece;
      return [
        points[offset] + (points[offset + 3] - points[offset]) * amount,
        points[offset + 1] + (points[offset + 4] - points[offset + 1]) * amount,
        points[offset + 2] + (points[offset + 5] - points[offset + 2]) * amount,
      ];
    }
    travelled += piece;
  }
  const last = points.length - 3;
  return [points[last], points[last + 1], points[last + 2]];
}

/**
 * The centre of an edge that is a circle or an arc: the circle through three
 * of its points, kept only if every other point lies on it and in its plane.
 * A straight or irregular edge has none.
 */
export function circleCentre(points: ArrayLike<number>, closed: boolean): [number, number, number] | null {
  const count = points.length / 3 - (closed ? 1 : 0);
  if (count < (closed ? 6 : 5)) return null;
  const at = (slot: number) => new THREE.Vector3(points[slot * 3], points[slot * 3 + 1], points[slot * 3 + 2]);
  const a = at(0);
  const b = at(closed ? Math.floor(count / 3) : Math.floor(count / 2));
  const c = at(closed ? Math.floor((2 * count) / 3) : count - 1);
  const ab = b.clone().sub(a);
  const ac = c.clone().sub(a);
  const normal = ab.clone().cross(ac);
  const normalLengthSq = normal.lengthSq();
  if (!(normalLengthSq > 1e-18)) return null;
  // Circumcentre of a, b, c.
  const centre = a.clone().add(
    normal.clone().cross(ab).multiplyScalar(ac.lengthSq())
      .add(ac.clone().cross(normal).multiplyScalar(ab.lengthSq()))
      .divideScalar(2 * normalLengthSq),
  );
  const radius = centre.distanceTo(a);
  if (!(radius > 0)) return null;
  const unitNormal = normal.normalize();
  const tolerance = radius * 0.015 + 1e-6;
  for (let slot = 0; slot < count; slot += 1) {
    const point = at(slot);
    if (Math.abs(point.distanceTo(centre) - radius) > tolerance) return null;
    if (Math.abs(point.clone().sub(centre).dot(unitNormal)) > tolerance) return null;
  }
  return [centre.x, centre.y, centre.z];
}
