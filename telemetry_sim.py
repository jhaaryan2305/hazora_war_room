import os
import httpx

API_URL = os.getenv("HAZORA_SERVER_URL", "https://127.0.0.1:8443")
client = httpx.Client(verify=False, timeout=4.0)


def run_stage(n: int, mode: str = "csi"):
    res = client.post(f"{API_URL}/hazora/sim/stage/{n}", params={"mode": mode})
    print(f"\n[STAGE {n} ({mode})] ->", res.json().get("summary"))


def test_prop_wash_interlock():
    res = client.post(f"{API_URL}/hazora/air/rubble_diver_scan", json={
        "waypoint_id": "WP-DRONE1-01",
        "is_motor_disarmed": False,
        "rotor_rpm": 4200,
        "csi_breathing_bpm": 16.2,
        "mq135_co2_ppm": 800.0,
        "detected_device_class": "DEVICE_FREE_UNCONSCIOUS_SURVIVOR",
    })
    print("\n[PROP-WASH INTERLOCK TEST] ->", res.json().get("status"), "|", res.json().get("reason"))


def main_menu():
    while True:
        print(f"\n========== HAZORA DIRECTOR CLI ({API_URL}) ==========")
        print("1. Stage 1: Calm Baseline Reset")
        print("2. Stage 2: Heavy Truck Vibration (AND-Gate Blocks False Alarm)")
        print("3. Stage 3: 52cm Monsoon Surge + Landslide Shear Breach")
        print("4. Stage 4: Drone 1 Thermal Void Lock -> Queue Drone 2")
        print("5. Stage 5A: Drone 2 Device-Free UNCONSCIOUS Survivor (Wi-Fi CSI 16.2 BPM + CO2)")
        print("6. Stage 5B: Drone 2 Buried 2G KEYPAD PHONE (900MHz RACH + Piezo + CO2)")
        print("7. Guardrail 1 Test: Drone 2 Scan With Rotors Armed (Must Reject)")
        print("0. Clear 100% Red Zones")
        print("q. Quit")
        c = input("Select command: ").strip().lower()
        if c == "1": run_stage(1)
        elif c == "2": run_stage(2)
        elif c == "3": run_stage(3)
        elif c == "4": run_stage(4)
        elif c == "5": run_stage(5, "csi")
        elif c == "6": run_stage(5, "keypad")
        elif c == "7": test_prop_wash_interlock()
        elif c == "0":
            r = client.post(f"{API_URL}/hazora/core/mesh/reset", json={"clear_all_red_zones": True})
            print("\n[CLEAR ALL] ->", r.json().get("status"))
        elif c == "q":
            break


if __name__ == "__main__":
    main_menu()
