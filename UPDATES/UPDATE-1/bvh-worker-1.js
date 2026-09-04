/**
 * BVH Background Worker — Multi-threaded binned-SAH BVH tree construction.
 *
 * Runs on a dedicated browser thread so the main thread never blocks or drops frames
 * during static scene acceleration tree generation.
 */

const BINS = 12;
const LEAF_SIZE = 6;
const TRAV_COST = 1.0;
const TRI_COST = 1.35;

function surfaceArea(minx, miny, minz, maxx, maxy, maxz) {
  const dx = maxx - minx, dy = maxy - miny, dz = maxz - minz;
  return 2 * (dx * dy + dy * dz + dz * dx);
}

function buildNodes(total, cent, taabb, triIndex, maxNodes) {
  const nodeBounds = new Float32Array(maxNodes * 6);
  const nodeMeta = new Int32Array(maxNodes * 2);

  let nodeCount = 1;
  nodeMeta[0] = 0;
  nodeMeta[1] = total;

  function nodeBoundsFromRange(node, start, count) {
    let mnx = Infinity, mny = Infinity, mnz = Infinity;
    let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (let i = start; i < start + count; i++) {
      const b = triIndex[i] * 6;
      if (taabb[b] < mnx) mnx = taabb[b];
      if (taabb[b + 1] < mny) mny = taabb[b + 1];
      if (taabb[b + 2] < mnz) mnz = taabb[b + 2];
      if (taabb[b + 3] > mxx) mxx = taabb[b + 3];
      if (taabb[b + 4] > mxy) mxy = taabb[b + 4];
      if (taabb[b + 5] > mxz) mxz = taabb[b + 5];
    }
    const p = 1e-5;
    const o = node * 6;
    nodeBounds[o] = mnx - p;
    nodeBounds[o + 1] = mny - p;
    nodeBounds[o + 2] = mnz - p;
    nodeBounds[o + 3] = mxx + p;
    nodeBounds[o + 4] = mxy + p;
    nodeBounds[o + 5] = mxz + p;
  }

  nodeBoundsFromRange(0, 0, total);

  const need = 4 * (2 * Math.ceil(total / LEAF_SIZE) + 64);
  const stack = new Int32Array(need);
  let sp = 0;
  stack[sp++] = 0; stack[sp++] = 0; stack[sp++] = total; stack[sp++] = 0;

  const binCount = new Int32Array(BINS);
  const binB = new Float32Array(BINS * 6);
  const leftArea = new Float32Array(BINS);
  const leftCnt = new Int32Array(BINS);
  let maxDepth = 0;

  while (sp > 0) {
    const depth = stack[--sp];
    const count = stack[--sp];
    const start = stack[--sp];
    const node = stack[--sp];
    if (depth > maxDepth) maxDepth = depth;
    if (count <= LEAF_SIZE || depth > 60) continue;

    const nb = node * 6;
    let cminx = Infinity, cminy = Infinity, cminz = Infinity;
    let cmaxx = -Infinity, cmaxy = -Infinity, cmaxz = -Infinity;
    for (let i = start; i < start + count; i++) {
      const t = triIndex[i] * 3;
      const x = cent[t], y = cent[t + 1], z = cent[t + 2];
      if (x < cminx) cminx = x; if (x > cmaxx) cmaxx = x;
      if (y < cminy) cminy = y; if (y > cmaxy) cmaxy = y;
      if (z < cminz) cminz = z; if (z > cmaxz) cmaxz = z;
    }
    const ex = cmaxx - cminx, ey = cmaxy - cminy, ez = cmaxz - cminz;
    let axis = 0, extent = ex, cmin = cminx;
    if (ey > extent) { axis = 1; extent = ey; cmin = cminy; }
    if (ez > extent) { axis = 2; extent = ez; cmin = cminz; }
    if (extent < 1e-7) continue;

    const scale = BINS / extent;
    binCount.fill(0);
    for (let b = 0; b < BINS; b++) {
      const o = b * 6;
      binB[o] = binB[o + 1] = binB[o + 2] = Infinity;
      binB[o + 3] = binB[o + 4] = binB[o + 5] = -Infinity;
    }
    for (let i = start; i < start + count; i++) {
      const tri = triIndex[i];
      let b = ((cent[tri * 3 + axis] - cmin) * scale) | 0;
      if (b < 0) b = 0; else if (b >= BINS) b = BINS - 1;
      binCount[b]++;
      const o = b * 6, tb = tri * 6;
      if (taabb[tb] < binB[o]) binB[o] = taabb[tb];
      if (taabb[tb + 1] < binB[o + 1]) binB[o + 1] = taabb[tb + 1];
      if (taabb[tb + 2] < binB[o + 2]) binB[o + 2] = taabb[tb + 2];
      if (taabb[tb + 3] > binB[o + 3]) binB[o + 3] = taabb[tb + 3];
      if (taabb[tb + 4] > binB[o + 4]) binB[o + 4] = taabb[tb + 4];
      if (taabb[tb + 5] > binB[o + 5]) binB[o + 5] = taabb[tb + 5];
    }

    let axmin = Infinity, aymin = Infinity, azmin = Infinity;
    let axmax = -Infinity, aymax = -Infinity, azmax = -Infinity;
    let acc = 0;
    for (let b = 0; b < BINS - 1; b++) {
      const o = b * 6;
      if (binCount[b] > 0) {
        if (binB[o] < axmin) axmin = binB[o];
        if (binB[o + 1] < aymin) aymin = binB[o + 1];
        if (binB[o + 2] < azmin) azmin = binB[o + 2];
        if (binB[o + 3] > axmax) axmax = binB[o + 3];
        if (binB[o + 4] > aymax) aymax = binB[o + 4];
        if (binB[o + 5] > azmax) azmax = binB[o + 5];
      }
      acc += binCount[b];
      leftCnt[b] = acc;
      leftArea[b] = acc > 0 ? surfaceArea(axmin, aymin, azmin, axmax, aymax, azmax) : 0;
    }

    axmin = aymin = azmin = Infinity;
    axmax = aymax = azmax = -Infinity;
    let rAcc = 0;
    let bestCost = TRI_COST * count;
    let bestSplit = -1;
    const parentArea = surfaceArea(
      nodeBounds[nb], nodeBounds[nb + 1], nodeBounds[nb + 2],
      nodeBounds[nb + 3], nodeBounds[nb + 4], nodeBounds[nb + 5]
    );
    const invParent = parentArea > 0 ? 1 / parentArea : 0;
    for (let b = BINS - 1; b > 0; b--) {
      const o = b * 6;
      if (binCount[b] > 0) {
        if (binB[o] < axmin) axmin = binB[o];
        if (binB[o + 1] < aymin) aymin = binB[o + 1];
        if (binB[o + 2] < azmin) azmin = binB[o + 2];
        if (binB[o + 3] > axmax) axmax = binB[o + 3];
        if (binB[o + 4] > aymax) aymax = binB[o + 4];
        if (binB[o + 5] > azmax) azmax = binB[o + 5];
      }
      rAcc += binCount[b];
      const lc = leftCnt[b - 1];
      if (lc === 0 || rAcc === 0) continue;
      const rArea = surfaceArea(axmin, aymin, azmin, axmax, aymax, azmax);
      const cost = TRAV_COST + TRI_COST * invParent * (leftArea[b - 1] * lc + rArea * rAcc);
      if (cost < bestCost) {
        bestCost = cost;
        bestSplit = b;
      }
    }
    if (bestSplit < 0) continue;

    const splitPos = cmin + extent * (bestSplit / BINS);
    let i = start, j = start + count - 1;
    while (i <= j) {
      const tri = triIndex[i];
      if (cent[tri * 3 + axis] < splitPos) i++;
      else { triIndex[i] = triIndex[j]; triIndex[j] = tri; j--; }
    }
    const leftCount = i - start;
    if (leftCount === 0 || leftCount === count) continue;

    const l = nodeCount;
    nodeCount += 2;
    nodeMeta[node * 2] = l;
    nodeMeta[node * 2 + 1] = 0;
    nodeMeta[l * 2] = start; nodeMeta[l * 2 + 1] = leftCount;
    nodeMeta[(l + 1) * 2] = i; nodeMeta[(l + 1) * 2 + 1] = count - leftCount;
    nodeBoundsFromRange(l, start, leftCount);
    nodeBoundsFromRange(l + 1, i, count - leftCount);

    stack[sp++] = l; stack[sp++] = start; stack[sp++] = leftCount; stack[sp++] = depth + 1;
    stack[sp++] = l + 1; stack[sp++] = i; stack[sp++] = count - leftCount; stack[sp++] = depth + 1;
  }

  return { nodeBounds, nodeMeta, triIndex, nodeCount, maxDepth };
}

self.onmessage = function (e) {
  const { taskId, type, payload } = e.data;
  if (type === 'build-bvh') {
    try {
      const { total, cent, taabb, triIndex, maxNodes } = payload;
      const res = buildNodes(total, cent, taabb, triIndex, maxNodes);
      self.postMessage(
        { taskId, success: true, result: res },
        [res.nodeBounds.buffer, res.nodeMeta.buffer, res.triIndex.buffer]
      );
    } catch (err) {
      self.postMessage({ taskId, success: false, error: err?.message ?? String(err) });
    }
  }
};
