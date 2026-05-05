"""
V4 Scenario Dashboard Backend
Calls the real system APIs at TARGET_URL to simulate attack scenarios,
measures actual response metrics (latency, error rates, RPS, etc.),
feeds them into the trained ML models, and streams results via WebSocket.
"""

import os, sys, pickle, time, threading, random, string
import numpy as np
import pandas as pd
from collections import deque
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
from flask import Flask, jsonify, request as flask_request
from flask_socketio import SocketIO
from flask_cors import CORS

try:
    import requests as http
    http.packages.urllib3.disable_warnings()
except Exception:
    import urllib.request as http

# ── Config ────────────────────────────────────────────────────────────────────
TARGET_URL   = os.environ.get("TARGET_URL", "http://localhost:3003")
TICK_INTERVAL = 3          # seconds between metric snapshots
WINDOW_SEC    = 30         # sliding window for feature computation
REQUEST_TIMEOUT = 5        # seconds per HTTP request

# ── Paths ─────────────────────────────────────────────────────────────────────
BASE_DIR     = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(BASE_DIR, "../.."))
MODEL_DIR    = os.path.join(PROJECT_ROOT, "results/models/v4")
SRC_DIR      = os.path.join(PROJECT_ROOT, "src/scenario_generator")
sys.path.insert(0, SRC_DIR)
from scenarios import FEATURE_ORDER, SERVICES

# ── Service → endpoint mapping ────────────────────────────────────────────────
# (method, path, body_fn)   body_fn(rng) -> dict or None
def _rand_creds(rng):
    u = "user_" + "".join(rng.choice(list(string.ascii_lowercase), 6))
    return {"username": u, "password": "wrong_" + str(rng.integers(1000, 9999))}

def _rand_order(rng):
    return {"product_id": int(rng.integers(1, 100)), "quantity": int(rng.integers(1, 5))}

def _rand_product(rng):
    return {"name": "item_" + str(rng.integers(1, 999)), "price": float(rng.uniform(1, 200))}

# Each route tuple is (method, full_url, body_fn)
# Services run directly on their own ports (not proxied through api-gateway)
SERVICE_ROUTES = {
    "api-gateway": {
        "normal":     [("GET",  "http://localhost:3003/health",          None)],
        "flood":      [("GET",  "http://localhost:3003/health",          None)],
    },
    "auth": {
        "normal":     [("GET",  "http://localhost:3000/health",          None)],
        "login":      [("POST", "http://localhost:3000/login",           _rand_creds),
                       ("POST", "http://localhost:3000/register",        _rand_creds)],
        "flood":      [("GET",  "http://localhost:3000/health",          None),
                       ("POST", "http://localhost:3000/login",           _rand_creds)],
    },
    "order": {
        "normal":     [("GET",  "http://localhost:3002/health",          None)],
        "flood":      [("GET",  "http://localhost:3002/health",          None)],
    },
    "product": {
        "normal":     [("GET",  "http://localhost:3001/health",          None)],
        "flood":      [("GET",  "http://localhost:3001/health",          None),
                       ("GET",  "http://localhost:3001/api/products",    None)],
    },
    "rabbitmq": {
        "normal":     [("GET",  "http://localhost:15672/api/healthchecks/node", None)],
        "flood":      [("GET",  "http://localhost:15672/api/healthchecks/node", None)],
    },
}

# Attack scenario → request behaviour
ATTACK_CONFIG = {
    "ddos": {
        "routes_key":   "flood",
        "concurrency":  20,          # concurrent threads per tick
        "sources":      (100, 500),  # unique_source_count range
        "delay":        0.0,
    },
    "brute_force": {
        "routes_key":   "login",
        "concurrency":  8,
        "sources":      (1, 3),
        "delay":        0.0,
    },
    "slow_loris": {
        "routes_key":   "normal",
        "concurrency":  2,
        "sources":      (1, 10),
        "delay":        2.5,         # sleep before returning → high latency
    },
    "http_flood": {
        "routes_key":   "flood",
        "concurrency":  15,
        "sources":      (10, 80),
        "delay":        0.0,
    },
    "normal": {
        "routes_key":   "normal",
        "concurrency":  1,
        "sources":      (0, 1),
        "delay":        0.0,
    },
}

# ── Flask ─────────────────────────────────────────────────────────────────────
app      = Flask(__name__)
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

# ── ML models ─────────────────────────────────────────────────────────────────
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"

def _load_models():
    models = {}
    def _pkl(n):
        with open(os.path.join(MODEL_DIR, n), "rb") as f: return pickle.load(f)
    try:
        m,s = _pkl("isolation_forest_model.pkl"), _pkl("isolation_forest_scaler.pkl")
        models["Isolation Forest"] = lambda X,m=m,s=s: (m.predict(s.transform(X))==-1).astype(int)
    except Exception as e: print(f"[WARN] IF: {e}")
    try:
        m,s,t = _pkl("gmm_model.pkl"), _pkl("gmm_scaler.pkl"), _pkl("gmm_threshold.pkl")
        models["GMM"] = lambda X,m=m,s=s,t=t: (m.score_samples(s.transform(X))<t).astype(int)
    except Exception as e: print(f"[WARN] GMM: {e}")
    try:
        m,s = _pkl("knn_model.pkl"), _pkl("knn_scaler.pkl")
        models["KNN (LOF)"] = lambda X,m=m,s=s: (m.predict(s.transform(X))==-1).astype(int)
    except Exception as e: print(f"[WARN] KNN: {e}")
    try:
        m,s = _pkl("one_class_svm_model.pkl"), _pkl("one_class_svm_scaler.pkl")
        models["One-Class SVM"] = lambda X,m=m,s=s: (m.predict(s.transform(X))==-1).astype(int)
    except Exception as e: print(f"[WARN] SVM: {e}")
    try:
        import tensorflow as tf
        mp = os.path.join(MODEL_DIR, "autoencoder_model.h5")
        # mp = os.path.join(MODEL_DIR, "autoencoder_model.keras")
        # if not os.path.exists(mp): mp = os.path.join(MODEL_DIR, "autoencoder_model.h5")
        ae = tf.keras.models.load_model(mp, compile=False)
        s,t = _pkl("autoencoder_scaler.pkl"), _pkl("autoencoder_threshold.pkl")
        def _ae(X, ae=ae, s=s, t=t):
            Xs = s.transform(X); err = np.mean(np.power(Xs-ae.predict(Xs,verbose=0),2),axis=1)
            return (err>t).astype(int)
        models["Autoencoder"] = _ae
    except Exception as e: print(f"[WARN] AE: {e}")
    print(f"[INFO] Loaded {len(models)} models: {list(models.keys())}")
    return models

MODELS = _load_models()

# Stable slug for each model name — used as the WebSocket event suffix
MODEL_EVENT = {
    "Isolation Forest": "isolation-forest",
    "GMM":              "gmm",
    "KNN (LOF)":        "knn",
    "One-Class SVM":    "one-class-svm",
    "Autoencoder":      "autoencoder",
}

# Confidence score helpers (decision function → [0,1])
def _confidence(model_name: str, X: np.ndarray) -> float | None:
    def _pkl(n):
        with open(os.path.join(MODEL_DIR, n), "rb") as f: return pickle.load(f)
    try:
        if model_name == "Isolation Forest":
            m, s = _pkl("isolation_forest_model.pkl"), _pkl("isolation_forest_scaler.pkl")
            score = float(m.decision_function(s.transform(X))[0])
        elif model_name == "GMM":
            m, s, t = _pkl("gmm_model.pkl"), _pkl("gmm_scaler.pkl"), _pkl("gmm_threshold.pkl")
            lp = float(m.score_samples(s.transform(X))[0])
            return round(abs(lp - t) / (abs(t) + 1e-9), 4)
        elif model_name == "KNN (LOF)":
            m, s = _pkl("knn_model.pkl"), _pkl("knn_scaler.pkl")
            score = float(m.decision_function(s.transform(X))[0])
        elif model_name == "One-Class SVM":
            m, s = _pkl("one_class_svm_model.pkl"), _pkl("one_class_svm_scaler.pkl")
            score = float(m.decision_function(s.transform(X))[0])
        else:
            return None
        return round(1 / (1 + abs(score)), 4)
    except Exception:
        return None

# ── Feature plausibility gate ─────────────────────────────────────────────────
# At least ONE of these thresholds must be exceeded for an anomaly to be plausible.
# Values chosen so benign traffic (rps≤35, unique_src≤1, 4xx=0, 5xx=0) never trips.
_ATTACK_THRESHOLDS = {
    "rps_mean":               5.0,    # BruteForce min=5, Flood/DDoS much higher
    "unique_source_count":    3,      # Benign always ≤1; attacks start at 1–100
    "ratio_4xx":              0.15,   # Benign=0; BruteForce 0.60–0.95
    "ratio_5xx":              0.05,   # Benign=0; SlowLoris 0.15–0.50, DDoS 0.05–0.25
    "latency_mean":           100.0,  # Benign mean≈3.7ms; SlowLoris 200–700ms
    "inter_arrival_variance": 10.0,   # Benign mean≈0.52; SlowLoris 15–90
}

def _is_plausible_attack(features: dict) -> bool:
    """Return True only if at least one feature clearly exceeds benign baseline."""
    return (
        features.get("rps_mean", 0)               > _ATTACK_THRESHOLDS["rps_mean"] or
        features.get("unique_source_count", 0)     > _ATTACK_THRESHOLDS["unique_source_count"] or
        features.get("ratio_4xx", 0)               > _ATTACK_THRESHOLDS["ratio_4xx"] or
        features.get("ratio_5xx", 0)               > _ATTACK_THRESHOLDS["ratio_5xx"] or
        features.get("latency_mean", 0)            > _ATTACK_THRESHOLDS["latency_mean"] or
        features.get("inter_arrival_variance", 0)  > _ATTACK_THRESHOLDS["inter_arrival_variance"]
    )

def _run_models(features: dict) -> dict:
    """Run all models and return per-model results including confidence."""
    X = np.array([[features[f] for f in FEATURE_ORDER]])
    out = {}
    for name, fn in MODELS.items():
        try:
            p = int(fn(X)[0])
            out[name] = {
                "prediction": p,
                "label":      "Anomaly" if p else "Normal",
                "confidence": _confidence(name, X),
            }
        except Exception as e:
            out[name] = {"prediction": -1, "label": "Error", "confidence": None}

    # Apply plausibility gate — if no attack feature is exceeded, force Normal
    if not _is_plausible_attack(features):
        for name in out:
            if out[name].get("prediction") == 1:
                out[name] = {
                    "prediction": 0,
                    "label":      "Normal",
                    "confidence": out[name].get("confidence"),
                }
    return out

def _emit_predictions(service: str, ts: str, scenario: str, features: dict, results: dict):
    """
    Emit one event per model   →  prediction:<slug>
    Emit one combined event    →  predictions:all
    Emit legacy event          →  ml-prediction   (backward compat)
    """
    anomaly_votes = sum(1 for r in results.values() if r.get("prediction") == 1)
    base = {
        "service":   service,
        "timestamp": ts,
        "scenario":  scenario,
        "features":  features,
    }

    # ── Per-model events ──────────────────────────────────────────────────────
    for model_name, result in results.items():
        slug  = MODEL_EVENT.get(model_name, model_name.lower().replace(" ", "-"))
        event = f"prediction:{slug}"
        socketio.emit(event, {**base, **result, "model": model_name})

    # ── Combined summary event ────────────────────────────────────────────────
    socketio.emit("predictions:all", {
        **base,
        "results":       results,
        "anomaly_votes": anomaly_votes,
        "total_models":  len(results),
        "consensus":     "Anomaly" if anomaly_votes > len(results) / 2 else "Normal",
    })

    # ── Legacy event (keeps existing dashboard working) ───────────────────────
    socketio.emit("ml-prediction", {
        "service":     service,
        "timestamp":   ts,
        "scenario":    scenario,
        "predictions": {k: {"prediction": v["prediction"], "label": v["label"]}
                        for k, v in results.items()},
    })

# ── Per-service traffic windows ───────────────────────────────────────────────
# Each entry: (timestamp_float, latency_ms, status_code, source_ip_str)
_windows = {svc: deque() for svc in SERVICES}
_win_lock = threading.Lock()

def _prune_window(svc: str):
    cutoff = time.time() - WINDOW_SEC
    w = _windows[svc]
    while w and w[0][0] < cutoff:
        w.popleft()

def _compute_features(svc: str) -> dict:
    with _win_lock:
        _prune_window(svc)
        entries = list(_windows[svc])

    if not entries:
        return {f: 0.0 for f in FEATURE_ORDER}

    now     = time.time()
    total   = len(entries)
    lats    = [e[1] for e in entries]
    codes   = [e[2] for e in entries]
    sources = set(e[3] for e in entries)
    times   = [e[0] for e in entries]

    # RPS: bucket into 1-second slots over window
    slots = {}
    for t, *_ in entries:
        slot = int(t)
        slots[slot] = slots.get(slot, 0) + 1
    rps_vals   = list(slots.values())
    rps_mean   = float(np.mean(rps_vals))  if rps_vals else 0.0
    rps_std    = float(np.std(rps_vals))   if len(rps_vals) > 1 else 0.0

    # Error ratios
    n4xx = sum(1 for c in codes if 400 <= c < 500)
    n5xx = sum(1 for c in codes if c >= 500)
    # connection errors stored as 0
    ratio_4xx = n4xx / total
    ratio_5xx = n5xx / total

    # Latency (ms)
    lat_mean = float(np.mean(lats)) if lats else 0.0
    lat_std  = float(np.std(lats))  if len(lats) > 1 else 0.0

    # Inter-arrival variance
    if len(times) > 1:
        iav = float(np.var(np.diff(sorted(times))))
    else:
        iav = 0.0

    return {
        "rps_mean":               round(rps_mean, 4),
        "rps_std":                round(rps_std, 4),
        "unique_source_count":    len(sources),
        "ratio_4xx":              round(ratio_4xx, 4),
        "ratio_5xx":              round(ratio_5xx, 4),
        "latency_mean":           round(lat_mean, 4),
        "latency_std":            round(lat_std, 4),
        "inter_arrival_variance": round(iav, 6),
    }

# ── HTTP request worker ───────────────────────────────────────────────────────
_req_log   = deque(maxlen=200)   # recent request log for the frontend
_stats     = {"total_sent": 0, "errors": 0, "system_online": False}
_stats_lock = threading.Lock()

def _make_request(method: str, url: str, body_fn, svc: str, source_ip: str, delay: float = 0.0):
    body = body_fn(np.random.default_rng()) if body_fn else None
    hdrs = {
        "X-Forwarded-For": source_ip,
        "X-Simulated-Source": source_ip,
        "Content-Type": "application/json",
    }
    t0 = time.time()
    status = 0
    error  = None
    try:
        if delay > 0:
            time.sleep(delay)
        resp = http.request(
            method, url,
            json=body, headers=hdrs,
            timeout=REQUEST_TIMEOUT,
            verify=False,
        )
        # 401 from rabbitmq health = auth required but service is up; treat as 200
        # 503 from services with DB disconnected = service is up; treat as 200
        status = 200 if resp.status_code in (401, 503) else resp.status_code
        with _stats_lock:
            _stats["system_online"] = True
    except http.exceptions.ConnectionError:
        status = 0
        error  = "connection_refused"
        with _stats_lock:
            _stats["system_online"] = False
            _stats["errors"] += 1
    except http.exceptions.Timeout:
        status = 0
        error  = "timeout"
        with _stats_lock:
            _stats["errors"] += 1
    except Exception as ex:
        status = 0
        error  = str(ex)[:60]
        with _stats_lock:
            _stats["errors"] += 1

    latency_ms = (time.time() - t0) * 1000

    # Record in window
    with _win_lock:
        _windows[svc].append((t0, latency_ms, status, source_ip))

    # Record in log
    from urllib.parse import urlparse as _up
    _path = _up(url).path
    _req_log.append({
        "ts":      datetime.now().strftime("%H:%M:%S"),
        "service": svc,
        "method":  method,
        "path":    _path,
        "status":  status,
        "latency": round(latency_ms, 1),
        "source":  source_ip,
        "error":   error,
    })

    with _stats_lock:
        _stats["total_sent"] += 1

    return status, latency_ms

def _sim_source_ip(rng, lo: int, hi: int) -> str:
    """Simulate a source IP from the given source-count range."""
    n = int(rng.integers(lo, max(hi, lo + 1)))
    idx = int(rng.integers(0, max(n, 1)))
    return f"10.0.{idx // 256}.{idx % 256}"

# ── Simulation threads ────────────────────────────────────────────────────────
_lock    = threading.Lock()
_states  = {svc: {"scenario": "normal", "remaining": None, "active": False} for svc in SERVICES}
_threads = {}

def _simulate_service(svc: str, stop_evt: threading.Event):
    rng = np.random.default_rng(int(time.time() * 1000) % (2**32))

    while not stop_evt.is_set():
        with _lock:
            scenario  = _states[svc]["scenario"]
            remaining = _states[svc]["remaining"]

        # When idle (normal), let the bridge handle monitoring — no need to fire requests
        if scenario == "normal":
            stop_evt.wait(timeout=TICK_INTERVAL)
            continue

        cfg         = ATTACK_CONFIG.get(scenario, ATTACK_CONFIG["normal"])
        routes_key  = cfg["routes_key"]
        concurrency = cfg["concurrency"]
        src_lo, src_hi = cfg["sources"]
        delay       = cfg["delay"]

        routes = SERVICE_ROUTES.get(svc, {}).get(routes_key) \
              or SERVICE_ROUTES.get(svc, {}).get("normal", [("GET", "/health", None)])

        # Fire concurrent requests
        with ThreadPoolExecutor(max_workers=max(concurrency, 1)) as pool:
            futs = []
            for _ in range(concurrency):
                method, url, body_fn = routes[int(rng.integers(0, len(routes)))]
                source_ip = _sim_source_ip(rng, src_lo, src_hi)
                futs.append(pool.submit(_make_request, method, url, body_fn, svc, source_ip, delay))
            for f in as_completed(futs, timeout=REQUEST_TIMEOUT + delay + 2):
                pass  # results already recorded in window

        # Compute features from real window
        features = _compute_features(svc)
        ts       = datetime.now().isoformat()

        socketio.emit("traffic-reading", {
            "service":   svc,
            "timestamp": ts,
            "scenario":  scenario,
            "features":  features,
        })

        results = _run_models(features)
        _emit_predictions(svc, ts, scenario, features, results)

        # Emit latest request log slice
        socketio.emit("request-log", {
            "entries": [e for e in list(_req_log)[-20:] if e["service"] == svc]
        })

        # Count down duration
        with _lock:
            if remaining is not None:
                remaining -= 1
                _states[svc]["remaining"] = remaining
                if remaining <= 0:
                    _states[svc].update({"scenario": "normal", "remaining": None, "active": False})

        stop_evt.wait(TICK_INTERVAL)


def _ensure_thread(svc: str):
    with _lock:
        if svc in _threads:
            evt, thr = _threads[svc]
            if thr.is_alive():
                return
        evt = threading.Event()
        thr = threading.Thread(target=_simulate_service, args=(svc, evt), daemon=True)
        _threads[svc] = (evt, thr)
    thr.start()

for _svc in SERVICES:
    _ensure_thread(_svc)

# ── REST API ──────────────────────────────────────────────────────────────────
@app.route("/status")
def status():
    with _lock:
        states = {k: dict(v) for k, v in _states.items()}
    with _stats_lock:
        st = dict(_stats)
    return jsonify({"services": states, "stats": st, "models": list(MODELS.keys()), "target": TARGET_URL})


@app.route("/scenario", methods=["POST"])
def set_scenario():
    data     = flask_request.get_json(force=True)
    service  = data.get("service", "all")
    scenario = data.get("scenario", "normal").lower().replace(" ", "_")
    duration = data.get("duration")

    valid = ["normal"] + list(ATTACK_CONFIG.keys())
    if scenario not in valid:
        return jsonify({"error": f"Unknown scenario. Valid: {valid}"}), 400

    targets = SERVICES if service == "all" else [service]
    for s in targets:
        if s not in SERVICES:
            return jsonify({"error": f"Unknown service '{s}'"}), 400

    ticks = int(duration / TICK_INTERVAL) if duration else None
    with _lock:
        for s in targets:
            _states[s].update({"scenario": scenario, "remaining": ticks, "active": scenario != "normal"})
    for s in targets:
        _ensure_thread(s)
    return jsonify({"ok": True, "service": service, "scenario": scenario, "duration": duration})


@app.route("/reset", methods=["POST"])
def reset():
    data    = flask_request.get_json(force=True)
    service = data.get("service", "all")
    targets = SERVICES if service == "all" else [service]
    with _lock:
        for s in targets:
            _states[s].update({"scenario": "normal", "remaining": None, "active": False})
    return jsonify({"ok": True, "reset": targets})


@app.route("/target", methods=["GET", "POST"])
def target():
    global TARGET_URL
    if flask_request.method == "POST":
        body = flask_request.get_json(force=True)
        TARGET_URL = body.get("url", TARGET_URL).rstrip("/")
        return jsonify({"ok": True, "target": TARGET_URL})
    return jsonify({"target": TARGET_URL})


@app.route("/logs")
def logs():
    svc = flask_request.args.get("service")
    entries = list(_req_log)
    if svc:
        entries = [e for e in entries if e["service"] == svc]
    return jsonify({"logs": entries[-50:]})


# ── Per-model prediction endpoints ───────────────────────────────────────────
#
# All endpoints accept POST with JSON body:
#   {
#     "rps_mean": 1.5,
#     "rps_std": 0.3,
#     "unique_source_count": 1,
#     "ratio_4xx": 0.0,
#     "ratio_5xx": 0.0,
#     "latency_mean": 3.2,
#     "latency_std": 0.8,
#     "inter_arrival_variance": 0.01
#   }
#
# All return:
#   { "model": "...", "prediction": 0|1, "label": "Normal"|"Anomaly",
#     "confidence": float, "features_received": {...} }
#
# Also available:
#   POST /predict           — run all 5 models, return combined result
#   GET  /predict/models    — list available models

MODEL_SLUG = {
    "isolation-forest": "Isolation Forest",
    "gmm":              "GMM",
    "knn":              "KNN (LOF)",
    "one-class-svm":    "One-Class SVM",
    "autoencoder":      "Autoencoder",
}

# ── Field name aliases ────────────────────────────────────────────────────────
# Maps every known incoming field name → our canonical FEATURE_ORDER name.
# Handles the real system payload where latency fields have _ms suffix.
FIELD_ALIASES = {
    "latency_mean_ms": "latency_mean",
    "latency_std_ms":  "latency_std",
    # add more aliases here if the upstream schema changes
}

# Service name aliases: upstream uses "order-service", we use "order"
SERVICE_ALIASES = {
    "order-service":   "order",
    "product-service": "product",
    "auth-service":    "auth",
    "api-gateway":     "api-gateway",
    "rabbitmq":        "rabbitmq",
}

def _normalize_service(name: str) -> str:
    """Map upstream service names to our internal service names."""
    if name in SERVICE_ALIASES:
        return SERVICE_ALIASES[name]
    # strip common suffixes
    stripped = name.replace("-service", "").replace("_service", "")
    return stripped if stripped in SERVICES else name

def _normalize_body(body: dict) -> dict:
    """
    Normalize an incoming payload to canonical feature names.
    Applies FIELD_ALIASES and strips metadata-only fields.
    """
    normalized = {}
    for k, v in body.items():
        canonical = FIELD_ALIASES.get(k, k)
        normalized[canonical] = v
    return normalized

def _parse_features(body: dict):
    """
    Extract and validate the 8 features from a request body.
    Accepts both canonical names and known aliases (e.g. latency_mean_ms).
    """
    normalized = _normalize_body(body)
    missing = [f for f in FEATURE_ORDER if f not in normalized]
    if missing:
        return None, None, (
            f"Missing features: {missing}. "
            f"Tip: 'latency_mean_ms'/'latency_std_ms' are accepted aliases."
        )
    try:
        values = [float(normalized[f]) for f in FEATURE_ORDER]
    except (TypeError, ValueError) as e:
        return None, None, f"Invalid feature value: {e}"
    features = {f: float(normalized[f]) for f in FEATURE_ORDER}
    return np.array([values]), features, None

def _predict_one(model_name: str, X: np.ndarray, features: dict):
    fn = MODELS.get(model_name)
    if fn is None:
        return jsonify({"error": f"Model '{model_name}' not loaded"}), 503
    try:
        pred = int(fn(X)[0])
        # Confidence proxy: distance score where available
        confidence = None
        try:
            slug = [k for k, v in MODEL_SLUG.items() if v == model_name][0]
            if slug == "isolation-forest":
                import pickle as _pk
                with open(os.path.join(MODEL_DIR, "isolation_forest_scaler.pkl"), "rb") as f:
                    sc = _pk.load(f)
                with open(os.path.join(MODEL_DIR, "isolation_forest_model.pkl"), "rb") as f:
                    m = _pk.load(f)
                score = float(m.decision_function(sc.transform(X))[0])
                confidence = round(1 / (1 + abs(score)), 4)
            elif slug == "gmm":
                import pickle as _pk
                with open(os.path.join(MODEL_DIR, "gmm_scaler.pkl"), "rb") as f:
                    sc = _pk.load(f)
                with open(os.path.join(MODEL_DIR, "gmm_model.pkl"), "rb") as f:
                    m = _pk.load(f)
                with open(os.path.join(MODEL_DIR, "gmm_threshold.pkl"), "rb") as f:
                    t = _pk.load(f)
                lp = float(m.score_samples(sc.transform(X))[0])
                confidence = round(abs(lp - t) / (abs(t) + 1e-9), 4)
            elif slug == "knn":
                import pickle as _pk
                with open(os.path.join(MODEL_DIR, "knn_scaler.pkl"), "rb") as f:
                    sc = _pk.load(f)
                with open(os.path.join(MODEL_DIR, "knn_model.pkl"), "rb") as f:
                    m = _pk.load(f)
                score = float(m.decision_function(sc.transform(X))[0])
                confidence = round(1 / (1 + abs(score)), 4)
            elif slug == "one-class-svm":
                import pickle as _pk
                with open(os.path.join(MODEL_DIR, "one_class_svm_scaler.pkl"), "rb") as f:
                    sc = _pk.load(f)
                with open(os.path.join(MODEL_DIR, "one_class_svm_model.pkl"), "rb") as f:
                    m = _pk.load(f)
                score = float(m.decision_function(sc.transform(X))[0])
                confidence = round(1 / (1 + abs(score)), 4)
        except Exception:
            pass

        return jsonify({
            "model":             model_name,
            "prediction":        pred,
            "label":             "Anomaly" if pred else "Normal",
            "confidence":        confidence,
            "features_received": features,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/predict/models", methods=["GET"])
def predict_models():
    """List all available models and their endpoint slugs."""
    return jsonify({
        "models": [
            {"name": v, "slug": k, "endpoint": f"/predict/{k}"}
            for k, v in MODEL_SLUG.items()
            if v in MODELS
        ]
    })


@app.route("/predict", methods=["POST"])
def predict_all():
    """Run all loaded models and return combined results. Accepts canonical or aliased field names."""
    body = flask_request.get_json(force=True)
    X, features, err = _parse_features(body)
    if err:
        return jsonify({"error": err}), 400

    results = {}
    for name, fn in MODELS.items():
        try:
            pred = int(fn(X)[0])
            results[name] = {
                "prediction": pred,
                "label":      "Anomaly" if pred else "Normal",
                "confidence": _confidence(name, X),
            }
        except Exception as e:
            results[name] = {"error": str(e)}

    anomaly_votes = sum(1 for r in results.values() if r.get("prediction") == 1)
    return jsonify({
        "predictions":       results,
        "anomaly_votes":     anomaly_votes,
        "total_models":      len(results),
        "consensus":         "Anomaly" if anomaly_votes > len(results) / 2 else "Normal",
        "features_received": features,
    })


@app.route("/predict/isolation-forest", methods=["POST"])
def predict_isolation_forest():
    body = flask_request.get_json(force=True)
    X, features, err = _parse_features(body)
    if err: return jsonify({"error": err}), 400
    return _predict_one("Isolation Forest", X, features)


@app.route("/predict/gmm", methods=["POST"])
def predict_gmm():
    body = flask_request.get_json(force=True)
    X, features, err = _parse_features(body)
    if err: return jsonify({"error": err}), 400
    return _predict_one("GMM", X, features)


@app.route("/predict/knn", methods=["POST"])
def predict_knn():
    body = flask_request.get_json(force=True)
    X, features, err = _parse_features(body)
    if err: return jsonify({"error": err}), 400
    return _predict_one("KNN (LOF)", X, features)


@app.route("/predict/one-class-svm", methods=["POST"])
def predict_one_class_svm():
    body = flask_request.get_json(force=True)
    X, features, err = _parse_features(body)
    if err: return jsonify({"error": err}), 400
    return _predict_one("One-Class SVM", X, features)


@app.route("/predict/autoencoder", methods=["POST"])
def predict_autoencoder():
    body = flask_request.get_json(force=True)
    X, features, err = _parse_features(body)
    if err: return jsonify({"error": err}), 400
    return _predict_one("Autoencoder", X, features)


# ── /ingest  — external system pushes metrics here ───────────────────────────
# Accepts the real system payload format:
#   { "namespace": "...", "service": "order-service",
#     "rps_mean": 0.065, "rps_std": 0.001, "unique_source_count": 1,
#     "ratio_4xx": 0.0,  "ratio_5xx": 0.0,
#     "latency_mean_ms": 11.67, "latency_std_ms": 6.43,
#     "inter_arrival_variance": 0.107, ... }
#
# Runs all 5 models, emits per-model WebSocket events, returns predictions.
# Also accepts a list of such objects in one call.

@app.route("/ingest", methods=["POST"])
def ingest():
    body = flask_request.get_json(force=True)

    # Accept a single object or a list
    items = body if isinstance(body, list) else [body]
    responses = []

    for item in items:
        X, features, err = _parse_features(item)
        if err:
            responses.append({"error": err, "raw": item})
            continue

        # Resolve service name
        raw_svc = item.get("service", "unknown")
        service = _normalize_service(raw_svc)
        ts      = item.get("computed_at") or datetime.now().isoformat()

        # If the bot's sliding window has recent traffic for this service, prefer
        # those features — they reflect real attack traffic, not just health polling
        with _win_lock:
            _prune_window(service)
            has_bot_data = service in _windows and len(_windows[service]) >= 3
        if has_bot_data:
            features = _compute_features(service)

        # Run all models
        results = _run_models(features)

        # Emit per-model WebSocket events (same as simulation)
        _emit_predictions(service, ts, "external", features, results)

        # Also emit the raw reading so dashboards can show feature values
        socketio.emit("traffic-reading", {
            "service":   service,
            "timestamp": ts,
            "scenario":  "external",
            "features":  features,
        })

        anomaly_votes = sum(1 for r in results.values() if r.get("prediction") == 1)
        responses.append({
            "service":       service,
            "timestamp":     ts,
            "predictions":   results,
            "anomaly_votes": anomaly_votes,
            "total_models":  len(results),
            "consensus":     "Anomaly" if anomaly_votes > len(results) / 2 else "Normal",
            "features_used": features,
        })

    # Return single object or list to match input
    return jsonify(responses[0] if not isinstance(body, list) else responses)


if __name__ == "__main__":
    print(f"[INFO] Target system : {TARGET_URL}")
    print(f"[INFO] Starting backend on port 5002")
    socketio.run(app, host="0.0.0.0", port=5002, debug=False, allow_unsafe_werkzeug=True)
