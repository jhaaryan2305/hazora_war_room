import heapq
import math
import struct
import time
from typing import Dict, List, Optional, Set, Tuple

GRID_SIZE = 9
SAFE_HAVEN = (4, 4)  # Physical Laptop in the center of the table (948m high ground)

# 9x9 Radial Topography (meters ASL):
# Center [4,4] is the 948m dry high-ground Safe Haven (Laptop).
# Outer cardinal edges [0,4], [8,4], [4,0], [4,8] are 903-905m start sectors.
# Inner drainage bowls sit at [2,4], [6,4], [4,2], [4,6] (893-898m) so flood surges
# force Sedans (<15cm) and SUVs (<30cm) onto visibly different detour corridors.
DEM_GRID: List[List[float]] = [
    [906, 905, 904, 903, 904, 903, 904, 905, 906],  # Row 0 (South edge -> [0,4] Sedan)
    [907, 906, 904, 899, 898, 900, 905, 907, 908],  # Row 1
    [909, 907, 903, 897, 894, 899, 906, 910, 911],  # Row 2 (South basin [2,4])
    [912, 910, 901, 926, 932, 927, 902, 912, 914],  # Row 3
    [905, 901, 896, 933, 948, 934, 893, 900, 904],  # Row 4 (West [4,0] -> LAPTOP [4,4] <- East [4,8])
    [912, 910, 902, 928, 933, 926, 901, 911, 913],  # Row 5
    [909, 907, 904, 898, 895, 899, 905, 909, 910],  # Row 6 (North basin [6,4])
    [907, 906, 905, 900, 899, 901, 905, 907, 908],  # Row 7
    [906, 905, 904, 903, 904, 903, 904, 905, 906],  # Row 8 (North edge -> [8,4] iPhone)
]

# 4 Cardinal Table Positions converging on the center Laptop [4,4]
FOUR_PHONE_PRESETS: Dict[str, dict] = {
    "ANDROID_01_SEDAN":  {"row": 0, "col": 4, "side": "SOUTH", "vehicle_class": "Class A (Sedan)", "max_wading_cm": 15.0},
    "IPHONE_16_PRO_MAX": {"row": 8, "col": 4, "side": "NORTH", "vehicle_class": "Class B (SUV)",   "max_wading_cm": 30.0},
    "ANDROID_02_SUV":    {"row": 4, "col": 8, "side": "EAST",  "vehicle_class": "Class B (SUV)",   "max_wading_cm": 30.0},
    "ANDROID_03_SAR":    {"row": 4, "col": 0, "side": "WEST",  "vehicle_class": "Class A (Sedan)", "max_wading_cm": 15.0},
}

# Baseline 3 inner-ring flood traps forcing immediate realistic detours toward the laptop
BASELINE_HAZARDS: Dict[Tuple[int, int], dict] = {
    (2, 4): {"depth_cm": 62.0, "label": "SOUTH_UNDERPASS_FLOOD", "origin": "BASELINE"},
    (4, 6): {"depth_cm": 74.0, "label": "EAST_CULVERT_SURGE",    "origin": "BASELINE"},
    (6, 4): {"depth_cm": 58.0, "label": "NORTH_STORM_DRAIN",     "origin": "BASELINE"},
}

ACTIVE_HAZARDS: Dict[Tuple[int, int], dict] = dict(BASELINE_HAZARDS)
SAR_CLEARED_CORRIDORS: Set[Tuple[int, int]] = set()
FLOOD_WATER_LEVEL_CM: float = 0.0
FLOOD_BASE_ELEVATION_M: float = 893.0


def cell_to_gps(r: int, c: int) -> Tuple[float, float]:
    lat = round(12.9710 + (r / 8.0) * 0.0080, 6)
    lng = round(77.5910 + (c / 8.0) * 0.0080, 6)
    return lat, lng


def get_flood_water_level() -> float:
    return FLOOD_WATER_LEVEL_CM


def get_effective_hazards_map() -> Dict[Tuple[int, int], dict]:
    merged: Dict[Tuple[int, int], dict] = {}
    for k, v in ACTIVE_HAZARDS.items():
        if k != SAFE_HAVEN:
            merged[k] = dict(v)

    if FLOOD_WATER_LEVEL_CM > 0.0:
        # Rise flood surface over low-lying drainage bowls (893m..901m)
        water_surface_m = FLOOD_BASE_ELEVATION_M + (FLOOD_WATER_LEVEL_CM / 12.0)
        for r in range(GRID_SIZE):
            for c in range(GRID_SIZE):
                if (r, c) == SAFE_HAVEN or (r, c) in SAR_CLEARED_CORRIDORS:
                    continue
                elev = DEM_GRID[r][c]
                if elev < water_surface_m:
                    depth_cm = round((water_surface_m - elev) * 12.0, 1)
                    if depth_cm >= 10.0:
                        existing = merged.get((r, c))
                        if existing is None or depth_cm > existing["depth_cm"]:
                            merged[(r, c)] = {
                                "depth_cm": depth_cm,
                                "label": "MONSOON_BASIN_FLOOD",
                                "origin": "FLOOD_MODEL",
                            }
    return merged


def get_effective_hazards() -> List[dict]:
    out: List[dict] = []
    for (r, c), info in sorted(get_effective_hazards_map().items()):
        lat, lng = cell_to_gps(r, c)
        out.append({
            "grid_row": r,
            "grid_col": c,
            "lat": lat,
            "lng": lng,
            "elevation_m": DEM_GRID[r][c],
            "depth_cm": info["depth_cm"],
            "label": info["label"],
            "origin": info.get("origin", "MESH"),
        })
    return out


def get_verified_safe_zones() -> List[dict]:
    effective_hazards = get_effective_hazards_map()
    zones: List[dict] = []
    seen: Set[Tuple[int, int]] = set()

    for (r, c) in sorted(SAR_CLEARED_CORRIDORS):
        if (r, c) not in effective_hazards:
            zones.append({
                "grid_row": r,
                "grid_col": c,
                "elevation_m": DEM_GRID[r][c],
                "zone_type": "SAR_VERIFIED_CLEAR",
                "label": "CLEAR",
            })
            seen.add((r, c))

    for r in range(GRID_SIZE):
        for c in range(GRID_SIZE):
            if (r, c) in seen or (r, c) in effective_hazards:
                continue
            if DEM_GRID[r][c] >= 926.0:
                zones.append({
                    "grid_row": r,
                    "grid_col": c,
                    "elevation_m": DEM_GRID[r][c],
                    "zone_type": "HIGH_GROUND_SAFE",
                    "label": "SAFE HIGH GROUND",
                })
    return zones


def set_flood_water_level(water_level_cm: float) -> dict:
    global FLOOD_WATER_LEVEL_CM
    FLOOD_WATER_LEVEL_CM = round(max(0.0, min(100.0, float(water_level_cm))), 1)
    hazards = get_effective_hazards()
    sedan_blocked = sum(1 for h in hazards if h["depth_cm"] > 15.0)
    suv_blocked = sum(1 for h in hazards if h["depth_cm"] > 30.0)
    return {
        "water_level_cm": FLOOD_WATER_LEVEL_CM,
        "sedan_blocked_cells": sedan_blocked,
        "suv_blocked_cells": suv_blocked,
        "active_hazards": hazards,
    }


def reset_mesh_hazards(clear_all: bool = False) -> List[dict]:
    global FLOOD_WATER_LEVEL_CM
    ACTIVE_HAZARDS.clear()
    SAR_CLEARED_CORRIDORS.clear()
    FLOOD_WATER_LEVEL_CM = 0.0
    if not clear_all:
        ACTIVE_HAZARDS.update(dict(BASELINE_HAZARDS))
    return get_effective_hazards()


def project_ahead_cell(row: int, col: int, heading_deg: float) -> Tuple[int, int]:
    rad = math.radians(heading_deg % 360.0)
    dr = int(round(math.cos(rad)))
    dc = int(round(math.sin(rad)))
    nr = max(0, min(GRID_SIZE - 1, row + dr))
    nc = max(0, min(GRID_SIZE - 1, col + dc))
    if (nr, nc) == SAFE_HAVEN:
        return (row, col)
    return (nr, nc)


def update_gossip_hazard(
    action: str,
    grid_row: int,
    grid_col: int,
    water_depth_cm: float,
    hazard_label: str,
    origin_node_id: str,
    clearance_role: str = "CIVILIAN",
) -> dict:
    key = (grid_row, grid_col)
    if action == "CLEAR_HAZARD":
        if clearance_role != "SAR_OPS":
            return {
                "accepted": False,
                "reason": "SAR_OPS clearance required to clear a hazard zone.",
                "summary": f"REJECTED: {origin_node_id} lacks SAR_OPS clearance to clear [{grid_row},{grid_col}]",
            }
        ACTIVE_HAZARDS.pop(key, None)
        SAR_CLEARED_CORRIDORS.add(key)
        return {
            "accepted": True,
            "reason": "CLEARED_BY_SAR_OPS",
            "summary": f"SAR CLEARED corridor [{grid_row},{grid_col}] — verified dry for evacuation",
        }

    if key == SAFE_HAVEN:
        return {
            "accepted": False,
            "reason": "Cannot block Safe Haven center [4,4].",
            "summary": "Safe Haven [4,4] is protected upland.",
        }

    SAR_CLEARED_CORRIDORS.discard(key)
    ACTIVE_HAZARDS[key] = {
        "depth_cm": float(water_depth_cm),
        "label": hazard_label,
        "origin": origin_node_id,
    }
    return {
        "accepted": True,
        "reason": "HAZARD_PINPOINTED",
        "summary": f"PINPOINTED {hazard_label} ({water_depth_cm}cm) at [{grid_row},{grid_col}] by {origin_node_id}",
    }


def _bearing_deg(r1: int, c1: int, r2: int, c2: int) -> float:
    if r1 == r2 and c1 == c2:
        return 0.0
    ang = math.degrees(math.atan2(c2 - c1, r2 - r1))
    return round((ang + 360.0) % 360.0, 1)


def compute_astar_dem_route(start_row: int, start_col: int, max_wading_depth_cm: float = 15.0) -> dict:
    start = (max(0, min(GRID_SIZE - 1, start_row)), max(0, min(GRID_SIZE - 1, start_col)))
    goal = SAFE_HAVEN
    hazards_map = get_effective_hazards_map()

    def run_astar(allow_shallow_fallback: bool) -> Optional[List[Tuple[int, int]]]:
        pq: List[Tuple[float, float, Tuple[int, int]]] = [(0.0, 0.0, start)]
        came_from: Dict[Tuple[int, int], Optional[Tuple[int, int]]] = {start: None}
        g_score: Dict[Tuple[int, int], float] = {start: 0.0}

        neighbors = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)]
        while pq:
            _, cur_g, cur = heapq.heappop(pq)
            if cur == goal:
                path: List[Tuple[int, int]] = []
                node: Optional[Tuple[int, int]] = cur
                while node is not None:
                    path.append(node)
                    node = came_from[node]
                path.reverse()
                return path

            if cur_g > g_score.get(cur, 1e9):
                continue

            cr, cc = cur
            for dr, dc in neighbors:
                nr, nc = cr + dr, cc + dc
                if not (0 <= nr < GRID_SIZE and 0 <= nc < GRID_SIZE):
                    continue
                hz = hazards_map.get((nr, nc))
                step_cost = 1.414 if (dr != 0 and dc != 0) else 1.0
                if hz and (nr, nc) != goal:
                    if hz["depth_cm"] > max_wading_depth_cm:
                        if not allow_shallow_fallback:
                            continue
                        step_cost += 45.0 + hz["depth_cm"] * 0.5
                    else:
                        step_cost += hz["depth_cm"] * 0.12

                # Mild preference for higher ground and SAR-cleared corridors
                elev_bonus = max(0.0, (948.0 - DEM_GRID[nr][nc]) * 0.015)
                if (nr, nc) in SAR_CLEARED_CORRIDORS:
                    elev_bonus *= 0.25

                tentative = cur_g + step_cost + elev_bonus
                if tentative < g_score.get((nr, nc), 1e9):
                    g_score[(nr, nc)] = tentative
                    came_from[(nr, nc)] = cur
                    h = math.hypot(goal[0] - nr, goal[1] - nc)
                    heapq.heappush(pq, (tentative + h, tentative, (nr, nc)))
        return None

    path = run_astar(allow_shallow_fallback=False)
    used_fallback = False
    if path is None:
        path = run_astar(allow_shallow_fallback=True) or [start, goal]
        used_fallback = True

    route_points: List[dict] = []
    for idx, (r, c) in enumerate(path):
        lat, lng = cell_to_gps(r, c)
        nxt = path[min(idx + 1, len(path) - 1)]
        route_points.append({
            "grid_row": r,
            "grid_col": c,
            "lat": lat,
            "lng": lng,
            "elevation_m": DEM_GRID[r][c],
            "required_bearing_deg": _bearing_deg(r, c, nxt[0], nxt[1]),
        })

    return {
        "safe_haven": {"grid_row": goal[0], "grid_col": goal[1], "elevation_m": DEM_GRID[goal[0]][goal[1]]},
        "hops": max(0, len(route_points) - 1),
        "used_perimeter_fallback": used_fallback,
        "safe_haven_route": route_points,
    }


def compute_all_4_routes() -> Dict[str, dict]:
    routes: Dict[str, dict] = {}
    for nid, cfg in FOUR_PHONE_PRESETS.items():
        r = compute_astar_dem_route(cfg["row"], cfg["col"], cfg["max_wading_cm"])
        r["side"] = cfg["side"]
        r["vehicle_class"] = cfg["vehicle_class"]
        r["max_wading_cm"] = cfg["max_wading_cm"]
        routes[nid] = r
    return routes


def pack_36byte_sos_payload(
    node_id: str,
    lat: float,
    lng: float,
    alt_m: float,
    depth_cm: float,
    occupants: int,
    rf_band_mhz: int = 900,
) -> dict:
    ts = int(time.time())
    node_bytes = node_id.encode("utf-8")[:12].ljust(12, b"\x00")
    raw = struct.pack("!12sffffHHI", node_bytes, float(lat), float(lng), float(alt_m), float(depth_cm), int(occupants), int(rf_band_mhz), ts)
    node_b, u_lat, u_lng, u_alt, u_dep, u_occ, u_rf, u_ts = struct.unpack("!12sffffHHI", raw)
    return {
        "byte_size": len(raw),
        "hex_payload": raw.hex(),
        "hop_chain": [node_id, "RELAY_PEER_01", "DRONE_1_GATEWAY", "OPS_LAPTOP_4_4"],
        "decoded": {
            "node_id": node_b.rstrip(b"\x00").decode("utf-8", errors="ignore"),
            "lat": round(u_lat, 6),
            "lng": round(u_lng, 6),
            "altitude_m": round(u_alt, 1),
            "water_depth_cm": round(u_dep, 1),
            "occupants": u_occ,
            "rf_band_mhz": u_rf,
            "timestamp_utc": u_ts,
        },
    }
