/**
 * DataGenerator.js
 * Synthetic load generator + backend bridge for autoscaling pipeline tests.
 */

const LOOKBACK = 48;
const FEATURES = 21;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const generateRandomFeatureRow = (currentPods, step = 0) => {
  const row = [];
  const baseWave = Math.sin(step * 0.1) * 0.5 + 0.5;
  const noise = () => (Math.random() - 0.5) * 0.2;

  row.push(50 + baseWave * 200 + noise() * 30);   // request_rate_rps
  row.push(50 + baseWave * 80 + noise() * 10);    // latency_p95_ms
  row.push(70 + baseWave * 120 + noise() * 15);   // latency_p99_ms
  row.push(Math.max(0, Math.random() > 0.9 ? Math.random() * 0.5 : 0.035)); // error_rate_percent
  row.push(Math.floor(baseWave * 20 + Math.random() * 5)); // queue_length
  row.push(20 + baseWave * 20 + noise() * 4);     // pod_cpu_usage_percent_avg
  row.push(28 + baseWave * 28 + noise() * 5);     // pod_cpu_usage_percent_p95
  row.push(470 + baseWave * 130 + noise() * 30);  // pod_memory_usage_mb_avg
  row.push(520 + baseWave * 150 + noise() * 35);  // pod_memory_usage_mb_p95

  row.push(Math.sin(step * 0.05)); // hour_sin
  row.push(Math.cos(step * 0.05)); // hour_cos
  row.push(Math.sin(step * 0.01)); // day_sin
  row.push(Math.cos(step * 0.01)); // day_cos

  row.push(45 + baseWave * 190 + noise() * 25); // mesh_inbound_rps
  row.push(50 + baseWave * 75 + noise() * 8);   // mesh_inbound_latency_p95
  row.push(0.035 + noise() * 0.004);            // mesh_inbound_error_rate

  row.push(0.5 + noise()); // degree_centrality
  row.push(0.4 + noise()); // eigenvector_centrality
  row.push(0.3 + noise()); // betweenness_centrality
  row.push(0.6 + noise()); // closeness_centrality

  row.push(currentPods);   // current_pod_count (target)
  return row;
};

export const buildSyntheticWindow = ({ lookback = LOOKBACK, currentPods = 3, startStep = 0 } = {}) => {
  const window = [];
  for (let i = 0; i < lookback; i++) {
    window.push(generateRandomFeatureRow(currentPods, startStep + i));
  }
  return window;
};

function validateWindowShape(window) {
  if (!Array.isArray(window) || window.length !== LOOKBACK) return false;
  return window.every((row) => Array.isArray(row) && row.length === FEATURES && row.every((v) => Number.isFinite(Number(v))));
}

export async function postWindowToBackend({
  backendUrl = "http://localhost:6000/api/v1/metrics/window",
  serviceId = "Order",
  timestamp = new Date().toISOString(),
  window,
  dryRun = false,
  validate = true,
  source = "synthetic_window",
  timeoutMs = 8000,
  retries = 2,
} = {}) {
  if (!validateWindowShape(window)) {
    throw new Error("Invalid window shape: expected 48x21 numeric matrix");
  }

  const payload = {
    serviceId,
    timestamp,
    window,
    dryRun,
    validate,
    source,
  };

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(backendUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 250)}`);
      }

      return await res.json();
    } catch (err) {
      lastError = err;
      if (attempt >= retries) break;
      await sleep(300 * (attempt + 1));
    }
  }

  throw lastError;
}

export async function streamSyntheticWindows({
  intervalMs = 5000,
  serviceId = "Order",
  currentPods = 3,
  dryRun = false,
  validate = true,
  source = "synthetic_window",
  onResult,
} = {}) {
  let step = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const window = buildSyntheticWindow({ currentPods, startStep: step });
    const result = await postWindowToBackend({
      serviceId,
      window,
      dryRun,
      validate,
      source,
    });

    if (typeof onResult === "function") {
      onResult(result);
    }

    step += 1;
    await sleep(intervalMs);
  }
}
