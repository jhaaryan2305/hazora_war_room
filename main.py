import asyncio
import os
import platform
import subprocess
import threading
import time
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
from scipy.signal import butter, filtfilt
from fastapi import FastAPI, File, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from schemas import (
    BlockedAheadRequest,
    Drone1WaypointPayload,
    FloodLevelRequest,
    GossipHazardRequest,
    MasterResetRequest,
    NodeTelemetryPayload,
    RouteRequest,
    RubbleDiverPayload,
    SmartStakePayload,
    SosBurstRequest,
    TableCalibrationRequest,
    VisionTelemetryPayload,
)
from core_engine import (
    DEM_GRID,
    FOUR_PHONE_PRESETS,
    GRID_SIZE,
    SAFE_HAVEN,
    compute_all_4_routes,
    compute_astar_dem_route,
    get_effective_hazards,
    get_flood_water_level,
    get_verified_safe_zones,
    pack_36byte_sos_payload,
    project_ahead_cell,
    reset_mesh_hazards,
    set_flood_water_level,
    update_gossip_hazard,
)

app = FastAPI(title="HAZORA Master Kernel // Team KERNOPS (SW-39)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

Path("static/js").mkdir(parents=True, exist_ok=True)
Path("static/ui").mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")

LATEST_OPTICAL_JPEG: bytes = b""
LATEST_THERMAL_JPEG: bytes = b""
WAYPOINT_QUEUE: List[dict] = []
LAST_VISION_TELEMETRY: dict = VisionTelemetryPayload().model_dump()
LAST_STAKE_TELEMETRY: dict = {
    "stake_id": "STAKE-WARD-01",
    "soil_moisture_pct": 38.0,
    "tilt_delta_deg": 0.6,
    "vibration_g": 0.04,
    "status": "NOMINAL_MONITORING",
    "and_gate_passed": False,
}
LAST_DRONE2_RESULT: dict = {"status": "IDLE_PERCH_READY", "sensor_votes": "0/5"}
LAST_SOS_PACKET: Optional[dict] = None
ACTIVE_STAGE: int = 1
TABLE_NORTH_OFFSET_DEG: float = 0.0
LIVE_NODES: Dict[str, dict] = {}


def _init_live_nodes():
    LIVE_NODES.clear()
    for nid, cfg in FOUR_PHONE_PRESETS.items():
        LIVE_NODES[nid] = {
            "node_id": nid,
            "side": cfg["side"],
            "vehicle_class": cfg["vehicle_class"],
            "pos_row": float(cfg["row"]),
            "pos_col": float(cfg["col"]),
            "heading_deg": 0.0 if cfg["side"] == "SOUTH" else 180.0 if cfg["side"] == "NORTH" else 270.0 if cfg["side"] == "EAST" else 90.0,
            "raw_heading_deg": 0.0,
            "steps_taken": 0,
            "arrived": False,
            "aligned": False,
            "danger": False,
            "distance_m": 780,
            "connected": False,
            "last_seen": 0.0,
        }


_init_live_nodes()


class ConnectionManager:
    def __init__(self):
        self.active: List[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active.append(ws)

    def disconnect(self, ws: WebSocket):
        if ws in self.active:
            self.active.remove(ws)

    async def broadcast(self, message: dict):
        dead = []
        for ws in self.active:
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)


ws_manager = ConnectionManager()


def speak_dispatch(text: str):
    if os.getenv("HAZORA_MUTE_VOICE", "0") == "1":
        return

    def _worker():
        try:
            sys_name = platform.system()
            if sys_name == "Darwin":
                subprocess.Popen(["say", "-r", "195", text])
            elif sys_name == "Windows":
                safe = text.replace("'", " ")
                ps_cmd = (
                    "Add-Type -AssemblyName System.Speech; "
                    f"(New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('{safe}')"
                )
                subprocess.Popen(["powershell", "-NoProfile", "-Command", ps_cmd])
        except Exception:
            pass

    threading.Thread(target=_worker, daemon=True).start()


def process_csi_respiration(
    samples: Optional[List[float]],
    fs_hz: float = 10.0,
    target_bpm_hint: Optional[float] = None,
) -> dict:
    n_pts = 256
    if samples is not None and len(samples) >= 32:
        raw = np.asarray(samples, dtype=np.float64)
        fs_hz = max(4.0, float(fs_hz))
    else:
        t = np.arange(n_pts, dtype=np.float64) / fs_hz
        rng = np.random.default_rng(int(time.time() * 100) % 100000)
        noise = rng.normal(0.0, 0.32, size=n_pts) + 0.45 * np.sin(2.0 * np.pi * 0.04 * t)
        if target_bpm_hint is not None and 6.0 <= target_bpm_hint <= 40.0:
            breath_hz = target_bpm_hint / 60.0
            raw = 1.0 + 0.85 * np.sin(2.0 * np.pi * breath_hz * t) + noise
        else:
            raw = 1.0 + noise

    centered = raw - np.mean(raw)
    nyq = 0.5 * fs_hz
    low = max(0.01, 0.15 / nyq)
    high = min(0.95, 0.50 / nyq)
    b, a = butter(3, [low, high], btype="band")
    filtered = filtfilt(b, a, centered)

    freqs = np.fft.rfftfreq(len(filtered), d=1.0 / fs_hz)
    mags = np.abs(np.fft.rfft(filtered))
    band_mask = (freqs >= 0.15) & (freqs <= 0.50)

    if np.any(band_mask):
        band_freqs = freqs[band_mask]
        band_mags = mags[band_mask]
        peak_idx = int(np.argmax(band_mags))
        peak_freq_hz = float(band_freqs[peak_idx])
        peak_mag = float(band_mags[peak_idx])
        median_floor = float(np.median(band_mags)) + 1e-6
        snr_ratio = peak_mag / median_floor
        snr_db = round(float(10.0 * np.log10(max(snr_ratio, 1e-3))), 2)
        bpm = round(peak_freq_hz * 60.0, 1)
    else:
        peak_freq_hz, snr_db, bpm = 0.0, 0.0, 0.0

    variance = round(float(np.var(filtered)), 4)
    respiration_detected = bool(9.0 <= bpm <= 32.0 and snr_db >= 2.8 and variance >= 0.05)

    return {
        "computed_bpm": bpm if respiration_detected else 0.0,
        "peak_freq_hz": round(peak_freq_hz, 3),
        "snr_db": snr_db,
        "csi_variance": variance,
        "respiration_detected": respiration_detected,
        "raw_waveform": [round(float(x), 3) for x in raw[:80]],
        "filtered_waveform": [round(float(x), 3) for x in filtered[:80]],
        "fft_freqs": [round(float(f), 3) for f in freqs[:40]],
        "fft_mags": [round(float(m), 2) for m in mags[:40]],
    }


def _read_ui_file(primary: str, fallback: Optional[str], default_html: str) -> str:
    p1 = Path(primary)
    if p1.exists():
        return p1.read_text(encoding="utf-8")
    if fallback:
        p2 = Path(fallback)
        if p2.exists():
            return p2.read_text(encoding="utf-8")
    return default_html


def _get_live_nodes_snapshot() -> Dict[str, dict]:
    now = time.time()
    out: Dict[str, dict] = {}
    for nid, info in LIVE_NODES.items():
        cp = dict(info)
        cp["connected"] = (now - float(cp.get("last_seen", 0.0))) < 12.0
        out[nid] = cp
    return out


@app.get("/hazora/health")
async def health_check():
    return {
        "status": "ONLINE",
        "team": "KERNOPS",
        "problem_code": "SW-39",
        "grid_size": GRID_SIZE,
        "safe_haven": {"row": SAFE_HAVEN[0], "col": SAFE_HAVEN[1]},
        "table_north_offset_deg": TABLE_NORTH_OFFSET_DEG,
        "active_stage": ACTIVE_STAGE,
        "flood_water_level_cm": get_flood_water_level(),
        "active_hazards_count": len(get_effective_hazards()),
    }


@app.get("/hazora/state")
async def get_full_state():
    return {
        "active_stage": ACTIVE_STAGE,
        "grid_size": GRID_SIZE,
        "safe_haven": {"row": SAFE_HAVEN[0], "col": SAFE_HAVEN[1], "elevation_m": DEM_GRID[SAFE_HAVEN[0]][SAFE_HAVEN[1]]},
        "table_north_offset_deg": TABLE_NORTH_OFFSET_DEG,
        "flood_water_level_cm": get_flood_water_level(),
        "dem_grid": DEM_GRID,
        "active_hazards": get_effective_hazards(),
        "verified_safe_zones": get_verified_safe_zones(),
        "all_4_phone_routes": compute_all_4_routes(),
        "live_nodes": _get_live_nodes_snapshot(),
        "vision_telemetry": LAST_VISION_TELEMETRY,
        "stake_telemetry": LAST_STAKE_TELEMETRY,
        "drone2_result": LAST_DRONE2_RESULT,
        "last_sos": LAST_SOS_PACKET,
        "waypoint_queue": WAYPOINT_QUEUE[-10:],
    }


@app.get("/", response_class=HTMLResponse)
@app.get("/ui", response_class=HTMLResponse)
@app.get("/ops", response_class=HTMLResponse)
async def serve_ops():
    return _read_ui_file("static/ui/ops.html", "index.html", "<h1>HAZORA Ops Console Online</h1>")


@app.get("/node", response_class=HTMLResponse)
async def serve_phone_node():
    return _read_ui_file("static/ui/node.html", "node.html", "<h1>HAZORA Node Ready</h1>")


@app.get("/sim", response_class=HTMLResponse)
async def serve_simulator():
    return _read_ui_file(
        "static/ui/sim.html",
        None,
        "<h1>HAZORA 3-Pillar Digital Twin Simulator (Phase 6)</h1>",
    )


@app.post("/hazora/core/route")
async def get_astar_route(req: RouteRequest):
    astar = compute_astar_dem_route(req.current_grid_row, req.current_grid_col, req.max_wading_depth_cm)
    return {
        "node_id": req.node_id,
        "grid_size": GRID_SIZE,
        "safe_haven": {"row": SAFE_HAVEN[0], "col": SAFE_HAVEN[1]},
        "table_north_offset_deg": TABLE_NORTH_OFFSET_DEG,
        "flood_water_level_cm": get_flood_water_level(),
        "astar_dem_routing": astar,
        "all_4_phone_routes": compute_all_4_routes(),
        "gossiped_hazards": get_effective_hazards(),
        "verified_safe_zones": get_verified_safe_zones(),
    }


@app.post("/hazora/core/node_telemetry")
async def push_node_telemetry(payload: NodeTelemetryPayload):
    prev = LIVE_NODES.get(payload.node_id, {})
    was_arrived = bool(prev.get("arrived", False))
    preset = FOUR_PHONE_PRESETS.get(payload.node_id, {"side": "MOBILE"})
    entry = payload.model_dump()
    entry["side"] = preset["side"]
    entry["connected"] = True
    entry["last_seen"] = time.time()
    LIVE_NODES[payload.node_id] = entry

    if payload.arrived and not was_arrived:
        speak_dispatch(f"{payload.node_id.replace('_', ' ')} has arrived safely at Laptop Safe Haven.")

    await ws_manager.broadcast({"type": "node_telemetry", "data": entry})
    return {"status": "ok", "table_north_offset_deg": TABLE_NORTH_OFFSET_DEG}


@app.post("/hazora/core/calibrate_table")
async def calibrate_table_north(req: TableCalibrationRequest):
    global TABLE_NORTH_OFFSET_DEG
    TABLE_NORTH_OFFSET_DEG = round(req.table_north_offset_deg % 360.0, 1)
    payload = {
        "table_north_offset_deg": TABLE_NORTH_OFFSET_DEG,
        "source_node_id": req.source_node_id,
        "event_summary": f"Table-North calibrated to {TABLE_NORTH_OFFSET_DEG} deg (Laptop Safe Haven locked)",
    }
    await ws_manager.broadcast({"type": "table_calibration", "data": payload})
    return payload


@app.post("/hazora/core/mesh/gossip_hazard")
async def gossip_hazard(req: GossipHazardRequest):
    res = update_gossip_hazard(
        req.action,
        req.grid_row,
        req.grid_col,
        req.water_depth_cm,
        req.hazard_label,
        req.origin_node_id,
        clearance_role=req.clearance_role,
    )
    payload = {
        "accepted": res["accepted"],
        "reason": res["reason"],
        "event_summary": res["summary"],
        "active_hazards": get_effective_hazards(),
        "verified_safe_zones": get_verified_safe_zones(),
        "all_4_phone_routes": compute_all_4_routes(),
    }
    if res["accepted"]:
        await ws_manager.broadcast({"type": "p2p_hazard_gossip", "data": payload})
    return payload


@app.post("/hazora/core/mesh/blocked_ahead")
async def report_blocked_ahead(req: BlockedAheadRequest):
    nr, nc = project_ahead_cell(req.current_grid_row, req.current_grid_col, req.heading_deg)
    res = update_gossip_hazard(
        "ADD_HAZARD",
        nr,
        nc,
        req.water_depth_cm,
        req.hazard_label,
        req.node_id,
        clearance_role="CIVILIAN",
    )
    payload = {
        "accepted": res["accepted"],
        "projected_cell": {"grid_row": nr, "grid_col": nc},
        "event_summary": res["summary"],
        "active_hazards": get_effective_hazards(),
        "verified_safe_zones": get_verified_safe_zones(),
        "all_4_phone_routes": compute_all_4_routes(),
    }
    if res["accepted"]:
        await ws_manager.broadcast({"type": "p2p_hazard_gossip", "data": payload})
    return payload


@app.post("/hazora/core/mesh/flood_level")
async def update_flood_level(req: FloodLevelRequest):
    info = set_flood_water_level(req.water_level_cm)
    info["all_4_phone_routes"] = compute_all_4_routes()
    info["verified_safe_zones"] = get_verified_safe_zones()
    info["event_summary"] = (
        f"Monsoon water level -> {info['water_level_cm']}cm "
        f"(Sedans blocked: {info['sedan_blocked_cells']}, SUVs blocked: {info['suv_blocked_cells']})"
    )
    await ws_manager.broadcast({"type": "flood_level_update", "data": info})
    return info


@app.post("/hazora/core/mesh/reset")
async def reset_demo(req: MasterResetRequest):
    global ACTIVE_STAGE
    ACTIVE_STAGE = 1
    hazards = reset_mesh_hazards(req.clear_all_red_zones)
    _init_live_nodes()
    status_msg = "All red hazard zones cleared" if req.clear_all_red_zones else "Baseline 3-cell radial traps restored"
    payload = {
        "event_summary": status_msg,
        "flood_water_level_cm": get_flood_water_level(),
        "active_hazards": hazards,
        "verified_safe_zones": get_verified_safe_zones(),
        "all_4_phone_routes": compute_all_4_routes(),
        "live_nodes": _get_live_nodes_snapshot(),
    }
    await ws_manager.broadcast({"type": "demo_reset", "status": status_msg, "data": payload})
    return {"status": status_msg, "active_hazards": hazards}


@app.post("/hazora/core/sos")
async def trigger_sos_burst(req: SosBurstRequest):
    global LAST_SOS_PACKET
    packed = pack_36byte_sos_payload(
        req.trapped_node_id,
        req.location.lat,
        req.location.lng,
        req.barometric_alt_m,
        req.water_depth_cm,
        req.occupant_count,
    )
    LAST_SOS_PACKET = packed
    speak_dispatch(f"Emergency 36 byte binary S O S burst received from {req.trapped_node_id}.")
    await ws_manager.broadcast({"type": "sos_mesh_burst", "data": packed})
    return packed


@app.post("/hazora/air/push_frame")
async def push_aerial_frame(optical: UploadFile = File(...), thermal: UploadFile = File(...)):
    global LATEST_OPTICAL_JPEG, LATEST_THERMAL_JPEG
    LATEST_OPTICAL_JPEG = await optical.read()
    LATEST_THERMAL_JPEG = await thermal.read()
    return {"status": "ok"}


@app.post("/hazora/air/vision_telemetry")
async def push_vision_telemetry(payload: VisionTelemetryPayload):
    global LAST_VISION_TELEMETRY
    LAST_VISION_TELEMETRY = payload.model_dump()
    await ws_manager.broadcast({"type": "vision_telemetry", "data": LAST_VISION_TELEMETRY})
    return {"status": "ok"}


async def mjpeg_generator(is_thermal: bool = False):
    while True:
        frame = LATEST_THERMAL_JPEG if is_thermal else LATEST_OPTICAL_JPEG
        if frame:
            yield (b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + frame + b"\r\n")
        await asyncio.sleep(0.08)


@app.get("/stream/optical")
async def stream_optical():
    return StreamingResponse(mjpeg_generator(False), media_type="multipart/x-mixed-replace; boundary=frame")


@app.get("/stream/thermal")
async def stream_thermal():
    return StreamingResponse(mjpeg_generator(True), media_type="multipart/x-mixed-replace; boundary=frame")


@app.post("/hazora/air/mark_waypoint")
async def mark_drone1_waypoint(wp: Drone1WaypointPayload):
    entry = wp.model_dump()
    WAYPOINT_QUEUE.append(entry)
    target_row, target_col = (5, 5) if wp.marker_type == "STEEP_ELEVATION_DROP" else (3, 5)
    res = update_gossip_hazard(
        "ADD_HAZARD",
        target_row,
        target_col,
        wp.estimated_water_depth_cm,
        wp.marker_type,
        wp.waypoint_id,
        clearance_role="SAR_OPS",
    )
    speak_dispatch(f"Drone 1 marked {wp.marker_type.replace('_', ' ')} at {wp.waypoint_id}. Queuing Drone 2.")
    payload = {
        "event_summary": res["summary"],
        "waypoint": entry,
        "active_hazards": get_effective_hazards(),
        "verified_safe_zones": get_verified_safe_zones(),
        "all_4_phone_routes": compute_all_4_routes(),
    }
    await ws_manager.broadcast({"type": "drone1_waypoint", "data": payload})
    await ws_manager.broadcast({"type": "p2p_hazard_gossip", "data": payload})
    return {"status": "HANDOFF_QUEUED", "waypoint": entry, "mesh_sync": res["summary"]}


@app.post("/hazora/air/rubble_diver_scan")
async def rubble_diver_scan(scan: RubbleDiverPayload):
    global LAST_DRONE2_RESULT

    if (not scan.is_motor_disarmed) or (scan.rotor_rpm > 0):
        rejected = {
            "status": "REJECTED_PROP_WASH_GUARDRAIL",
            "waypoint_id": scan.waypoint_id,
            "is_motor_disarmed": scan.is_motor_disarmed,
            "rotor_rpm": max(scan.rotor_rpm, 3200 if not scan.is_motor_disarmed else 0),
            "reason": "Rotors active! Disarm motors to 0 RPM before acoustic or Wi-Fi CSI respiration listening.",
            "sensor_votes": "0/5",
            "sensor_matrix": {
                "gsm_900mhz": False,
                "wifi_24ghz": False,
                "piezo_acoustic": False,
                "co2_mq135": False,
                "wifi_csi_respiration": False,
            },
            "active_triggers": [],
            "csi_dsp": process_csi_respiration(None, scan.csi_sample_rate_hz, target_bpm_hint=None),
        }
        LAST_DRONE2_RESULT = rejected
        await ws_manager.broadcast({"type": "rubble_diver_lock", "data": rejected})
        return rejected

    csi_dsp = process_csi_respiration(
        scan.csi_subcarrier_samples,
        scan.csi_sample_rate_hz,
        target_bpm_hint=scan.csi_breathing_bpm,
    )

    gsm_hit = scan.gsm_900mhz_rach_burst_dbm is not None and scan.gsm_900mhz_rach_burst_dbm > -75.0
    wifi_hit = scan.wifi_24ghz_rssi_dbm is not None and scan.wifi_24ghz_rssi_dbm > -75.0
    piezo_hit = scan.piezo_acoustic_db >= 40.0
    co2_hit = scan.mq135_co2_ppm >= 650.0
    csi_hit = csi_dsp["respiration_detected"]

    triggers = []
    if gsm_hit:
        triggers.append(f"900MHz GSM RACH ({scan.gsm_900mhz_rach_burst_dbm} dBm)")
    if wifi_hit:
        triggers.append(f"2.4GHz Wi-Fi Probe ({scan.wifi_24ghz_rssi_dbm} dBm)")
    if piezo_hit:
        triggers.append(f"Piezo Acoustic ({scan.piezo_acoustic_db} dB)")
    if co2_hit:
        triggers.append(f"MQ-135 CO2 ({scan.mq135_co2_ppm} ppm)")
    if csi_hit:
        triggers.append(f"Wi-Fi CSI Respiration ({csi_dsp['computed_bpm']} BPM, SNR {csi_dsp['snr_db']} dB)")

    votes = len(triggers)
    locked = votes >= 2
    status = "SURVIVOR_LOCK_ACQUIRED" if locked else "SCANNING_VOID"

    if locked:
        speak_dispatch(
            f"Survivor lock acquired at {scan.waypoint_id}. "
            f"{votes} of 5 sensors confirmed. Class: {scan.detected_device_class.replace('_', ' ')}."
        )

    result = {
        "status": status,
        "waypoint_id": scan.waypoint_id,
        "is_motor_disarmed": True,
        "rotor_rpm": 0,
        "detected_device_class": scan.detected_device_class,
        "sensor_votes": f"{votes}/5",
        "sensor_matrix": {
            "gsm_900mhz": gsm_hit,
            "wifi_24ghz": wifi_hit,
            "piezo_acoustic": piezo_hit,
            "co2_mq135": co2_hit,
            "wifi_csi_respiration": csi_hit,
        },
        "raw_readings": {
            "gsm_900mhz_dbm": scan.gsm_900mhz_rach_burst_dbm,
            "wifi_24ghz_dbm": scan.wifi_24ghz_rssi_dbm,
            "piezo_db": scan.piezo_acoustic_db,
            "co2_ppm": scan.mq135_co2_ppm,
            "csi_bpm": csi_dsp["computed_bpm"],
        },
        "active_triggers": triggers,
        "csi_dsp": csi_dsp,
    }
    LAST_DRONE2_RESULT = result
    await ws_manager.broadcast({"type": "rubble_diver_lock", "data": result})
    return result


@app.post("/hazora/ground/stake_telemetry")
async def process_smart_stake(stake: SmartStakePayload):
    global LAST_STAKE_TELEMETRY
    moisture_trip = stake.soil_moisture_pct >= 80.0
    tilt_trip = stake.tilt_delta_deg >= 5.0

    if moisture_trip and tilt_trip:
        res = update_gossip_hazard(
            "ADD_HAZARD",
            stake.sector_row,
            stake.sector_col,
            85.0,
            "LANDSLIDE_SHEAR_BREACH",
            stake.stake_id,
            clearance_role="SAR_OPS",
        )
        speak_dispatch(f"Critical landslide breach on Smart Stake {stake.stake_id}. Broadcasting mesh roadblock.")
        out = {
            "stake_id": stake.stake_id,
            "status": "LANDSLIDE_BREACH_CONFIRMED",
            "and_gate_passed": True,
            "soil_moisture_pct": stake.soil_moisture_pct,
            "tilt_delta_deg": stake.tilt_delta_deg,
            "vibration_g": stake.vibration_g,
            "mesh_sync": res["summary"],
        }
        LAST_STAKE_TELEMETRY = out
        await ws_manager.broadcast({"type": "smart_stake_telemetry", "data": out})
        await ws_manager.broadcast({
            "type": "p2p_hazard_gossip",
            "data": {
                "event_summary": res["summary"],
                "active_hazards": get_effective_hazards(),
                "verified_safe_zones": get_verified_safe_zones(),
                "all_4_phone_routes": compute_all_4_routes(),
            },
        })
        return out

    out = {
        "stake_id": stake.stake_id,
        "status": "FALSE_POSITIVE_BLOCKED_BY_AND_GATE",
        "and_gate_passed": False,
        "soil_moisture_pct": stake.soil_moisture_pct,
        "tilt_delta_deg": stake.tilt_delta_deg,
        "vibration_g": stake.vibration_g,
        "reason": f"Moisture={stake.soil_moisture_pct}% (req >=80%) | Tilt={stake.tilt_delta_deg} deg (req >=5.0 deg)",
    }
    LAST_STAKE_TELEMETRY = out
    await ws_manager.broadcast({"type": "smart_stake_telemetry", "data": out})
    return out


@app.post("/hazora/sim/stage/{stage_id}")
async def run_director_stage(stage_id: int, mode: str = Query("csi")):
    global ACTIVE_STAGE
    if stage_id not in (1, 2, 3, 4, 5):
        raise HTTPException(status_code=400, detail="stage_id must be 1..5")

    ACTIVE_STAGE = stage_id
    detail: Dict[str, object] = {}

    if stage_id == 1:
        detail["reset"] = await reset_demo(MasterResetRequest(clear_all_red_zones=False))
        detail["stake"] = await process_smart_stake(
            SmartStakePayload(stake_id="STAKE-WARD-01", soil_moisture_pct=38.0, tilt_delta_deg=0.6, vibration_g=0.04)
        )
        summary = "Stage 1: Baseline Ready — 3 radial traps around Laptop Safe Haven [4,4]."

    elif stage_id == 2:
        detail["stake"] = await process_smart_stake(
            SmartStakePayload(stake_id="STAKE-WARD-01", soil_moisture_pct=42.0, tilt_delta_deg=6.8, vibration_g=1.45)
        )
        summary = "Stage 2: Heavy Truck Vibration — AND-Gate blocked false alarm (Moisture 42% < 80%)."

    elif stage_id == 3:
        detail["flood"] = await update_flood_level(FloodLevelRequest(water_level_cm=52.0))
        detail["stake"] = await process_smart_stake(
            SmartStakePayload(stake_id="STAKE-WARD-01", sector_row=4, sector_col=2, soil_moisture_pct=88.5, tilt_delta_deg=9.4, vibration_g=0.92)
        )
        summary = "Stage 3: 52cm Monsoon Surge + West Landslide Breach — All 4 table routes rerouted."

    elif stage_id == 4:
        detail["waypoint"] = await mark_drone1_waypoint(
            Drone1WaypointPayload(
                waypoint_id="WP-DRONE1-01",
                marker_type="UNIDENTIFIED_THERMAL_ANOMALY",
                location={"lat": 12.9748, "lng": 77.5948, "elevation_m": 908.0},
                yolo_confidence=0.39,
                thermal_max_c=37.4,
                slope_drop_degrees=21.2,
                estimated_water_depth_cm=46.0,
                notes="Drone 1 low-confidence thermal plume -> autonomous handoff to Drone 2",
            )
        )
        summary = "Stage 4: Drone 1 flagged Thermal Void WP-DRONE1-01 and queued Drone 2."

    else:
        if mode == "keypad":
            scan_req = RubbleDiverPayload(
                waypoint_id="WP-DRONE1-01",
                is_motor_disarmed=True,
                rotor_rpm=0,
                wifi_24ghz_rssi_dbm=-96.0,
                gsm_900mhz_rach_burst_dbm=-52.0,
                piezo_acoustic_db=48.5,
                mq135_co2_ppm=890.0,
                csi_breathing_bpm=None,
                detected_device_class="2G_KEYPAD_FEATURE_PHONE",
            )
            summary = "Stage 5 (Keypad): Drone 2 disarmed & locked buried 2G Feature Phone via 900MHz RACH + Piezo + CO2."
        else:
            scan_req = RubbleDiverPayload(
                waypoint_id="WP-DRONE1-01",
                is_motor_disarmed=True,
                rotor_rpm=0,
                wifi_24ghz_rssi_dbm=-100.0,
                gsm_900mhz_rach_burst_dbm=-100.0,
                piezo_acoustic_db=22.0,
                mq135_co2_ppm=780.0,
                csi_breathing_bpm=16.2,
                detected_device_class="DEVICE_FREE_UNCONSCIOUS_SURVIVOR",
            )
            summary = "Stage 5 (Device-Free CSI): Drone 2 locked unconscious phone-less survivor via 16.2 BPM Wi-Fi CSI + CO2."
        detail["drone2"] = await rubble_diver_scan(scan_req)

    event = {"stage_id": stage_id, "mode": mode, "summary": summary, "detail": detail}
    await ws_manager.broadcast({"type": "director_stage", "data": event})
    return event


@app.websocket("/ws/mission_control")
async def mission_control_ws(ws: WebSocket):
    await ws_manager.connect(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        ws_manager.disconnect(ws)
