import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { analyzeSnapGeometry, circleCentre, SNAP_TRIANGLE_LIMIT } from "@/lib/tapeSnap";

/** Rounds to 0.001 and turns -0 into 0, which toEqual would otherwise tell apart. */
function rounded(value: number) {
  const result = Math.round(value * 1000) / 1000;
  return Object.is(result, -0) ? 0 : result;
}

function vertexSet(vertices: Float32Array) {
  const keys = new Set<string>();
  for (let offset = 0; offset < vertices.length; offset += 3) {
    keys.add([vertices[offset], vertices[offset + 1], vertices[offset + 2]].map(rounded).join(","));
  }
  return keys;
}

describe("tape snap analysis", () => {
  it("finds the twelve edges, eight corners and six faces of a box", () => {
    const analysis = analyzeSnapGeometry(new THREE.BoxGeometry(20, 10, 4));
    expect(analysis).not.toBeNull();
    if (!analysis) return;
    expect(analysis.paths).toHaveLength(12);
    expect(analysis.paths.every((path) => !path.closed && path.points.length === 6)).toBe(true);
    expect(vertexSet(analysis.vertices)).toEqual(new Set([
      "-10,-5,-2", "-10,-5,2", "-10,5,-2", "-10,5,2", "10,-5,-2", "10,-5,2", "10,5,-2", "10,5,2",
    ]));
    const lengths = analysis.paths.map((path) => path.length).sort((a, b) => a - b);
    expect(lengths).toEqual([4, 4, 4, 4, 10, 10, 10, 10, 20, 20, 20, 20]);
    const midpoints = analysis.paths.map((path) => path.midpoint);
    expect(midpoints).toContainEqual([0, 5, 2]);

    const regions = new Set(Array.from({ length: analysis.triangleCount }, (_, triangle) => analysis.regionOf(triangle)));
    expect(regions.size).toBe(6);
    expect(analysis.regionPositions(analysis.regionOf(0))).toHaveLength(18);
  });

  it("finds the centres of a round cylinder's rims and keeps its side as one face", () => {
    const analysis = analyzeSnapGeometry(new THREE.CylinderGeometry(5, 5, 10, 64));
    expect(analysis).not.toBeNull();
    if (!analysis) return;
    const loops = analysis.paths.filter((path) => path.closed);
    expect(loops).toHaveLength(2);
    const centres = loops.map((path) => path.centre?.map(rounded));
    expect(centres).toContainEqual([0, 5, 0]);
    expect(centres).toContainEqual([0, -5, 0]);
    expect(analysis.vertices).toHaveLength(0);

    const regions = new Set(Array.from({ length: analysis.triangleCount }, (_, triangle) => analysis.regionOf(triangle)));
    expect(regions.size).toBe(3);
  });

  it("treats the facets of a coarse prism as real edges with corners", () => {
    const analysis = analyzeSnapGeometry(new THREE.CylinderGeometry(5, 5, 10, 6));
    expect(analysis).not.toBeNull();
    if (!analysis) return;
    expect(vertexSet(analysis.vertices).size).toBe(12);
    expect(analysis.paths.every((path) => path.centre === null)).toBe(true);
  });

  it("tells flat faces from curved ones, so only flat faces keep to the grid", () => {
    const box = analyzeSnapGeometry(new THREE.BoxGeometry(2, 2, 2));
    expect(box && box.regionIsPlanar(box.regionOf(0))).toBe(true);
    const cylinder = analyzeSnapGeometry(new THREE.CylinderGeometry(5, 5, 10, 64));
    expect(cylinder && cylinder.regionIsPlanar(cylinder.regionOf(0))).toBe(false);
  });

  it("gives a sphere no edges but one face", () => {
    const analysis = analyzeSnapGeometry(new THREE.SphereGeometry(5, 48, 32));
    expect(analysis?.paths ?? []).toHaveLength(0);
    if (!analysis) return;
    const regions = new Set(Array.from({ length: analysis.triangleCount }, (_, triangle) => analysis.regionOf(triangle)));
    expect(regions.size).toBe(1);
  });

  it("caches per geometry and recomputes when the positions change", () => {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const first = analyzeSnapGeometry(geometry);
    expect(analyzeSnapGeometry(geometry)).toBe(first);
    (geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    expect(analyzeSnapGeometry(geometry)).not.toBe(first);
  });

  it("skips meshes that are too dense to analyse while pointing", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array((SNAP_TRIANGLE_LIMIT + 1) * 9), 3));
    expect(analyzeSnapGeometry(geometry)).toBeNull();
  });

  it("finds the centre of an arc and rejects a wavy line", () => {
    const arc: number[] = [];
    for (let step = 0; step <= 8; step += 1) {
      const angle = (step / 8) * Math.PI / 2;
      arc.push(3 + 4 * Math.cos(angle), 1, -2 + 4 * Math.sin(angle));
    }
    expect(circleCentre(arc, false)?.map(rounded)).toEqual([3, 1, -2]);
    const wavy = arc.map((value, index) => (index % 3 === 1 ? value + (index % 2) * 0.5 : value));
    expect(circleCentre(wavy, false)).toBeNull();
  });
});
