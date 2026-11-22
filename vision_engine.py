import argparse
import os
import platform
import threading
import time
from typing import Optional

import cv2
import httpx
import numpy as np
import torch
from ultralytics import YOLO

DEFAULT_API_URL = os.getenv("HAZORA_SERVER_URL", "https://127.0.0.1:8443")

VEHICLE_CLASSES = {1, 2, 3, 5, 7}
RF_NODE_CLASSES = {63, 67}

LATEST_UPLOAD_LOCK = threading.Lock()
LATEST_OPT_BYTES: Optional[bytes] = None
LATEST_THM_BYTES: Optional[bytes] = None
LATEST_TELEMETRY: Optional[dict] = None
STREAMER_RUNNING = True


def detect_compute_device() -> str:
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def open_capture(source_arg: str):
    is_file = False
    if source_arg.isdigit():
        src = int(source_arg)
        if platform.system() == "Darwin":
            cap = cv2.VideoCapture(src, cv2.CAP_AVFOUNDATION)
        elif platform.system() == "Windows":
            cap = cv2.VideoCapture(src, cv2.CAP_DSHOW)
        else:
            cap = cv2.VideoCapture(src)
        if not cap.isOpened():
            cap = cv2.VideoCapture(src)
    else:
        is_file = True
        cap = cv2.VideoCapture(source_arg)

    if cap.isOpened() and not is_file:
        # Never force MJPG on macOS AVFoundation (breaks Continuity Camera / FaceTime negotiation)
        if platform.system() != "Darwin":
            cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"M", "J", "P", "G"))
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        cap.set(cv2.CAP_PROP_FPS, 30)

    return cap, is_file


def list_available_cameras(max_idx: int = 4):
    print("[HAZORA AIR] Probing camera indices 0..3...")
    found = []
    for idx in range(max_idx):
        cap, _ = open_capture(str(idx))
        if cap.isOpened():
            ret, frame = cap.read()
            if ret and frame is not None:
                h, w = frame.shape[:2]
                print(f"  -> Index {idx}: ACTIVE ({w}x{h})")
                found.append(idx)
            cap.release()
    if not found:
        print("  -> No cameras found. Check macOS Privacy & Security -> Camera permission.")


def background_lan_streamer(api_url: str):
    global LATEST_OPT_BYTES, LATEST_THM_BYTES, LATEST_TELEMETRY
    last_telemetry_push = 0.0

    with httpx.Client(verify=False, timeout=0.8) as client:
        while STREAMER_RUNNING:
            opt_b, thm_b, telem = None, None, None
            with LATEST_UPLOAD_LOCK:
                if LATEST_OPT_BYTES is not None:
                    opt_b = LATEST_OPT_BYTES
                    thm_b = LATEST_THM_BYTES
                    LATEST_OPT_BYTES = None
                if LATEST_TELEMETRY is not None:
                    telem = LATEST_TELEMETRY

            if opt_b is not None and thm_b is not None:
                try:
                    client.post(
                        f"{api_url}/hazora/air/push_frame",
                        files={
                            "optical": ("opt.jpg", opt_b, "image/jpeg"),
                            "thermal": ("thm.jpg", thm_b, "image/jpeg"),
                        },
                    )
                except Exception:
                    pass

            now = time.time()
            if telem is not None and (now - last_telemetry_push) >= 0.5:
                try:
                    client.post(f"{api_url}/hazora/air/vision_telemetry", json=telem)
                    last_telemetry_push = now
                except Exception:
                    pass

            time.sleep(0.14)


def trigger_drone1_waypoint(
    api_url: str,
    marker_type: str,
    conf: float,
    slope_deg: float,
    water_cm: float,
    wp_counter: int,
):
    payload = {
        "waypoint_id": f"WP-DRONE1-{wp_counter:02d}",
        "marker_type": marker_type,
        "location": {"lat": 12.9748, "lng": 77.5948, "elevation_m": 904.5},
        "yolo_confidence": round(conf, 2),
        "thermal_max_c": 37.4,
        "slope_drop_degrees": slope_deg,
        "estimated_water_depth_cm": water_cm,
        "notes": f"Auto-flagged by Drone 1 ({marker_type}) -> Queued for Drone 2 Perch-and-Listen",
    }

    def _send():
        try:
            with httpx.Client(verify=False, timeout=1.5) as client:
                client.post(f"{api_url}/hazora/air/mark_waypoint", json=payload)
        except Exception:
            pass

    threading.Thread(target=_send, daemon=True).start()


def generate_fast_thermal_pip(anomaly_active: bool = False):
    base_temp = np.random.normal(18.5, 0.8, (24, 32)).astype(np.float32)
    if anomaly_active:
        yc, xc = 12, 16
    else:
        yc = 10 + int(time.time() * 2) % 6
        xc = 14 + int(time.time() * 3) % 6
    base_temp[yc - 3 : yc + 4, xc - 3 : xc + 4] = 37.4
    norm_temp = cv2.normalize(base_temp, None, 0, 255, cv2.NORM_MINMAX, dtype=cv2.CV_8U)
    heatmap = cv2.applyColorMap(norm_temp, cv2.COLORMAP_INFERNO)
    return cv2.resize(heatmap, (180, 135), interpolation=cv2.INTER_NEAREST)


def draw_tactical_reticle(frame, x1: int, y1: int, x2: int, y2: int, color):
    corner = max(14, min(28, (x2 - x1) // 5))
    cv2.line(frame, (x1, y1), (x1 + corner, y1), (0, 255, 255), 4)
    cv2.line(frame, (x1, y1), (x1, y1 + corner), (0, 255, 255), 4)
    cv2.line(frame, (x2, y1), (x2 - corner, y1), (0, 255, 255), 4)
    cv2.line(frame, (x2, y1), (x2, y1 + corner), (0, 255, 255), 4)
    cv2.line(frame, (x1, y2), (x1 + corner, y2), (0, 255, 255), 4)
    cv2.line(frame, (x1, y2), (x1, y2 - corner), (0, 255, 255), 4)
    cv2.line(frame, (x2, y2), (x2 - corner, y2), (0, 255, 255), 4)
    cv2.line(frame, (x2, y2), (x2, y2 - corner), (0, 255, 255), 4)

    cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
    cv2.circle(frame, (cx, cy), 5, (0, 255, 255), -1)
    cv2.circle(frame, (cx, cy), 14, color, 2)


def draw_cached_detections(frame, cached_boxes, class_names):
    water_depth_cm = 18.0
    max_conf = 0.0
    survivor_count = 0

    for idx, box in enumerate(cached_boxes):
        x1, y1, x2, y2 = map(int, box[:4])
        conf = float(box[4])
        cls_id = int(box[5])
        raw_name = class_names.get(cls_id, "object").upper()
        max_conf = max(max_conf, conf)

        if idx == 0:
            box_h = max(1.0, float(y2 - y1))
            box_w = max(1.0, float(x2 - x1))
            water_depth_cm = round(max(14.0, min(76.0, (1.25 - min(box_h / box_w, 1.1)) * 62.0)), 1)

        if cls_id == 0:
            survivor_count += 1
            box_color = (40, 20, 255)
            text_color = (255, 255, 255)
            label = f"SURVIVOR #{survivor_count} [37.4C] {int(conf * 100)}%"
            cv2.rectangle(frame, (x1, y1), (x2, y2), box_color, 3)
            draw_tactical_reticle(frame, x1, y1, x2, y2, box_color)
        elif cls_id in VEHICLE_CLASSES:
            box_color = (255, 220, 0)
            text_color = (10, 14, 23)
            label = f"VEHICLE ({raw_name}) | DEPTH: {water_depth_cm}cm"
            cv2.rectangle(frame, (x1, y1), (x2, y2), box_color, 2)
        elif cls_id in RF_NODE_CLASSES:
            box_color = (0, 200, 255)
            text_color = (10, 14, 23)
            label = f"RF SIGNAL NODE ({raw_name}) {int(conf * 100)}%"
            cv2.rectangle(frame, (x1, y1), (x2, y2), box_color, 2)
        elif conf < 0.45:
            box_color = (200, 0, 255)
            text_color = (255, 255, 255)
            label = f"UNIDENTIFIED ANOMALY ({int(conf * 100)}%) -> DRONE 2"
            cv2.rectangle(frame, (x1, y1), (x2, y2), box_color, 2)
        else:
            box_color = (140, 160, 70)
            text_color = (255, 255, 255)
            label = f"{raw_name} {int(conf * 100)}%"
            cv2.rectangle(frame, (x1, y1), (x2, y2), box_color, 1)

        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.48, 2)
        top_y = max(th + 8, y1)
        cv2.rectangle(frame, (x1, top_y - th - 8), (x1 + tw + 10, top_y), box_color, -1)
        cv2.putText(frame, label, (x1 + 5, top_y - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.48, text_color, 2)

    return water_depth_cm, max_conf, survivor_count


def run_vision_pipeline(source_arg: str, api_url: str, headless: bool = False):
    global LATEST_OPT_BYTES, LATEST_THM_BYTES, LATEST_TELEMETRY, STREAMER_RUNNING

    active_device = detect_compute_device()
    print(f"[HAZORA AIR] Initializing Drone 1 Vision Engine on: {active_device.upper()} -> {api_url}")
    model = YOLO("yolov8n.pt")

    cap, is_file = open_capture(source_arg)
    if not cap.isOpened():
        print(f"[ERROR] Could not open source '{source_arg}'. Try --list-cameras or pass a video file path.")
        return

    threading.Thread(target=background_lan_streamer, args=(api_url,), daemon=True).start()

    wp_counter = 1
    frame_idx = 0
    cached_boxes = []
    class_names = model.names
    slope_shear_deg = 18.4
    upscaled_thermal = generate_fast_thermal_pip(False)
    last_inference_ms = 12.0
    last_banner_text = "Keys: [M] Mark Void | [D] Drop | [R] Reset | [Q] Quit"

    prev_frame_time = time.time()
    smooth_fps = 30.0

    try:
        while True:
            ret, frame = cap.read()
            if not ret or frame is None:
                if is_file:
                    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                    continue
                time.sleep(0.05)
                continue

            if frame.shape[1] > 960:
                frame = cv2.resize(frame, (640, 480))

            now = time.time()
            dt = max(now - prev_frame_time, 1e-4)
            prev_frame_time = now
            smooth_fps = 0.85 * smooth_fps + 0.15 * (1.0 / dt)
            frame_idx += 1

            if frame_idx % 3 == 0:
                t0 = time.time()
                try:
                    results = model.predict(frame, device=active_device, imgsz=320, conf=0.28, verbose=False)
                except Exception as exc:
                    if active_device != "cpu":
                        print(f"[WARN] {active_device.upper()} fallback to CPU: {exc}")
                        active_device = "cpu"
                        results = model.predict(frame, device="cpu", imgsz=320, conf=0.28, verbose=False)
                    else:
                        raise
                last_inference_ms = (time.time() - t0) * 1000.0
                if len(results[0].boxes) > 0:
                    cached_boxes = results[0].boxes.data.cpu().numpy()
                else:
                    cached_boxes = []

                if frame_idx % 6 == 0:
                    roi_gray = cv2.cvtColor(frame[frame.shape[0] // 2 :, ::2], cv2.COLOR_BGR2GRAY)
                    edges = cv2.Canny(roi_gray, 80, 160)
                    edge_density = float(np.count_nonzero(edges)) / float(roi_gray.size)
                    slope_shear_deg = round(min(54.0, 14.0 + edge_density * 280.0), 1)
                    upscaled_thermal = generate_fast_thermal_pip(len(cached_boxes) > 0)

            water_depth_cm, max_conf, survivor_count = draw_cached_detections(frame, cached_boxes, class_names)

            th, tw = upscaled_thermal.shape[:2]
            if frame.shape[0] > th + 20 and frame.shape[1] > tw + 20:
                frame[10 : 10 + th, -tw - 10 : -10] = upscaled_thermal
                cv2.putText(
                    frame,
                    "MLX90640 32x24 IR",
                    (frame.shape[1] - tw - 10, 25),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.42,
                    (255, 255, 255),
                    1,
                )

            target_locked = len(cached_boxes) > 0
            link_mode = "30 FPS PRIORITY LOCK" if target_locked else "2 FPS HEARTBEAT"
            bw_saved = 0.0 if target_locked else 85.0

            cv2.rectangle(frame, (5, 5), (445, 175), (10, 14, 23), -1)
            cv2.putText(
                frame,
                f"HAZORA Tensor Pipe ({active_device.upper()}): {last_inference_ms:.1f} ms | Video: {smooth_fps:.1f} FPS",
                (12, 26),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.46,
                (180, 255, 180),
                1,
            )
            cv2.putText(
                frame,
                f"SURVIVORS LOCKED: {survivor_count} (CRITICAL RED RETICLE)",
                (12, 50),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.50,
                (60, 40, 255) if survivor_count > 0 else (160, 160, 160),
                2,
            )
            cv2.putText(
                frame,
                f"WHEEL-RIM FLOOD DEPTH EST: {water_depth_cm:.1f} cm",
                (12, 74),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.48,
                (255, 220, 0),
                2,
            )
            cv2.putText(
                frame,
                f"TERRAIN SLOPE GRADIENT: {slope_shear_deg:.1f} deg",
                (12, 98),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.48,
                (0, 200, 255),
                2,
            )
            cv2.putText(
                frame,
                f"LINK: {link_mode} ({int(bw_saved)}% BW SAVED)",
                (12, 120),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.44,
                (200, 160, 255),
                1,
            )
            cv2.putText(
                frame,
                "COLOR KEY: [RED] Survivor  [CYAN] Vehicle  [AMBER] RF Node",
                (12, 142),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.41,
                (220, 220, 220),
                1,
            )
            cv2.putText(frame, last_banner_text, (12, 164), cv2.FONT_HERSHEY_SIMPLEX, 0.40, (255, 255, 255), 1)

            if frame_idx % 4 == 0 and not LATEST_UPLOAD_LOCK.locked():
                _, opt_jpg = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 58])
                _, thm_jpg = cv2.imencode(".jpg", upscaled_thermal, [int(cv2.IMWRITE_JPEG_QUALITY), 65])
                with LATEST_UPLOAD_LOCK:
                    LATEST_OPT_BYTES = opt_jpg.tobytes()
                    LATEST_THM_BYTES = thm_jpg.tobytes()
                    LATEST_TELEMETRY = {
                        "device": active_device.upper(),
                        "fps": round(smooth_fps, 1),
                        "inference_ms": round(last_inference_ms, 1),
                        "survivors_locked": survivor_count,
                        "water_depth_cm": water_depth_cm,
                        "slope_shear_deg": slope_shear_deg,
                        "link_mode": link_mode,
                        "bandwidth_saved_pct": bw_saved,
                    }

            if not headless:
                cv2.imshow("HAZORA Air - Drone 1 Eye in the Sky", frame)
                key = cv2.waitKey(1) & 0xFF
                if key == ord("q"):
                    break
                elif key == ord("r"):
                    wp_counter = 1
                    last_banner_text = "[SYSTEM RESET] Drone 1 Waypoint Tracker Reset to 01"
                elif key == ord("m"):
                    trigger_drone1_waypoint(
                        api_url,
                        marker_type="UNIDENTIFIED_THERMAL_ANOMALY",
                        conf=0.38 if max_conf == 0 else max_conf,
                        slope_deg=slope_shear_deg,
                        water_cm=water_depth_cm,
                        wp_counter=wp_counter,
                    )
                    last_banner_text = f"HANDOFF SENT: WP-DRONE1-{wp_counter:02d} (VOID -> DRONE 2)"
                    wp_counter += 1
                elif key == ord("d"):
                    trigger_drone1_waypoint(
                        api_url,
                        marker_type="STEEP_ELEVATION_DROP",
                        conf=0.82,
                        slope_deg=42.5,
                        water_cm=54.0,
                        wp_counter=wp_counter,
                    )
                    last_banner_text = f"HAZARD MARKED: WP-DRONE1-{wp_counter:02d} (42.5 deg STEEP DROP)"
                    wp_counter += 1
            else:
                time.sleep(0.01)
    except KeyboardInterrupt:
        pass
    finally:
        STREAMER_RUNNING = False
        cap.release()
        if not headless:
            cv2.destroyAllWindows()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="HAZORA Drone 1 Vision Engine")
    parser.add_argument("--source", default="0", help="Camera index (0, 1, ...) or path to .mp4 video file")
    parser.add_argument("--server", default=DEFAULT_API_URL, help="Master Kernel HTTPS/HTTP URL")
    parser.add_argument("--headless", action="store_true", help="Run without OpenCV GUI window")
    parser.add_argument("--list-cameras", action="store_true", help="Probe available camera indices and exit")
    args = parser.parse_args()

    if args.list_cameras:
        list_available_cameras()
    else:
        run_vision_pipeline(source_arg=args.source, api_url=args.server, headless=args.headless)
