// server/src/utils/metrics.js
// Telemetry is schema-agnostic: each machine emits its own `data` map. In practice
// that ranges from a handful of clean named metrics (H_T1, rated_torque_pct,
// depth_of_cutting) to several THOUSAND raw PLC device registers (D0..D999, M0..,
// IW/QW/MB, DB21.W12, DB21.R0...). Worse, machines wrap that data three different ways:
//
//   A) FLAT      — clean keys at the top level         (furnace, bottom milling 01/03)
//   B) data.named.{inputs,outputs} — digital I/O maps  (BOTTOMMILLING2)
//   C) data.active.{...}           — a raw PLC dump     (QUENCHING_FURNACE)
//
// `normalizeData` collapses all three into one consistent shape: named metrics,
// digital inputs, digital outputs, and raw registers. Everything else (classify,
// rank, summarise, stats) builds on top of it. This is the single place that knows
// how the factory wraps its payloads.

// Raw PLC device registers we de-prioritise. Covers:
//   Mitsubishi: D, M, X, Y, T, C, R, L, V, Z, B, W, F, S (+ index)        e.g. D0, M12
//   Siemens word/byte: IW, QW, IB, QB, MB, MW, MD, SM, SD (+ index)        e.g. IW4, MB160
//   Siemens DB blocks: DB<n>.W/DW/D/R/B/X<addr>                            e.g. DB21.W12, DB21.R0
//   Siemens bit addresses: I/Q/M<byte>.<bit>                              e.g. I0.0, Q0.7, M120.1
const REGISTER_RE  = /^(IW|QW|IB|QB|MB|MW|MD|SM|SD|D|M|X|Y|T|C|R|L|V|Z|B|W|F|S|I|Q)\d+$/;
const DB_BLOCK_RE  = /^DB\d+\.[A-Z]+\d+(\.\d+)?$/i;        // DB21.W12 / DB21.DW0 / DB21.R0
const BIT_ADDR_RE  = /^[IQM]\d+\.\d+$/;                    // I0.0 / Q0.7 / M120.1

// Keys that are metadata/containers embedded in the payload, not a measured metric.
const META_KEYS = new Set(['status', 'name', 'machineId', 'machineName', 'machineType', 'timestamp', 'receivedAt', 'eventId']);

// int16 / int32 "no signal" values a disconnected sensor reports. These must be
// excluded from chart scaling and from min/max/avg, or they destroy the view.
const SENTINELS = new Set([-32768, -32767, 32767, 65535, -2147483648, 2147483647]);

export const isRegisterKey = (k) => REGISTER_RE.test(k) || DB_BLOCK_RE.test(k) || BIT_ADDR_RE.test(k);
export const isMetaKey = (k) => META_KEYS.has(k);

export const isNumericValue = (v) =>
  v !== null && v !== undefined && v !== '' && typeof v !== 'boolean' && Number.isFinite(Number(v));

export const isFaultValue = (v) => isNumericValue(v) && SENTINELS.has(Number(v));

const scalar = (key, value) => ({ key, value, numeric: isNumericValue(value), fault: isFaultValue(value) });
const ioEntry = (key, value) => ({
  key, value,
  on: value === 1 || value === true || value === '1' || value === 'on' || value === 'ON',
});

// ─────────────────────────────────────────────────────────────────────────────
// Collapse any of the 3 payload conventions into a single normalized view.
//   { named:[scalar], inputs:[io], outputs:[io], registers:[scalar] }
// ─────────────────────────────────────────────────────────────────────────────
export function normalizeData(data = {}) {
  const named = [];
  const inputs = [];
  const outputs = [];
  const registers = [];

  const sortScalar = (key, value) => {
    if (isMetaKey(key)) return;
    if (isRegisterKey(key)) registers.push(scalar(key, value));
    else named.push(scalar(key, value));
  };

  for (const [key, value] of Object.entries(data || {})) {
    // ── B) digital I/O nested under `named` ──
    if (key === 'named' && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value.inputs  || {})) inputs.push(ioEntry(k, v));
      for (const [k, v] of Object.entries(value.outputs || {})) outputs.push(ioEntry(k, v));
      for (const [k, v] of Object.entries(value)) {           // any other scalars under named
        if (k === 'inputs' || k === 'outputs' || (v && typeof v === 'object')) continue;
        sortScalar(k, v);
      }
      continue;
    }
    // ── C) raw PLC dump nested under `active` ──
    if (key === 'active' && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) {
        if (v && typeof v === 'object') continue;
        if (/^I\d+\.\d+$/.test(k))      inputs.push(ioEntry(k, v));   // input bits
        else if (/^Q\d+\.\d+$/.test(k)) outputs.push(ioEntry(k, v));  // output bits
        else sortScalar(k, v);
      }
      continue;
    }
    // ── A) flat top-level key (skip any other nested objects we don't understand) ──
    if (value && typeof value === 'object') continue;
    sortScalar(key, value);
  }

  return { named, inputs, outputs, registers };
}

// Back-compat: classifyData still returns { named, registers } (used by list cards
// and detail), now also exposing { inputs, outputs } for I/O-heavy machines.
export function classifyData(data = {}) {
  const { named, inputs, outputs, registers } = normalizeData(data);
  return { named, registers, inputs, outputs };
}

// Rank named metrics so the most useful surface first: healthy numeric, then other
// numeric, then non-numeric — alphabetical within each tier for stable ordering.
export function rankNamed(named) {
  const tier = (m) => (m.numeric && !m.fault ? 0 : m.numeric ? 1 : 2);
  return [...named].sort((a, b) => tier(a) - tier(b) || a.key.localeCompare(b.key));
}

// Compact summary of a single latest reading for list cards — small, capped payload.
// Falls back to digital I/O when a machine has no named metrics (e.g. BOTTOMMILLING2),
// so its card is never blank.
export function summarizeLatest(data, ts, { cap = 6 } = {}) {
  const { named, inputs, outputs, registers } = normalizeData(data);
  const ranked = rankNamed(named);
  const io = [...inputs, ...outputs];

  const metrics = ranked.length
    ? ranked.slice(0, cap).map((m) => ({ key: m.key, value: m.value, numeric: m.numeric, fault: m.fault }))
    : io.slice(0, cap).map((m) => ({ key: m.key, value: m.on ? 'ON' : 'OFF', numeric: false, fault: false, io: true }));

  return {
    ts: ts || null,
    hasData: named.length > 0 || registers.length > 0 || io.length > 0,
    metrics,
    namedCount: named.length,
    registerCount: registers.length,
    ioCount: io.length,
    faultCount: named.filter((m) => m.fault).length,
  };
}

// Per-metric statistics over a window of readings. Faults are excluded from
// min/max/avg but counted, so the UI can surface "3 faulty readings". Works off the
// normalized named metrics so nested payloads are handled uniformly.
export function computeStats(readings, { sparkPoints = 32, maxMetrics = 40 } = {}) {
  // Discover the set of named numeric keys present anywhere in the window.
  const keys = new Set();
  const normalized = readings.map((r) => ({ t: r.timestamp, named: normalizeData(r.data).named }));
  for (const r of normalized) {
    for (const m of r.named) if (m.numeric) keys.add(m.key);
  }

  const ordered = [...normalized].sort((a, b) => new Date(a.t) - new Date(b.t));

  const metrics = [];
  for (const key of keys) {
    const series = []; // { t, v } healthy points in time order
    let faultCount = 0;
    let last = null;
    for (const r of ordered) {
      const entry = r.named.find((m) => m.key === key);
      if (!entry) continue;
      const raw = entry.value;
      if (raw === undefined || raw === null || raw === '') continue;
      const n = Number(raw);
      if (!Number.isFinite(n)) continue;
      if (SENTINELS.has(n)) { faultCount += 1; last = { t: r.t, v: n, fault: true }; continue; }
      series.push({ t: r.t, v: n });
      last = { t: r.t, v: n, fault: false };
    }
    if (!series.length && !last) continue;

    const values = series.map((p) => p.v);
    const min = values.length ? Math.min(...values) : null;
    const max = values.length ? Math.max(...values) : null;
    const avg = values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;

    metrics.push({
      key,
      last: last?.v ?? null,
      lastFault: !!last?.fault,
      min, max, avg,
      samples: values.length,
      faultCount,
      spark: downsample(values, sparkPoints),
    });
  }

  metrics.sort((a, b) => a.key.localeCompare(b.key));
  return { metrics: metrics.slice(0, maxMetrics), metricCount: metrics.length };
}

// Reduce a numeric series to at most `n` points by even bucketing (last value wins
// per bucket) — enough to draw a faithful sparkline without shipping 500 points.
function downsample(arr, n) {
  if (arr.length <= n) return arr;
  const step = arr.length / n;
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(arr[Math.min(arr.length - 1, Math.floor((i + 1) * step) - 1)]);
  return out;
}
