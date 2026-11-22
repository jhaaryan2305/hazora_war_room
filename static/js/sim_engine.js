/**
 * HAZORA // PHASE 6 LOCKED 3-PILLAR DIGITAL TWIN ENGINE (/sim)
 * -------------------------------------------------------------------------
 * Strictly additive presentation director + interactive guardrail sandbox.
 * Drives live WebSocket updates across /ops and all connected /node phones.
 */
(function () {
  "use strict";

  const STAGE_NOTES = {
    1: "Baseline active: 3 radial flood traps around Laptop Safe Haven [4,4]. All 4 table phones hold verified dry A* routes.",
    2: "Guardrail 2 proof: 1.45g heavy truck shock tilts Smart Stake to 6.8°, but dry soil (42% < 80%) forces the AND-Gate to block the false alarm.",
    3: "52cm monsoon surge + 88.5% saturated landslide shear breach. Sedans (<15cm) and SUVs (<30cm) dynamically split onto different dry corridors.",
    4: "Pillar 2 handoff: Drone 1 flags low-confidence thermal anomaly WP-DRONE1-01 (37.4°C) and autonomously queues Drone 2 Rubble-Diver.",
    5: "Perch-and-Listen lock: Drone 2 disarms to 0 RPM (Guardrail 1), then fuses >=2/5 sensors (Butterworth Wi-Fi CSI breathing or 900MHz GSM RACH + CO2).",
  };

  const state = {
    activeStage: 1,
    lastCsi: null,
    ws: null,
  };

  const $ = (id) => document.getElementById(id);
  const setText = (id, v) => { const el = $(id); if (el) el.textContent = v; };

  function setStatusBanner(msg, tone) {
    const el = $("sim-banner");
    if (!el) return;
    el.textContent = msg;
    el.dataset.tone = tone || "info";
  }

  // ---------------- DUAL SCIPY DSP PLOTS (TIME WAVEFORM + FFT SPECTRUM) ----------------

  function drawCsiWaveform(csi) {
    const canvas = $("sim-csi-wave");
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(240, Math.floor(rect.width || 360));
    const h = Math.max(100, Math.floor(rect.height || 120));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = "rgba(148, 163, 184, 0.15)";
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    if (!csi || !csi.raw_waveform || !csi.filtered_waveform) {
      ctx.fillStyle = "rgba(148, 163, 184, 0.55)";
      ctx.font = "11px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillText("Run Drone 2 Scan to plot Butterworth Bandpass (0.15–0.50 Hz)", w / 2, h / 2 + 4);
      return;
    }

    const raw = csi.raw_waveform;
    const filt = csi.filtered_waveform;
    const mean = raw.reduce((a, b) => a + b, 0) / raw.length;

    const trace = (arr, color, width, offset) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      const dx = w / Math.max(1, arr.length - 1);
      arr.forEach((v, i) => {
        const y = h / 2 - (v - offset) * (h * 0.28);
        if (i === 0) ctx.moveTo(0, y);
        else ctx.lineTo(i * dx, y);
      });
      ctx.stroke();
    };

    trace(raw, "rgba(148, 163, 184, 0.35)", 1.3, mean);
    trace(filt, csi.respiration_detected ? "#34d399" : "#fb7185", 2.4, 0.0);
  }

  function drawCsiFft(csi) {
    const canvas = $("sim-csi-fft");
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(240, Math.floor(rect.width || 360));
    const h = Math.max(100, Math.floor(rect.height || 120));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (!csi || !csi.fft_freqs || !csi.fft_mags || !csi.fft_freqs.length) {
      ctx.fillStyle = "rgba(148, 163, 184, 0.55)";
      ctx.font = "11px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillText("FFT Frequency Spectrum (0.0 – 1.5 Hz)", w / 2, h / 2 + 4);
      return;
    }

    const freqs = csi.fft_freqs;
    const mags = csi.fft_mags;
    const maxF = Math.max(1.0, freqs[freqs.length - 1] || 1.5);
    const maxM = Math.max(5.0, ...mags);

    // Highlight human respiration passband (0.15 - 0.50 Hz = 9 - 30 BPM)
    const xLow = (0.15 / maxF) * w;
    const xHigh = (0.50 / maxF) * w;
    ctx.fillStyle = "rgba(16, 185, 129, 0.14)";
    ctx.fillRect(xLow, 0, Math.max(4, xHigh - xLow), h);
    ctx.fillStyle = "rgba(110, 231, 183, 0.75)";
    ctx.font = "9px ui-monospace, monospace";
    ctx.textAlign = "left";
    ctx.fillText("0.15–0.50Hz PASSBAND", xLow + 4, 12);

    // Draw FFT bars
    const barW = Math.max(3, (w / freqs.length) - 2);
    freqs.forEach((f, idx) => {
      const x = (f / maxF) * w;
      const barH = (mags[idx] / maxM) * (h - 24);
      const inBand = f >= 0.15 && f <= 0.50;
      ctx.fillStyle = inBand
        ? (csi.respiration_detected ? "#34d399" : "#fbbf24")
        : "rgba(148, 163, 184, 0.32)";
      ctx.fillRect(x, h - 14 - barH, barW, barH);
    });

    // Peak annotation
    ctx.fillStyle = "#e2e8f0";
    ctx.font = "bold 10px ui-monospace, monospace";
    ctx.textAlign = "right";
    ctx.fillText(`Peak: ${csi.peak_freq_hz || 0} Hz (${csi.computed_bpm || 0} BPM)`, w - 6, 12);
  }

  // ---------------- STATE RENDERERS ----------------

  function renderDrone2Result(d2) {
    if (!d2) return;
    setText("sim-d2-status", d2.status || "IDLE_PERCH_READY");
    setText("sim-d2-votes", d2.sensor_votes || "0/5");
    setText("sim-d2-reason", d2.reason || (d2.active_triggers && d2.active_triggers.join(" + ")) || "Disarm motors to 0 RPM and run scan.");

    const stEl = $("sim-d2-status");
    if (stEl) {
      stEl.className =
        d2.status === "SURVIVOR_LOCK_ACQUIRED"
          ? "text-sm font-black text-emerald-300"
          : d2.status === "REJECTED_PROP_WASH_GUARDRAIL"
          ? "text-sm font-black text-rose-400"
          : "text-sm font-bold text-amber-300";
    }

    if (d2.csi_dsp) {
      state.lastCsi = d2.csi_dsp;
      setText("sim-csi-metrics", `${d2.csi_dsp.computed_bpm} BPM • SNR ${d2.csi_dsp.snr_db} dB • Var ${d2.csi_dsp.csi_variance}`);
      drawCsiWaveform(d2.csi_dsp);
      drawCsiFft(d2.csi_dsp);
    }
  }

  function renderStakeResult(st) {
    if (!st) return;
    setText("sim-stake-verdict", st.status || "NOMINAL_MONITORING");
    setText("sim-stake-detail", st.mesh_sync || st.reason || "Awaiting telemetry injection.");
    const vEl = $("sim-stake-verdict");
    if (vEl) {
      vEl.className = st.and_gate_passed
        ? "text-xs font-black text-rose-300"
        : "text-xs font-black text-emerald-300";
    }
    const mGate = $("gate-moisture");
    const tGate = $("gate-tilt");
    if (mGate) mGate.dataset.tripped = Number(st.soil_moisture_pct || 0) >= 80 ? "true" : "false";
    if (tGate) tGate.dataset.tripped = Number(st.tilt_delta_deg || 0) >= 5 ? "true" : "false";
  }

  function renderSosResult(sos) {
    if (!sos) return;
    const dec = sos.decoded || {};
    setText("sim-sos-bytes", `${sos.byte_size || 36} BYTES PACKED`);
    setText("sim-sos-hex", sos.hex_payload || "--");
    setText(
      "sim-sos-decoded",
      `Node: ${dec.node_id || "--"} | Alt: ${dec.altitude_m || 0}m | Depth: ${dec.water_depth_cm || 0}cm | Occ: ${dec.occupants || 0} | Hops: ${(sos.hop_chain || []).join(" → ")}`
    );
  }

  function renderStageSelection(stageId) {
    state.activeStage = stageId;
    document.querySelectorAll("[data-sim-stage]").forEach((btn) => {
      btn.dataset.active = Number(btn.dataset.simStage) === stageId ? "true" : "false";
    });
    setText("sim-talking-point", STAGE_NOTES[stageId] || "");
  }

  function updateSystemCounts(data) {
    if (!data) return;
    if (typeof data.flood_water_level_cm === "number") {
      const fl = $("sim-flood-slider");
      if (fl) fl.value = data.flood_water_level_cm;
      setText("sim-flood-val", `${data.flood_water_level_cm} cm`);
    }
    if (Array.isArray(data.active_hazards)) {
      setText("sim-hazard-count", `${data.active_hazards.length} Hazards`);
    }
    if (data.live_nodes) {
      const connected = Object.values(data.live_nodes).filter((n) => n.connected).length;
      setText("sim-phone-count", `${connected}/4 Phones Live`);
    }
  }

  // ---------------- API TRIGGERS ----------------

  async function runStage(stageId, mode) {
    setStatusBanner(`Executing Stage ${stageId} (${mode || "csi"})...`, "info");
    const res = await fetch(`/hazora/sim/stage/${stageId}?mode=${mode || "csi"}`, { method: "POST" });
    const data = await res.json();
    renderStageSelection(stageId);
    setStatusBanner(data.summary || `Stage ${stageId} complete`, "safe");
    if (data.detail && data.detail.drone2) renderDrone2Result(data.detail.drone2);
    if (data.detail && data.detail.stake) renderStakeResult(data.detail.stake);
    hydrateState();
  }

  async function runCustomDrone2Scan() {
    const disarmed = $("sim-rpm-toggle") ? $("sim-rpm-toggle").checked : true;
    const rpm = disarmed ? 0 : 4200;
    const csiEnabled = $("sim-csi-enable") ? $("sim-csi-enable").checked : true;
    const csiBpm = csiEnabled ? Number($("sim-csi-bpm").value) : null;
    const gsmVal = $("sim-gsm-enable") && $("sim-gsm-enable").checked ? Number($("sim-gsm-dbm").value) : -100.0;
    const wifiVal = $("sim-wifi-enable") && $("sim-wifi-enable").checked ? -62.0 : -100.0;
    const piezoVal = Number($("sim-piezo-db").value);
    const co2Val = Number($("sim-co2-ppm").value);

    const deviceClass =
      gsmVal > -75 ? "2G_KEYPAD_FEATURE_PHONE" :
      csiEnabled ? "DEVICE_FREE_UNCONSCIOUS_SURVIVOR" :
      "SMARTPHONE_WIFI_NODE";

    const res = await fetch("/hazora/air/rubble_diver_scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        waypoint_id: "WP-SIM-SANDBOX",
        is_motor_disarmed: disarmed,
        rotor_rpm: rpm,
        gsm_900mhz_rach_burst_dbm: gsmVal,
        wifi_24ghz_rssi_dbm: wifiVal,
        piezo_acoustic_db: piezoVal,
        mq135_co2_ppm: co2Val,
        csi_breathing_bpm: csiBpm,
        detected_device_class: deviceClass,
      }),
    });
    const out = await res.json();
    renderDrone2Result(out);
    setStatusBanner(`Drone 2 Scan -> ${out.status} (${out.sensor_votes})`, out.status === "SURVIVOR_LOCK_ACQUIRED" ? "safe" : "danger");
  }

  async function sendSmartStake(moisture, tilt, vib) {
    if ($("sim-stake-moisture")) $("sim-stake-moisture").value = moisture;
    if ($("sim-stake-tilt")) $("sim-stake-tilt").value = tilt;
    if ($("sim-stake-vib")) $("sim-stake-vib").value = vib;
    setText("sim-stake-moisture-val", `${moisture}%`);
    setText("sim-stake-tilt-val", `${tilt}°`);
    setText("sim-stake-vib-val", `${vib}g`);

    const res = await fetch("/hazora/ground/stake_telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stake_id: "STAKE-WARD-01",
        sector_row: 4,
        sector_col: 2,
        soil_moisture_pct: Number(moisture),
        tilt_delta_deg: Number(tilt),
        vibration_g: Number(vib),
      }),
    });
    const out = await res.json();
    renderStakeResult(out);
    setStatusBanner(`Smart Stake -> ${out.status}`, out.and_gate_passed ? "danger" : "safe");
  }

  async function fireSimulatedSos() {
    const node = $("sim-sos-node") ? $("sim-sos-node").value : "ANDROID_01_SEDAN";
    const occ = Number($("sim-sos-occ") ? $("sim-sos-occ").value : 3);
    const res = await fetch("/hazora/core/sos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trapped_node_id: node,
        device_type: "SIM_MESH_NODE",
        location: { lat: 12.9732, lng: 77.5941, elevation_m: 896.0 },
        barometric_alt_m: 896.0,
        water_depth_cm: 62.0,
        occupant_count: occ,
      }),
    });
    const out = await res.json();
    renderSosResult(out);
    setStatusBanner(`36-Byte Binary SOS Burst sent from ${node} (${occ} occupants)`, "danger");
  }

  async function hydrateState() {
    try {
      const res = await fetch("/hazora/state");
      const data = await res.json();
      updateSystemCounts(data);
      renderStageSelection(data.active_stage || 1);
      if (data.drone2_result) renderDrone2Result(data.drone2_result);
      if (data.stake_telemetry) renderStakeResult(data.stake_telemetry);
      if (data.last_sos) renderSosResult(data.last_sos);
    } catch (_) {}
  }

  function connectWebSocket() {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}/ws/mission_control`);
    state.ws = ws;
    ws.onopen = () => setText("sim-ws-pill", "SYNC LIVE");
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      const d = msg.data || {};
      if (msg.type === "rubble_diver_lock") renderDrone2Result(d);
      else if (msg.type === "smart_stake_telemetry") renderStakeResult(d);
      else if (msg.type === "sos_mesh_burst") renderSosResult(d);
      else if (msg.type === "director_stage") renderStageSelection(d.stage_id || 1);
      else if (msg.type === "node_telemetry" || msg.type === "p2p_hazard_gossip" || msg.type === "flood_level_update" || msg.type === "demo_reset") {
        hydrateState();
      }
    };
    ws.onclose = () => {
      setText("sim-ws-pill", "RECONNECTING");
      setTimeout(connectWebSocket, 2500);
    };
  }

  function wireControls() {
    document.querySelectorAll("[data-sim-stage]").forEach((btn) => {
      btn.addEventListener("click", () => runStage(Number(btn.dataset.simStage), btn.dataset.mode || "csi"));
    });

    // Live slider readouts
    const bindSlider = (id, outId, suffix) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener("input", () => setText(outId, `${el.value}${suffix}`));
    };
    bindSlider("sim-flood-slider", "sim-flood-val", " cm");
    bindSlider("sim-csi-bpm", "sim-csi-bpm-val", " BPM");
    bindSlider("sim-gsm-dbm", "sim-gsm-dbm-val", " dBm");
    bindSlider("sim-piezo-db", "sim-piezo-db-val", " dB");
    bindSlider("sim-co2-ppm", "sim-co2-ppm-val", " ppm");
    bindSlider("sim-stake-moisture", "sim-stake-moisture-val", "%");
    bindSlider("sim-stake-tilt", "sim-stake-tilt-val", "°");
    bindSlider("sim-stake-vib", "sim-stake-vib-val", "g");

    const floodSlider = $("sim-flood-slider");
    if (floodSlider) {
      floodSlider.addEventListener("change", async () => {
        const res = await fetch("/hazora/core/mesh/flood_level", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ water_level_cm: Number(floodSlider.value) }),
        });
        const out = await res.json();
        setStatusBanner(out.event_summary || `Flood level set to ${floodSlider.value}cm`, "info");
      });
    }

    const rpmToggle = $("sim-rpm-toggle");
    if (rpmToggle) {
      rpmToggle.addEventListener("change", () => {
        setText("sim-rpm-label", rpmToggle.checked ? "MOTORS DISARMED (0 RPM — SAFE TO LISTEN)" : "MOTORS ARMED (4200 RPM — PROP-WASH NOISE!)");
      });
    }

    if ($("btn-sim-run-d2")) $("btn-sim-run-d2").addEventListener("click", runCustomDrone2Scan);

    if ($("btn-stake-send")) {
      $("btn-stake-send").addEventListener("click", () => {
        sendSmartStake($("sim-stake-moisture").value, $("sim-stake-tilt").value, $("sim-stake-vib").value);
      });
    }
    if ($("btn-stake-nominal")) $("btn-stake-nominal").addEventListener("click", () => sendSmartStake(38, 0.6, 0.04));
    if ($("btn-stake-truck")) $("btn-stake-truck").addEventListener("click", () => sendSmartStake(42, 6.8, 1.45));
    if ($("btn-stake-breach")) $("btn-stake-breach").addEventListener("click", () => sendSmartStake(88.5, 9.4, 0.92));

    if ($("btn-sim-sos")) $("btn-sim-sos").addEventListener("click", fireSimulatedSos);

    if ($("btn-sim-reset")) {
      $("btn-sim-reset").addEventListener("click", async () => {
        await fetch("/hazora/core/mesh/reset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clear_all_red_zones: false }),
        });
        setStatusBanner("Baseline 3-cell radial traps restored across /ops and all phones.", "safe");
      });
    }
    if ($("btn-sim-clear")) {
      $("btn-sim-clear").addEventListener("click", async () => {
        await fetch("/hazora/core/mesh/reset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clear_all_red_zones: true }),
        });
        setStatusBanner("100% of red hazard zones cleared.", "safe");
      });
    }
  }

  function boot() {
    wireControls();
    hydrateState();
    connectWebSocket();
    window.addEventListener("resize", () => {
      drawCsiWaveform(state.lastCsi);
      drawCsiFft(state.lastCsi);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
