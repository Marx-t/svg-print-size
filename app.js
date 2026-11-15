/**
 * SVG 打印尺寸计算器
 *
 * 原理：SVG 是矢量，本身没有"分辨率"。决定打多大才清楚的不是像素，
 * 而是「图里最细的结构在成品上还剩多少毫米」与「喷嘴实际线宽」的比值。
 *
 * 判据（Lumina Studio Wiki）：
 *   等效像素 ≈ 该边尺寸 ÷ 实际线宽
 *   等效 PPI ≈ 25.4 ÷ 实际线宽
 *
 * 本文件里的量为「用户单位」(SVG 自身坐标系)，显示时才换算成毫米。
 * 全部计算在浏览器本地完成，不发送任何数据。
 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const UNITS_MM = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, q: 0.25 };

const state = {
  name: '',
  text: '',
  meta: null,
  result: null,
  lineWidth: 0.42,
  pct: 15,
  bed: 250,
};

/* ------------------------------------------------------------------ *
 * 1. 读取 SVG 头部信息
 * ------------------------------------------------------------------ */

function parseMeta(text) {
  const rootMatch = text.match(/<svg\b[^>]*>/s);
  const rootTag = rootMatch ? rootMatch[0] : '';
  const attrs = {};
  for (const m of rootTag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) attrs[m[1]] = m[2];

  const len = (raw) => {
    if (!raw) return null;
    const m = String(raw).trim().match(/^(-?[\d.]+)\s*([a-z%]*)$/i);
    if (!m) return null;
    return { v: parseFloat(m[1]), unit: (m[2] || '').toLowerCase() };
  };

  const w = len(attrs.width);
  const h = len(attrs.height);
  const vb = attrs.viewBox
    ? attrs.viewBox.trim().split(/[\s,]+/).map(Number).filter((n) => !Number.isNaN(n))
    : null;

  const hasViewBox = !!(vb && vb.length === 4 && vb[2] > 0 && vb[3] > 0);

  let artW, artH;
  if (hasViewBox) {
    artW = vb[2];
    artH = vb[3];
  } else if (w && h) {
    artW = w.v;
    artH = h.v;
  } else {
    artW = 1000;
    artH = 1000;
  }

  // SVG 自带物理尺寸（带 mm/cm/in 等绝对单位时才成立）
  let physMm = null;
  if (w && h && UNITS_MM[w.unit] && UNITS_MM[h.unit]) {
    physMm = [w.v * UNITS_MM[w.unit], h.v * UNITS_MM[h.unit]];
  }

  const strokeWidths = [...text.matchAll(/stroke-width\s*[:=]\s*"?\s*([\d.]+)/g)]
    .map((m) => parseFloat(m[1]))
    .filter((n) => Number.isFinite(n) && n > 0);

  return {
    artW,
    artH,
    hasViewBox,
    viewBox: hasViewBox ? vb : [0, 0, artW, artH],
    physMm,
    paths: (text.match(/<path\b/g) || []).length,
    hasImage: /<image\b|data:image\/(png|jpe?g|webp)/i.test(text),
    hasFilter: /<filter\b|filter\s*[:=]\s*url\(/i.test(text),
    hasMaskClip: /<(mask|clipPath)\b/i.test(text),
    textCount: (text.match(/<text\b/g) || []).length,
    strokeWidths,
    rootTag,
  };
}

/* ------------------------------------------------------------------ *
 * 2. 栅格化（把矢量按目标像素画进 canvas）
 * ------------------------------------------------------------------ */

function rewriteRoot(text, meta, pxW, pxH, vb) {
  const { rootTag, viewBox } = meta;
  if (!rootTag) return text;
  // 去掉原有尺寸属性，并且一定要先摘掉结尾的 ">"，否则新属性会被拼到标签外面
  const cleaned = rootTag
    .replace(/\s(width|height|viewBox|preserveAspectRatio)\s*=\s*"[^"]*"/g, '')
    .replace(/\s*\/?>\s*$/, '');
  const injected = ` width="${pxW}" height="${pxH}" ` +
    `viewBox="${(vb || viewBox).join(' ')}" preserveAspectRatio="xMidYMid meet"`;
  const newTag = cleaned + injected + '>';
  return text.replace(rootTag, newTag);
}

async function rasterize(text, meta, pxW, pxH, vb) {
  const svg = rewriteRoot(text, meta, pxW, pxH, vb);
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'sync';
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('浏览器无法渲染这个 SVG'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = pxW;
    canvas.height = pxH;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, pxW, pxH);
    ctx.drawImage(img, 0, 0, pxW, pxH);
    return ctx.getImageData(0, 0, pxW, pxH).data;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ------------------------------------------------------------------ *
 * 3. 颜色量化 + 区域测量
 * ------------------------------------------------------------------ */

/**
 * 5 位/通道量化 → 15 位索引。
 * 抗锯齿会在边界上刷出一圈过渡色，若直接按"精确色"分区，
 * 一根 3px 的细线会被拆成两条 1px 的过渡带，细线宽度永远量成 2px。
 * 所以下一步要用调色板吸附把这些过渡色并回最近的实色。
 */
function quantize(data) {
  const n = data.length / 4;
  const idx = new Uint16Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    idx[i] = ((data[p] >> 3) << 10) | ((data[p + 1] >> 3) << 5) | (data[p + 2] >> 3);
  }
  return idx;
}

/**
 * 建立调色板并把每个像素吸附到最近的实色，返回标签图。
 * 最近色查找用 15 位 LUT（32768 项）预计算，逐像素只做一次数组访问。
 */
function snapToPalette(idx, w, h, maxColors = 48, minFrac = 0.0003) {
  const counts = new Uint32Array(32768);
  for (let i = 0; i < idx.length; i++) counts[idx[i]]++;

  const cand = [];
  for (let q = 0; q < 32768; q++) if (counts[q]) cand.push(q);
  cand.sort((a, b) => counts[b] - counts[a]);

  const total = w * h;
  const binRgb = (q) => [
    ((q >> 10) & 31) * 8 + 4,
    ((q >> 5) & 31) * 8 + 4,
    (q & 31) * 8 + 4,
  ];

  /**
   * 调色板必须去重。15 位量化会把同一块实色（渐变、抗锯齿、轻微色差）
   * 摊成十几个相邻色箱，每个色箱都够 0.03% 面积、都能进前 48 名。
   * 它们一旦各自成为独立区域，就互相咬合成 1–2 px 的碎带，
   * 量出来的"最细结构"恒等于栅格离散下限 2 px —— 于是任何图片
   * 都会得出同一个结论。所以先进后出按 RGB 距离合并近似色。
   */
  const MERGE_D2 = 26 * 26;
  const palette = [];
  const prgb = [];
  for (const q of cand) {
    if (counts[q] / total < minFrac) break; // cand 已按像素数降序
    if (palette.length >= maxColors) break;
    const c = binRgb(q);
    let dup = false;
    for (let p = 0; p < prgb.length; p++) {
      const dr = c[0] - prgb[p][0];
      const dg = c[1] - prgb[p][1];
      const db = c[2] - prgb[p][2];
      if (dr * dr + dg * dg + db * db < MERGE_D2) { dup = true; break; }
    }
    if (!dup) { palette.push(q); prgb.push(c); }
  }
  if (!palette.length) palette.push(cand[0]);

  // 调色板的真实 RGB（取量化中心）
  const rgb = palette.map((q) => [
    ((q >> 10) & 31) * 8 + 4,
    ((q >> 5) & 31) * 8 + 4,
    (q & 31) * 8 + 4,
  ]);

  const lut = new Uint8Array(32768);
  for (let q = 0; q < 32768; q++) {
    const r = ((q >> 10) & 31) * 8 + 4;
    const g = ((q >> 5) & 31) * 8 + 4;
    const b = (q & 31) * 8 + 4;
    let best = 0;
    let bestD = Infinity;
    for (let p = 0; p < rgb.length; p++) {
      const dr = r - rgb[p][0];
      const dg = g - rgb[p][1];
      const db = b - rgb[p][2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; best = p; }
    }
    lut[q] = best;
  }

  const labels = new Uint8Array(idx.length);
  for (let i = 0; i < idx.length; i++) labels[i] = lut[idx[i]];

  // 每类的像素数与外接框
  const stats = palette.map((q, i) => ({
    index: i,
    color: '#' + ((rgb[i][0] >> 3) << 3).toString(16).padStart(2, '0')
                + ((rgb[i][1] >> 3) << 3).toString(16).padStart(2, '0')
                + ((rgb[i][2] >> 3) << 3).toString(16).padStart(2, '0'),
    count: 0, x0: w, x1: -1, y0: h, y1: -1,
  }));
  for (let y = 0; y < h; y++) {
    const off = y * w;
    for (let x = 0; x < w; x++) {
      const s = stats[labels[off + x]];
      s.count++;
      if (x < s.x0) s.x0 = x;
      if (x > s.x1) s.x1 = x;
      if (y < s.y0) s.y0 = y;
      if (y > s.y1) s.y1 = y;
    }
  }
  stats.sort((a, b) => b.count - a.count);
  for (const s of stats) s.areaFrac = s.count / total;
  return { labels, stats };
}

/** 一维平方距离变换（Felzenszwalb & Huttenlocher） */
function dt1d(f, n, d, v, z) {
  const INF = 1e20;
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/** 对 mask（1=区域内）做欧氏距离变换，返回区域内每点到边界外的距离（px） */
function edt(mask, w, h) {
  const INF = 1e20;
  const out = new Float64Array(w * h);
  const f = new Float64Array(Math.max(w, h));
  const d = new Float64Array(Math.max(w, h));
  const v = new Int32Array(Math.max(w, h));
  const z = new Float64Array(Math.max(w, h) + 2);

  for (let y = 0; y < h; y++) {
    const off = y * w;
    for (let x = 0; x < w; x++) f[x] = mask[off + x] ? INF : 0;
    dt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[off + x] = d[x];
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = out[y * w + x];
    dt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) out[y * w + x] = Math.sqrt(d[y]);
  }
  return out;
}

const pct = (arr, p) => {
  if (!arr.length) return NaN;
  const a = arr.length > 40000 ? arr.filter((_, i) => i % Math.ceil(arr.length / 40000) === 0) : arr;
  const s = Float64Array.from(a).sort();
  const idx = Math.min(s.length - 1, Math.max(0, (p / 100) * (s.length - 1)));
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
};

/**
 * 逐色块测量"墨宽"分布：区域内距离变换的脊点（局部极大）≈ 中轴线，
 * 2×距离 就是该点的色块宽度。取分位数得到 最细 / 中位 / 最粗。
 */
function measureRegions(labels, stats, w, h, pxPerUnit, pctValue = 15, minAreaFrac = 0.0004, skipLargest = true) {
  const out = [];
  let budget = 60e6; // 距离变换的像素预算，防止极端图卡死
  const hexToRgb = (hex) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];

  /** 该区域颜色是否只是两种相邻色的抗锯齿混合（两侧异色、自身在连线中间） */
  const isAntialiasBand = (rec, neighborIds) => {
    if (neighborIds.size < 2) return false;
    const me = hexToRgb(rec.color);
    const ids = [...neighborIds];
    for (let j = 0; j < ids.length; j++) {
      for (let k = j + 1; k < ids.length; k++) {
        const a = hexToRgb(stats[ids[j]].color);
        const b = hexToRgb(stats[ids[k]].color);
        const vx = b[0] - a[0], vy = b[1] - a[1], vz = b[2] - a[2];
        const len2 = vx * vx + vy * vy + vz * vz;
        if (len2 < 900) continue;
        const t = ((me[0] - a[0]) * vx + (me[1] - a[1]) * vy + (me[2] - a[2]) * vz) / len2;
        if (t <= 0.15 || t >= 0.85) continue;
        const d0 = me[0] - (a[0] + t * vx);
        const d1 = me[1] - (a[1] + t * vy);
        const d2 = me[2] - (a[2] + t * vz);
        if (Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2) < 22) return true;
      }
    }
    return false;
  };

  /**
   * 「最细结构」不能直接取脊点宽度的低分位数：任何带尖角的形状，
   * 其中轴线都会向尖角分叉，分叉上的宽度一路趋近 0。这些点数量可观，
   * 却根本不是要印出来的笔画（FDM 会把尖角自然磨圆，没人看得出差别）。
   * 低分位数还会被抗锯齿留下的 1px 碎片的宽度下限钉死，
   * 于是测出来的永远是栅格分辨率，而不是图本身。
   *
   * 做法：升序扫描脊点宽度，取「宽度带内点数达到总点数 massFrac」的最小宽度。
   * 也就是说，只统计真正占了一定量"笔画长度"的宽度 —— 尖角分叉和
   * 零星碎片因为带宽内点数太少，被排除。
   */
  const significantThin = (ws, idxs, massFrac) => {
    const n = ws.length;
    const need = Math.max(6, Math.ceil(massFrac * n));
    let j0 = 0;
    let j1 = 0;
    for (let i = 0; i < n; i++) {
      const wv = ws[i];
      if (!(wv > 0)) continue;
      while (j0 < n && ws[j0] < wv * 0.85) j0++;
      while (j1 < n && ws[j1] <= wv * 1.18) j1++;
      if (j1 - j0 >= need) return { w: wv, at: idxs[i] };
    }
    return { w: ws[n - 1], at: idxs[n - 1] };
  };

  for (let li = 0; li < stats.length && out.length < 24; li++) {
    const rec = stats[li];
    if (li === 0 && skipLargest) continue;         // 最大面积色视为底/背景
    const frac = rec.areaFrac;
    if (frac < minAreaFrac) continue;

    const bw = rec.x1 - rec.x0 + 1;
    const bh = rec.y1 - rec.y0 + 1;
    const area = bw * bh;
    if (area > budget && out.length >= 4) continue;
    budget -= area;

    // 外接框内提取掩膜（补一圈 0，保证边界效应正确）
    const mw = bw + 2;
    const mh = bh + 2;
    const mask = new Uint8Array(mw * mh);
    let any = false;
    for (let y = rec.y0; y <= rec.y1; y++) {
      const rowOff = y * w;
      const mRow = (y - rec.y0 + 1) * mw + 1;
      for (let x = rec.x0; x <= rec.x1; x++) {
        if (labels[rowOff + x] === rec.index) {
          mask[mRow + (x - rec.x0)] = 1;
          any = true;
        }
      }
    }
    if (!any) continue;

    /*
     * 只保留成片的像素。抗锯齿和渐变的过渡色经常以 1–2px 的碎点形式撒满画面，
     * 每块碎点的"宽度"恒等于栅格离散下限，会把最细结构永远钉在同一个数上。
     * 真实笔画则总是连成长条。这里按 4 邻接找连通块，面积不足最大块 2% 的丢掉。
     */
    if (area <= 8e6) {
      const comp = new Int32Array(mw * mh).fill(-1);
      const stack = new Int32Array(mw * mh);
      const compArea = [];
      const compCore = [];
      for (let y = 1; y < mh - 1; y++) {
        for (let x = 1; x < mw - 1; x++) {
          const s0 = y * mw + x;
          if (!mask[s0] || comp[s0] >= 0) continue;
          const id = compArea.length;
          let sp = 0;
          stack[sp++] = s0;
          comp[s0] = id;
          let n = 0;
          while (sp) {
            const pp = stack[--sp];
            n++;
            const px = pp % mw;
            const py = (pp - px) / mw;
            let q;
            if (px > 0) { q = pp - 1; if (mask[q] && comp[q] < 0) { comp[q] = id; stack[sp++] = q; } }
            if (px < mw - 1) { q = pp + 1; if (mask[q] && comp[q] < 0) { comp[q] = id; stack[sp++] = q; } }
            if (py > 0) { q = pp - mw; if (mask[q] && comp[q] < 0) { comp[q] = id; stack[sp++] = q; } }
            if (py < mh - 1) { q = pp + mw; if (mask[q] && comp[q] < 0) { comp[q] = id; stack[sp++] = q; } }
          }
          compArea.push(n);
          compCore.push(0);
        }
      }
      // 标记每个连通块里是否存在「实心内核」像素（上下左右四个邻居同块）
      for (let y = 1; y < mh - 1; y++) {
        for (let x = 1; x < mw - 1; x++) {
          const i = y * mw + x;
          if (!mask[i]) continue;
          const c = comp[i];
          if (compCore[c]) continue;
          if (comp[i - 1] === c && comp[i + 1] === c && comp[i - mw] === c && comp[i + mw] === c) compCore[c] = 1;
        }
      }
      let maxA = 0;
      for (const a of compArea) if (a > maxA) maxA = a;
      const keep = Math.max(6, maxA * 0.02);
      const total = w * h;
      let kept = 0;
      for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        const c = comp[i];
        const ok = compArea[c] >= keep && (compCore[c] || compArea[c] >= total * 0.0005);
        if (!ok) mask[i] = 0;
        else kept++;
      }
      if (kept < 6) continue; // 整块都是碎点 → 不是要印的结构
    }

    const dist = edt(mask, mw, mh);
    const widths = [];
    const ridgeX = [];
    const ridgeY = [];
    for (let y = 1; y < mh - 1; y++) {
      for (let x = 1; x < mw - 1; x++) {
        const c = dist[y * mw + x];
        if (c <= 0) continue;
        // 3×3 局部极大 → 脊点
        let isMax = true;
        for (let dy = -1; dy <= 1 && isMax; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            if (dist[(y + dy) * mw + (x + dx)] > c) {
              isMax = false;
              break;
            }
          }
        }
        if (isMax) {
          widths.push((2 * c) / pxPerUnit);
          ridgeX.push(rec.x0 + x - 1);
          ridgeY.push(rec.y0 + y - 1);
        }
      }
    }
    if (widths.length < 6) continue;

    // 细而小的色块要额外判断：它可能是抗锯齿过渡带，而不是画面内容
    const medianPx = pct(widths, 50) * pxPerUnit;
    let suspect = false;
    // 只要这条色带本身很薄（<3.5px），且颜色确实落在两个邻色的连线上，
    // 就当作抗锯齿/渐变过渡带剔掉——不管它占多大面积。渐变大色块
    // 在很多设计稿里就是这样被切成几十条 1–2px 的假"细线"的。
    if (medianPx <= 3.5) {
      const neighbors = new Set();
      const yA = Math.max(0, rec.y0 - 2), yB = Math.min(h - 1, rec.y1 + 2);
      const xA = Math.max(0, rec.x0 - 2), xB = Math.min(w - 1, rec.x1 + 2);
      for (let y = yA; y <= yB; y++) {
        const off = y * w;
        for (let x = xA; x <= xB; x++) {
          const l = labels[off + x];
          if (l !== rec.index) neighbors.add(l);
        }
      }
      if (isAntialiasBand(rec, neighbors)) suspect = true;
    }

    // 显著最细宽度 + 它落在哪个脊点上（精测要以该点为圆心放大）
    const step = widths.length > 40000 ? Math.ceil(widths.length / 40000) : 1;
    const order = [];
    for (let i = 0; i < widths.length; i += step) order.push(i);
    order.sort((a, b) => widths[a] - widths[b]);
    const sortedW = order.map((i) => widths[i]);
    const massFrac = Math.max(0.004, Math.min(0.2, pctValue / 500));
    const pickSig = significantThin(sortedW, order, massFrac);

    // 同一色块里常并存几种线宽（细线 + 粗块），只挑一个点会漏掉更细的，
    // 所以给出最多 3 个空间上分散的「最细候选点」，交给精测逐个确认。
    const thinCands = [];
    {
      const cap = pickSig.w * 2.4;
      const minDist = Math.max(8, w * 0.06);
      let lx = -1e9;
      let ly = -1e9;
      const add = (i) => {
        const x = ridgeX[i];
        const y = ridgeY[i];
        if (thinCands.length && Math.hypot(x - lx, y - ly) < minDist) return;
        thinCands.push({ w: widths[i], at: [x, y] });
        lx = x;
        ly = y;
      };
      add(pickSig.at);
      for (let k = 0; k < order.length && thinCands.length < 2; k++) {
        const i = order[k];
        if (widths[i] > cap) break;
        add(i);
      }
    }

    out.push({
      color: rec.color,
      index: rec.index,
      suspect,
      areaFrac: frac,
      thin: pickSig.w,
      thinCoarse: pickSig.w,
      median: medianPx / pxPerUnit,
      thick: pct(widths, 95),
      thinAt: [ridgeX[pickSig.at], ridgeY[pickSig.at]],
      thinCands,
      bbox: [rec.x0, rec.y0, rec.x1, rec.y1],
    });
  }

  out.sort((a, b) => b.areaFrac - a.areaFrac);
  return out;
}

/* ------------------------------------------------------------------ *
 * 4. 主分析
 * ------------------------------------------------------------------ */

async function analyse(text, { pctValue = 15 } = {}) {
  const meta = parseMeta(text);
  const artW = meta.artW;
  const ar = meta.artH / artW;
  const longU = Math.max(meta.artW, meta.artH);

  let longPx = 1600;
  let best = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const pxW = Math.max(64, Math.round(ar <= 1 ? longPx : longPx / ar));
    const pxH = Math.max(64, Math.round(pxW * ar));
    const data = await rasterize(text, meta, pxW, pxH);
    const pxPerUnit = pxW / artW;
    const idx = quantize(data);
    const { labels, stats } = snapToPalette(idx, pxW, pxH);
    const regions = measureRegions(labels, stats, pxW, pxH, pxPerUnit, pctValue);
    const thin = regions.length ? Math.min(...regions.map((r) => r.thin)) : NaN;
    best = { pxW, pxH, pxPerUnit, regions, thin };

    // 最细结构不足 ~3px 时，量到的全是栅格离散误差，加一次密度重测
    if (!Number.isFinite(thin) || thin * pxPerUnit >= 3 || longPx >= 2200) break;
    longPx = 2200;
  }

  const { pxW, pxH, pxPerUnit } = best;
  let regions = best.regions;

/**
   * 精测：围绕候选的最细点开小窗口放大，直到数值收敛。
   *  - 窗口只取候选点周围 12 倍宽度，放大倍率因此可以远超整图栅格；
   *  - 放大后若仍只有 ~2px 宽，说明那不是能被印出来的实色结构
   *    （渐变过渡带 / 抗锯齿残留 / 采样噪点），判掉；
   *  - 收敛判据：相邻两轮相对变化 < 20%；
   *  - 返回 null 表示这次没能放大（受画布上限限制），数值不可信。
   */
  const rgbOf = (h) => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];

  const pickNearest = (cands, hex) => {
    const t = rgbOf(hex);
    let bestR = null;
    let bestD = Infinity;
    for (const c of cands) {
      const q = rgbOf(c.color);
      const d = (q[0] - t[0]) ** 2 + (q[1] - t[1]) ** 2 + (q[2] - t[2]) ** 2;
      if (d < bestD - 1e-9) { bestD = d; bestR = c; }
      else if (Math.abs(d - bestD) < 1e-9 && c.areaFrac > bestR.areaFrac) bestR = c;
    }
    if (bestR && bestD < 576) return bestR;
    return null; // 颜色对不上就不猜，避免量到抗锯齿过渡色
  };

  // 精测的总光栅化次数上限：大文件上每次都很贵，按文件体积收紧
  let refineBudget = text.length > 2e6 ? 6 : 16;
  const refineAt = async (colorHex, atPx, guess) => {
    if (refineBudget <= 0) return null;
    let cur = guess;
    let scale = pxPerUnit;
    let atU = [
      meta.viewBox[0] + (atPx[0] + 0.5) / pxPerUnit,
      meta.viewBox[1] + (atPx[1] + 0.5) / pxPerUnit,
    ];
    let ran = 0;
    for (let it = 0; it < 4; it++) {
      const winU = Math.max(cur * 12, longU * 0.0012);
      let s = Math.min(60 / Math.max(cur, 1e-9), 3000);
      s = Math.min(s, Math.sqrt(1.2e6) / winU);
      if (!(s > scale * 1.05)) break;
      const vb = [atU[0] - winU / 2, atU[1] - winU / 2, winU, winU];
      const cpx = Math.max(48, Math.round(winU * s));
      const sActual = cpx / winU;
      if (refineBudget <= 0) break;
      refineBudget--;
      try {
        const cdata = await rasterize(text, meta, cpx, cpx, vb);
        const csnap = snapToPalette(quantize(cdata), cpx, cpx);
        const cregions = measureRegions(csnap.labels, csnap.stats, cpx, cpx, sActual, pctValue, 0.0004, false);
        if (!cregions.length) break;
        // 优先按「窗口中心是什么颜色」来认结构：细结构在粗栅格里常被抗锯齿
        // 混成中间色，颜色对不上，但它就在窗口正中心。
        const c0 = cpx >> 1;
        const centerLabel = csnap.labels[c0 * cpx + c0];
        const centerReg = cregions.find((r) => r.index === centerLabel);
        const bgColor = cregions.reduce((a, b) => (a.areaFrac >= b.areaFrac ? a : b)).color;
        let main = null;
        if (centerReg) {
          const a = rgbOf(centerReg.color);
          const b = rgbOf(bgColor);
          const d2 = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
          if (d2 > 3600) main = centerReg; // 和背景分得开，认它
        }
        if (!main) main = pickNearest(cregions, colorHex);
        if (!main) return null;
        // 窗口正对着这个结构：中心附近必须确实是它，否则说明量偏了
        let hit = 0;
        let tot = 0;
        for (let dy = -3; dy <= 3; dy++) {
          for (let dx = -3; dx <= 3; dx++) {
            const xx = c0 + dx;
            const yy = c0 + dy;
            if (xx < 0 || yy < 0 || xx >= cpx || yy >= cpx) continue;
            tot++;
            if (csnap.labels[yy * cpx + xx] === main.index) hit++;
          }
        }
        if (!tot || hit / tot < 0.25) return null;
        // 放大到这么细还是 1–2px，本身没有宽度可言
        if (main.thin * sActual < 2.6) return null;
        ran++;
        const rel = Math.abs(main.thin - cur) / Math.max(cur, 1e-9);
        cur = main.thin;
        scale = sActual;
        atU = [
          vb[0] + (main.thinAt[0] + 0.5) / sActual,
          vb[1] + (main.thinAt[1] + 0.5) / sActual,
        ];
        if (rel < 0.2) return { w: cur };
      } catch {
        break;
      }
    }
    return ran ? { w: cur } : null;
  };

  if (regions.length) {
    // 收集全图的候选最细点，只精测最细的一批（够判定即可，避免大图卡顿）
    const cands = [];
    for (const r of regions) {
      for (const c of r.thinCands || []) cands.push({ r, w: c.w, at: c.at, color: r.color });
    }
    // 实色结构优先；可疑的过渡带排在后面，最多 3 个，靠精测决定去留
    cands.sort((a, b) => (a.r.suspect === b.r.suspect ? a.w - b.w : a.r.suspect ? 1 : -1));
    const todo = [];
    let suspectUsed = 0;
    for (const c of cands) {
      if (todo.length >= 10) break;
      if (c.r.suspect) {
        if (suspectUsed >= 3) continue;
        suspectUsed++;
      }
      todo.push(c);
    }
    for (const c of todo) {
      let v = await refineAt(c.color, c.at, c.w);
      if (v) {
        // 只约束下界：粗测因为抗锯齿/量化最多偏胖 ~1.5px，所以真实宽度
        // 不可能比 (粗测 − 1.5px) 还细。比这更细的，是在窗口里认错了结构。
        // 上界不设——粗测偏瘦（边缘被并走、细的地方被离散成 2px）正是精测
        // 存在的理由，压住上界就把真正的修正一起压掉了。
        const lo = Math.max(0.5, c.w * pxPerUnit - 1.5);
        if (!(v.w * pxPerUnit >= lo)) v = null;
      }
      if (v && Number.isFinite(v.w) && v.w > 0) {
        c.r.vals = c.r.vals || [];
        c.r.vals.push(v.w);
      }
    }
    for (const r of regions) {
      const base = r.thinCoarse;
      if (r.vals && r.vals.length) {
        r.thin = Math.min(...r.vals);
        r.refined = true;
      } else if (r.suspect || base * pxPerUnit < 3.5) {
        // 粗测就只有 1–2px，精测又没能确认它 —— 那是抗锯齿/渐变的碎边，
        // 不是要印的结构。留着它会把结论永远钉在栅格离散下限上。
        r.drop = true;
      } else {
        r.thin = base; // 本身就够粗，粗测值不受离散误差影响
      }
      const k = Number.isFinite(r.thin) && base > 0 ? r.thin / base : 1;
      r.median *= k;
      r.thick *= k;
    }
    const kept = regions.filter((r) => !r.drop && Number.isFinite(r.thin) && r.thin > 0);
    if (kept.length) regions = kept;
  }

  const refined = regions.length ? Math.min(...regions.map((r) => r.thin)) : NaN;
  const winner = regions.length
    ? regions.reduce((a, b) => (a.thin <= b.thin ? a : b))
    : null;
  // 被剔掉的碎边若成了唯一候选，说明整张图没有更清晰的结构可量
  const gridLimited = !!(winner && (winner.gridLimited || winner.drop));
  // 典型线条：按面积加权的中位数
  let med = NaN;
  if (regions.length) {
    const tot = regions.reduce((s, r) => s + r.areaFrac, 0);
    const sorted = [...regions].sort((a, b) => a.median - b.median);
    let acc = 0;
    for (const r of sorted) {
      acc += r.areaFrac / tot;
      if (acc >= 0.5) { med = r.median; break; }
    }
  }

  return {
    meta,
    regions,
    finest: refined,
    ok: Number.isFinite(refined) && refined > 0,
    typical: med,
    fracFinest: refined / longU,
    longU,
    gridLimited,
    pxW,
    pxH,
    pxPerUnit,
    regionCount: regions.length,
  };
}
/* ------------------------------------------------------------------ *
 * 5. 判定
 * ------------------------------------------------------------------ */

const VERDICTS = [
  { min: 2.0, cls: 'b-ok', text: '很稳，细节完整' },
  { min: 1.5, cls: 'b-ok', text: '可以，细节保得住' },
  { min: 1.0, cls: 'b-mid', text: '勉强，最细处会变粗' },
  { min: 0.6, cls: 'b-mid', text: '偏小，细线会断/丢' },
  { min: 0, cls: 'b-bad', text: '太小，细处会糊在一起' },
];

const verdictFor = (ratio) => VERDICTS.find((v) => ratio >= v.min);

function neededLongEdge(res, k, lineWidth) {
  if (!res.fracFinest || !Number.isFinite(res.fracFinest)) return NaN;
  return (k * lineWidth) / res.fracFinest;
}

/* ------------------------------------------------------------------ *
 * 6. 渲染
 * ------------------------------------------------------------------ */

function fmt(n, d = 0) {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(d);
}

function ratioLabel(w, h) {
  const r = w / h;
  const known = [[16, 9], [4, 3], [3, 2], [1, 1], [5, 4], [21, 9], [2, 1], [9, 16], [3, 4], [2, 3], [9, 21]];
  for (const [a, b] of known) {
    if (Math.abs(r - a / b) < 0.01 * (a / b)) return `${a}:${b}`;
  }
  return r.toFixed(2) + ' : 1';
}

function render() {
  const res = state.result;
  if (!res) return;
  const { meta } = res;
  const lw = state.lineWidth;

  $('#empty').hidden = true;
  $('#out').hidden = false;

  if (!res.ok) {
    $('#warn').hidden = false;
    $('#warn').innerHTML = '<strong>没量到可印的细结构</strong>：这张图不是纯色大色块，'
      + '就是全靠渐变/柔和过渡堆出来的（渐变里没有"一条线"，只有一档档的色阶）。'
      + '这种情况下尺寸按用途定就行——看它挂多远，或者和别的件对齐。';
    $('#stats').innerHTML = '';
    $('#table tbody').innerHTML = '';
    $('#tiers').innerHTML = '';
    $('#tile').innerHTML = '';
    $('#colors tbody').innerHTML = '';
    return;
  }

  /* ---- 警告 ---- */
  const warns = [];
  if (res.gridLimited) warns.push('这张图最细的结构已到测量下限（约 1/1000 画板长边）：下面的尺寸是<b>下限</b>，真打出来只会更糊，不会更清楚。');
  if (meta.hasImage) warns.push('文件里嵌了位图（&lt;image&gt;），真实细节上限由那张位图决定，SVG 外壳救不了它。');
  if (meta.hasFilter) warns.push('含 &lt;filter&gt;（阴影/模糊等）：大画幅分块时可能退回栅格分片，细节会受影响。');
  if (meta.hasMaskClip) warns.push('含 mask/clipPath：部分切片或分块流程可能不支持，建议先在软件里预览。');
  if (meta.textCount > 0) warns.push(`含 ${meta.textCount} 个文字元素：浏览器用的是本机字体，Lumina/SVG 导入可能换字体，字号需单独确认。`);
  const warnEl = $('#warn');
  if (warns.length) {
    warnEl.hidden = false;
    warnEl.innerHTML = '<strong>注意</strong><ul>' + warns.map((w) => `<li>${w}</li>`).join('') + '</ul>';
  } else {
    warnEl.hidden = true;
  }

  /* ---- 关键指标 ---- */
  const stats = [
    ['画板比例', ratioLabel(meta.artW, meta.artH), `${fmt(meta.artW)} × ${fmt(meta.artH)} 单位`],
    [
      '最细结构',
      `${res.gridLimited ? '≈ ' : ''}${fmt(res.finest, 2)}<small> 单位</small>`,
      `${res.gridLimited ? '已到测量下限，' : ''}占长边 ${(res.fracFinest * 100).toFixed(2)}%`,
    ],
    ['典型线条', `${fmt(res.typical, 1)}<small> 单位</small>`, '面积加权中位'],
    ['色块数', `${res.regionCount}`, '面积 ≥0.04% 的独立色'],
  ];
  if (meta.physMm) {
    stats.push(['自带物理尺寸', `${fmt(meta.physMm[0])}<small> × ${fmt(meta.physMm[1])} mm</small>`, '作者已定尺寸']);
  }
  if (meta.strokeWidths.length) {
    const min = Math.min(...meta.strokeWidths);
    stats.push(['最细 stroke', `${min}<small> 单位</small>`, `共 ${meta.strokeWidths.length} 处描边`]);
  }
  $('#stats').innerHTML = stats
    .map(([k, v, d]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div><div class="k">${d}</div></div>`)
    .join('');

  /* ---- 尺寸表 ---- */
  const need1 = neededLongEdge(res, 1.0, lw);
  const need15 = neededLongEdge(res, 1.5, lw);
  const need2 = neededLongEdge(res, 2.0, lw);
  const ar = meta.artH / meta.artW;

  const maxRow = Math.max(120, Math.min(1200, need2 * 1.4));
  const fixed = [40, 60, 80, 100, 120, 150, 180, 200, 250, 300, 400, 500, 600, 800, 1000];
  const rows = fixed.filter((L) => L >= 30 && L <= maxRow);
  if (rows.length < 4) rows.push(...[60, 100, 150, 200].filter((L) => !rows.includes(L)));
  rows.sort((a, b) => a - b);

  const tbody = $('#table tbody');
  tbody.innerHTML = rows
    .map((L) => {
      const short = ar <= 1 ? L * ar : L / ar;
      const thinMm = res.fracFinest * L;
      const ratio = thinMm / lw;
      const v = verdictFor(ratio);
      const mark = ratio >= 2 && ratio < 2.6 ? ' style="background:#f6faff"' : '';
      return `<tr${mark}>
        <td class="num">${L} mm</td>
        <td class="num">${fmt(short)} mm</td>
        <td class="num">${thinMm.toFixed(2)} mm</td>
        <td class="num">${ratio.toFixed(2)}×</td>
        <td><span class="badge ${v.cls}">${v.text}</span></td>
      </tr>`;
    })
    .join('');

  /* ---- 反推三档 ---- */
  const tiers = [
    { label: '不丢细节（下限）', v: need1, d: '最细处刚好一个线宽，再小就合并' },
    { label: '推荐', v: need15, d: '1.5 个线宽，切出来看得清', pick: true },
    { label: '舒服', v: need2, d: '2 个线宽，远看近看都干净' },
  ];
  $('#tiers').innerHTML = tiers
    .map((t) => {
      const short = ar <= 1 ? t.v * ar : t.v / ar;
      return `<div class="tier${t.pick ? ' pick' : ''}">
        <div class="t">${t.label}</div>
        <div class="v">长边 ${fmt(t.v)} mm</div>
        <div class="d">≈ ${fmt(t.v)} × ${fmt(short)} mm · ${t.d}</div>
      </div>`;
    })
    .join('');

  /* ---- 分块提示 ---- */
  const bed = state.bed;
  const tilesFor = (L) => {
    const w = L;
    const hh = ar <= 1 ? L * ar : L / ar;
    const cols = Math.ceil(w / bed);
    const rowsN = Math.ceil(hh / bed);
    return { cols, rowsN, total: cols * rowsN, w, h: hh };
  };
  const tRec = tilesFor(need15);
  const tileEl = $('#tile');
  if (need1 < 30) {
    tileEl.innerHTML = `<span class="muted">数学上很小的尺寸就够（这张图没有比线宽细的结构）。
      实际仍建议 ≥ 30–40 mm：太小的件在喷嘴起停、冷却和结构强度上都容易出问题。</span>`;
  } else if (tRec.total <= 1) {
    tileEl.innerHTML = `推荐尺寸 <b>${fmt(tRec.w)} × ${fmt(tRec.h)} mm</b> 在 ${bed} mm 热床内可以一次打完。`;
  } else {
    tileEl.innerHTML = `推荐尺寸 <b>${fmt(tRec.w)} × ${fmt(tRec.h)} mm</b> 放不进 ${bed} mm 热床：
      需要 <b>${tRec.cols} × ${tRec.rowsN} = ${tRec.total} 块</b>大画幅分片，
      打印后按 R1C1… 坐标拼接（Lumina 只切不生成榫卯，拼缝要自己对齐）。`;
  }

  /* ---- 逐色块明细 ---- */
  $('#colors tbody').innerHTML = res.regions
    .slice(0, 16)
    .map(
      (r) => `<tr>
        <td><span class="swatch" style="background:${r.color}"></span>${r.color}</td>
        <td class="num">${(r.areaFrac * 100).toFixed(2)}%</td>
        <td class="num">${r.thin.toFixed(2)}</td>
        <td class="num">${r.median.toFixed(2)}</td>
        <td class="num">${r.thick.toFixed(2)}</td>
      </tr>`
    )
    .join('');

  /* ---- 元信息面板 ---- */
  const metaEl = $('#meta');
  metaEl.hidden = false;
  metaEl.innerHTML = [
    ['文件', state.name || '示例'],
    ['栅格化', `${res.pxW} × ${res.pxH} px（${res.pxPerUnit.toFixed(2)} px/单位）`],
    ['线宽', `${lw} mm`],
  ]
    .map(([k, v]) => `<div class="row"><span>${k}</span><b>${v}</b></div>`)
    .join('');

  // 记住结论，供复制
  state.summary = { need1, need15, need2, ar, rows, lw };
  updateAsk();
}

function updateAsk() {
  const res = state.result;
  const el = $('#askOut');
  if (!res) return;
  const v = parseFloat($('#askW').value);
  if (!Number.isFinite(v) || v <= 0) {
    el.textContent = '—';
    return;
  }
  const thinMm = res.fracFinest * v;
  const ratio = thinMm / state.lineWidth;
  const verdict = verdictFor(ratio);
  const ar = res.meta.artH / res.meta.artW;
  const short = ar <= 1 ? v * ar : v / ar;
  el.innerHTML = `最细处 ${thinMm.toFixed(2)} mm（${ratio.toFixed(2)}× 线宽）· ${fmt(short)} mm 短边
    <span class="badge ${verdict.cls}">${verdict.text}</span>`;
}

/* ------------------------------------------------------------------ *
 * 7. 事件
 * ------------------------------------------------------------------ */

async function loadSvg(text, name) {
  state.text = text;
  state.name = name;
  $('#dropTitle').textContent = name;
  // 分析要几秒（大图更久），这段空档必须清掉上一张图的结果 ——
  // 否则屏幕上留着旧数字，很容易被当成新图算出来的。
  state.result = null;
  state.summary = null;
  $('#out').hidden = true;
  $('#empty').hidden = false;
  $('#empty').innerHTML = '<p><strong>正在测量…</strong></p>'
    + '<p class="muted">栅格化 + 逐色块距离变换，复杂图要几秒</p>';
  try {
    state.result = await analyse(text, { pctValue: state.pct });
    render();
  } catch (err) {
    $('#empty').hidden = false;
    $('#out').hidden = true;
    $('#empty').innerHTML = `<p><strong>读不出这张图</strong></p><p class="muted">${err.message || err}</p>`;
  }
}

async function readFile(file) {
  if (!file) return;
  const text = await file.text();
  if (!/<svg[\s>]/i.test(text.slice(0, 4000))) {
    alert('这不是 SVG 文件（前几 KB 里没找到 <svg> 标签）。位图请先在矢量软件里转成 SVG。');
    return;
  }
  await loadSvg(text, file.name);
}

function bind() {
  const drop = $('#drop');
  const file = $('#file');

  drop.addEventListener('click', () => file.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); }
  });
  file.addEventListener('change', () => readFile(file.files[0]));

  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); })
  );
  drop.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) readFile(f);
  });

  $$('.sample').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const id = btn.dataset.sample;
      const res = await fetch(`samples/${id}.svg`);
      if (!res.ok) { alert('示例文件没加载到'); return; }
      await loadSvg(await res.text(), `示例 · ${btn.textContent}`);
    })
  );

  $('#nozzle').addEventListener('change', (e) => {
    const v = e.target.value;
    const wrap = $('#customLwWrap');
    if (v === 'custom') {
      wrap.hidden = false;
      state.lineWidth = parseFloat($('#customLw').value) || 0.42;
    } else {
      wrap.hidden = true;
      state.lineWidth = parseFloat(v);
    }
    $('#lwTag').textContent = state.lineWidth.toFixed(2) + ' mm';
    if (state.result) render();
  });

  $('#customLw').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    if (Number.isFinite(v) && v > 0) {
      state.lineWidth = v;
      $('#lwTag').textContent = v.toFixed(2) + ' mm';
      if (state.result) render();
    }
  });

  $('#pct').addEventListener('change', async (e) => {
    state.pct = parseInt(e.target.value, 10);
    $('#pctTag').textContent = pctLabel(state.pct);
    if (state.text) await loadSvg(state.text, state.name);
  });
  $('#pct').addEventListener('input', (e) => {
    $('#pctTag').textContent = pctLabel(parseInt(e.target.value, 10));
  });

  $('#bed').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    if (Number.isFinite(v) && v > 0) {
      state.bed = v;
      if (state.result) render();
    }
  });

  $('#askW').addEventListener('input', updateAsk);

  $('#copy').addEventListener('click', async () => {
    const s = state.summary;
    if (!s) return;
    const txt = [
      `文件：${state.name}`,
      `线宽：${s.lw} mm`,
      `最细结构占长边：${(state.result.fracFinest * 100).toFixed(2)}%`,
      `下限（1× 线宽）：长边 ${fmt(s.need1)} mm`,
      `推荐（1.5× 线宽）：长边 ${fmt(s.need15)} mm`,
      `舒服（2× 线宽）：长边 ${fmt(s.need2)} mm`,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(txt);
      const b = $('#copy');
      const old = b.textContent;
      b.textContent = '已复制';
      setTimeout(() => (b.textContent = old), 1400);
    } catch {
      alert(txt);
    }
  });
}

/* 测量口径：滑块实际控制「多细的宽度才算笔画」，15 是默认 */
function pctLabel(v) {
  if (v <= 8) return `连尖角一起算（${v}）`;
  if (v <= 20) return '只算成片的笔画';
  if (v <= 30) return '更严：只算明显的粗笔画';
  return `只算最粗的主体（${v}）`;
}

/* 参数联动：初始线宽标签 */
document.addEventListener('DOMContentLoaded', () => {
  $('#lwTag').textContent = state.lineWidth.toFixed(2) + ' mm';
  bind();
});
