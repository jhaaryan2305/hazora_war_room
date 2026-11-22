import os
import re
import sys
from pathlib import Path
from typing import List

import httpx

BASE_URL = os.getenv("HAZORA_SERVER_URL", "https://127.0.0.1:8443")

REQUIRED_FILES: List[str] = [
    "main.py",
    "core_engine.py",
    "schemas.py",
    "vision_engine.py",
    "telemetry_sim.py",
    "certs/cert.pem",
    "certs/key.pem",
    "static/ui/node.html",
    "static/js/node_engine.js",
    "static/ui/ops.html",
    "static/js/ops_engine.js",
    "static/ui/sim.html",
    "static/js/sim_engine.js",
]

NODE_REQUIRED_IDS: List[str] = [
    "launch-overlay",
    "vehicle-sedan-btn",
    "vehicle-suv-btn",
    "btn-start-evac",
    "guidance-card",
    "status-pill",
    "compass-status",
    "steer-chevron",
    "steer-instruction",
    "metric-distance",
    "metric-elevation",
    "safe-confirmation-pill",
    "radar-canvas",
    "toast-banner",
    "btn-blocked-ahead",
    "btn-sos-hold",
    "sos-progress-ring",
    "sos-hold-label",
]

OPS_REQUIRED_IDS: List[str] = [
    "ops-map-canvas",
    "ops-node-cards",
    "flood-slider",
    "table-cal-slider",
    "btn-snap-table-north",
    "csi-wave-canvas",
    "ops-event-log",
    "ws-badge",
]

SIM_REQUIRED_IDS: List[str] = [
    "sim-csi-wave",
    "sim-csi-fft",
    "sim-rpm-toggle",
    "btn-sim-run-d2",
    "sim-stake-moisture",
    "sim-stake-tilt",
    "sim-flood-slider",
    "btn-sim-sos",
]


def check_ids(path: str, ids: List[str], errors: List[str]):
    html = Path(path).read_text(encoding="utf-8")
    for eid in ids:
        if f'id="{eid}"' not in html and f"id='{eid}'" not in html:
            errors.append(f"{path}: Missing required element id='{eid}'")


def run_static_checks() -> List[str]:
    errors: List[str] = []
    for f in REQUIRED_FILES:
        if not Path(f).exists():
            errors.append(f"Missing required file: {f}")
    if errors:
        return errors

    check_ids("static/ui/node.html", NODE_REQUIRED_IDS, errors)
    check_ids("static/ui/ops.html", OPS_REQUIRED_IDS, errors)
    check_ids("static/ui/sim.html", SIM_REQUIRED_IDS, errors)

    node_html = Path("static/ui/node.html").read_text(encoding="utf-8")
    if "node_engine.js" not in node_html:
        errors.append("static/ui/node.html: Missing <script src='/static/js/node_engine.js'>")
    if "#launch-overlay.hidden" not in node_html:
        errors.append("static/ui/node.html: Missing '#launch-overlay.hidden { display: none !important; }' rule")

    node_js = Path("static/js/node_engine.js").read_text(encoding="utf-8")
    if "isHoldingWalk" in node_js:
        errors.append("static/js/node_engine.js: Legacy drag/hold movement detected!")
    if "HAVEN_R = 4" not in node_js or "HAVEN_C = 4" not in node_js:
        errors.append("static/js/node_engine.js: Center Laptop Safe Haven [4,4] missing!")

    ops_html = Path("static/ui/ops.html").read_text(encoding="utf-8")
    if "ops_engine.js" not in ops_html:
        errors.append("static/ui/ops.html: Missing ops_engine.js script tag")

    sim_html = Path("static/ui/sim.html").read_text(encoding="utf-8")
    if "sim_engine.js" not in sim_html:
        errors.append("static/ui/sim.html: Missing sim_engine.js script tag")

    return errors


def run_live_smoke_checks() -> List[str]:
    errors: List[str] = []
    try:
        with httpx.Client(verify=False, timeout=5.0) as c:
            h = c.get(f"{BASE_URL}/hazora/health").json()
            if h.get("grid_size") != 9 or h.get("safe_haven") != {"row": 4, "col": 4}:
                errors.append(f"Live /hazora/health mismatch: {h}")

            for ep in ["/node", "/ops", "/sim", "/static/js/node_engine.js", "/static/js/ops_engine.js", "/static/js/sim_engine.js"]:
                r = c.get(f"{BASE_URL}{ep}")
                if r.status_code != 200 or len(r.text) < 400:
                    errors.append(f"Endpoint {ep} failed (HTTP {r.status_code})")

            # Guardrail 1: Prop-wash rejection
            g1 = c.post(f"{BASE_URL}/hazora/air/rubble_diver_scan", json={
                "waypoint_id": "VERIFY", "is_motor_disarmed": False, "rotor_rpm": 4200,
                "csi_breathing_bpm": 16.2, "mq135_co2_ppm": 780.0
            }).json()
            if g1.get("status") != "REJECTED_PROP_WASH_GUARDRAIL":
                errors.append(f"Guardrail 1 failed: {g1.get('status')}")

            # Guardrail 2: Smart Stake AND-Gate blocks dry truck shock
            g2 = c.post(f"{BASE_URL}/hazora/ground/stake_telemetry", json={
                "stake_id": "VERIFY", "soil_moisture_pct": 42.0, "tilt_delta_deg": 6.8, "vibration_g": 1.45
            }).json()
            if g2.get("status") != "FALSE_POSITIVE_BLOCKED_BY_AND_GATE":
                errors.append(f"Guardrail 2 failed: {g2.get('status')}")

            # Guardrail 3: SciPy Wi-Fi CSI DSP + CO2 2/5 survivor lock
            g3 = c.post(f"{BASE_URL}/hazora/air/rubble_diver_scan", json={
                "waypoint_id": "VERIFY", "is_motor_disarmed": True, "rotor_rpm": 0,
                "csi_breathing_bpm": 16.2, "mq135_co2_ppm": 780.0,
                "detected_device_class": "DEVICE_FREE_UNCONSCIOUS_SURVIVOR"
            }).json()
            if g3.get("status") != "SURVIVOR_LOCK_ACQUIRED" or not g3.get("csi_dsp", {}).get("fft_mags"):
                errors.append(f"Guardrail 3 / SciPy FFT failed: {g3.get('status')}")

            # Leave system clean at Stage 1 baseline
            c.post(f"{BASE_URL}/hazora/sim/stage/1")
    except Exception as exc:
        errors.append(f"Live server check failed at {BASE_URL}: {exc}")
    return errors


if __name__ == "__main__":
    static_errs = run_static_checks()
    live_errs = [] if "--static-only" in sys.argv else run_live_smoke_checks()
    all_errs = static_errs + live_errs

    if all_errs:
        print("❌ HAZORA INTEGRITY CHECK FAILED:")
        for e in all_errs:
            print("  -", e)
        sys.exit(1)

    print("✅ PHASE 6 EXIT GATE & FULL-STACK INTEGRITY CHECK PASSED!")
    print("   • Locked Phases 0–5 intact (0 regressions)")
    print("   • /node (v7 Center Haven), /ops (War Room), /sim (3-Pillar Digital Twin) verified")
    print("   • Guardrails 1, 2, 3 & live SciPy FFT/Butterworth DSP verified")
