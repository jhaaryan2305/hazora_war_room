from typing import Dict, List, Optional
from pydantic import BaseModel, Field


class GeoLocation(BaseModel):
    lat: float
    lng: float
    elevation_m: float = 905.0


class RouteRequest(BaseModel):
    node_id: str = "ANDROID_01_SEDAN"
    vehicle_class: str = "Class A (Sedan)"
    max_wading_depth_cm: float = 15.0
    current_grid_row: int = Field(0, ge=0, le=8)
    current_grid_col: int = Field(4, ge=0, le=8)
    heading_deg: float = 0.0


class GossipHazardRequest(BaseModel):
    action: str = "ADD_HAZARD"  # ADD_HAZARD | CLEAR_HAZARD
    grid_row: int = Field(..., ge=0, le=8)
    grid_col: int = Field(..., ge=0, le=8)
    water_depth_cm: float = 60.0
    hazard_label: str = "FLOOD_BLOCKAGE"
    origin_node_id: str = "ANDROID_01_SEDAN"
    clearance_role: str = "CIVILIAN"  # CIVILIAN | SAR_OPS


class BlockedAheadRequest(BaseModel):
    node_id: str = "ANDROID_01_SEDAN"
    current_grid_row: int = Field(0, ge=0, le=8)
    current_grid_col: int = Field(4, ge=0, le=8)
    heading_deg: float = 0.0
    water_depth_cm: float = 65.0
    hazard_label: str = "CIVILIAN_BLOCKED_AHEAD"


class FloodLevelRequest(BaseModel):
    water_level_cm: float = Field(..., ge=0.0, le=100.0)


class MasterResetRequest(BaseModel):
    clear_all_red_zones: bool = False


class SosBurstRequest(BaseModel):
    trapped_node_id: str = "ANDROID_01_SEDAN"
    device_type: str = "ANDROID_MESH_NODE"
    location: GeoLocation
    barometric_alt_m: float = 902.0
    water_depth_cm: float = 48.0
    occupant_count: int = 2


class NodeTelemetryPayload(BaseModel):
    node_id: str
    vehicle_class: str = "Class A (Sedan)"
    pos_row: float = Field(..., ge=0.0, le=8.0)
    pos_col: float = Field(..., ge=0.0, le=8.0)
    heading_deg: float = 0.0
    raw_heading_deg: float = 0.0
    steps_taken: int = 0
    arrived: bool = False
    aligned: bool = False
    danger: bool = False
    distance_m: int = 780


class TableCalibrationRequest(BaseModel):
    table_north_offset_deg: float = Field(..., ge=0.0, le=360.0)
    source_node_id: str = "OPS_CONSOLE"


class VisionTelemetryPayload(BaseModel):
    device: str = "MPS"
    fps: float = 0.0
    inference_ms: float = 0.0
    survivors_locked: int = 0
    water_depth_cm: float = 18.0
    slope_shear_deg: float = 18.0
    link_mode: str = "2 FPS HEARTBEAT"
    bandwidth_saved_pct: float = 85.0


class Drone1WaypointPayload(BaseModel):
    waypoint_id: str = "WP-DRONE1-01"
    marker_type: str = "UNIDENTIFIED_THERMAL_ANOMALY"
    location: Dict[str, float] = Field(
        default_factory=lambda: {"lat": 12.9748, "lng": 77.5948, "elevation_m": 908.0}
    )
    yolo_confidence: float = 0.39
    thermal_max_c: float = 37.4
    slope_drop_degrees: float = 21.0
    estimated_water_depth_cm: float = 48.0
    notes: str = "Autonomous Drone 1 -> Drone 2 handoff"


class RubbleDiverPayload(BaseModel):
    waypoint_id: str = "WP-DRONE1-01"
    is_motor_disarmed: bool = True
    rotor_rpm: int = 0
    wifi_24ghz_rssi_dbm: Optional[float] = None
    gsm_900mhz_rach_burst_dbm: Optional[float] = None
    piezo_acoustic_db: float = 20.0
    mq135_co2_ppm: float = 410.0
    csi_subcarrier_samples: Optional[List[float]] = None
    csi_sample_rate_hz: float = 10.0
    csi_breathing_bpm: Optional[float] = None
    detected_device_class: str = "2G_KEYPAD_FEATURE_PHONE"


class SmartStakePayload(BaseModel):
    stake_id: str = "STAKE-WARD-01"
    sector_row: int = Field(5, ge=0, le=8)
    sector_col: int = Field(3, ge=0, le=8)
    baseline_calibrated_60s: bool = True
    soil_moisture_pct: float = 40.0
    tilt_delta_deg: float = 0.5
    vibration_g: float = 0.05
