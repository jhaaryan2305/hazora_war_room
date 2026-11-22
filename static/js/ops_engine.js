/**
 * HAZORA // PHASE 5 LOCKED MISSION CONTROL ENGINE (/ops)
 */
(function () {
  "use strict";

  const GRID_SIZE = 9;
  const HAVEN_R = 4;
  const HAVEN_C = 4;

  const NODE_STYLES = {
    ANDROID_01_SEDAN:  { label: "SOUTH • SEDAN",  color: "#38bdf8" },
    IPHONE_16_PRO_MAX: { label: "NORTH • iPHONE", color: "#c084fc" },
    ANDROID_02_SUV:    { label: "EAST • SUV",     color: "#fbbf24" },
    ANDROID_03_SAR:    { label: "WEST • SAR",     color: "#34d399" },
  };

  const state = {
    demGrid: [],
    hazards: [],
    safeZones: [],
    routes: {},
    liveNodes: {},
    floodLevelCm: 0,
    tableNorthOffsetDeg: 0,
    activeStage: 1,
    mapTool: "ADD_HAZARD",
    csiData: null,
    ws: null,
  };

  const $ = (id) => document.getElementById(id);
  const setText = (id, v) => { const el = $(id); if (el) el.textContent = v; };

  function pushEventLog(tag, msg, tone) {
    const log = $("ops-event-log");
    if (!log) return;
    const t = new Date().toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const row = document.createElement("div");
    const toneCls =
      tone === "danger" ? "border-rose-500/40 bg-rose-950/35 text-rose-200" :
      tone === "safe"   ? "border-emerald-500/40 bg-emerald-950/35 text-emerald-200" :
      tone === "warn"   ? "border-amber-500/40 bg-amber-950/35 text-amber-200" :
                          "border-slate-700/60 bg-slate-900/50 text-slate-200";
    row.className = `px-2.5 py-1.5 rounded-lg border text-[11px] leading-snug ${toneCls}`;
    row.innerHTML = `<span class="opacity-60 font-mono mr-1.5">${t}</span><span class="font-bold mr-1.5">[${tag}]</span>${msg}`;
    log.prepend(row);
    while (log.children.length > 40) log.removeChild(log.lastChild);
  }

  function drawRadialMap() {
    const canvas = $("ops-map-canvas");
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const size = Math.max(320, Math.floor(Math.min(rect.width || 520, rect.height || 520)));
    if (canvas.width !== size * dpr || canvas.height !== size * dpr) {
      canvas.width = size * dpr;
      canvas.height = size * dpr;
    }

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    const pad = 28;
    const inner = size - pad * 2;
    const cell = inner / GRID_SIZE;

    const cellCenter = (r, c) => ({
      x: pad + (c + 0.5) * cell,
      y: pad + (GRID_SIZE - 1 - r + 0.5) * cell,
    });

    const hazardMap = new Map();
    state.hazards.forEach((h) => hazardMap.set(`${h.grid_row},${h.grid_col}`, h));
    const sarClearSet = new Set(
      state.safeZones.filter((z) => z.zone_type === "SAR_VERIFIED_CLEAR").map((z) => `${z.grid_row},${z.grid_col}`)
    );

    for (let r = 0; r < GRID_SIZE; r++) {
      for (let c = 0; c < GRID_SIZE; c++) {
        const x = pad + c * cell;
        const y = pad + (GRID_SIZE - 1 - r) * cell;
        const elev = state.demGrid[r] ? state.demGrid[r][c] : 905;
        const key = `${r},${c}`;
        const hz = hazardMap.get(key);

        if (r === HAVEN_R && c === HAVEN_C) {
          ctx.fillStyle = "rgba(16, 185, 129, 0.34)";
        } else if (hz) {
          ctx.fillStyle = hz.depth_cm > 30 ? "rgba(225, 29, 72, 0.52)" : "rgba(245, 158, 11, 0.42)";
        } else if (sarClearSet.has(key)) {
          ctx.fillStyle = "rgba(16, 185, 129, 0.24)";
        } else {
          const t = Math.max(0, Math.min(1, (elev - 892) / 56));
          ctx.fillStyle = `rgba(30, ${Math.round(52 + t * 55)}, ${Math.round(78 + t * 42)}, 0.48)`;
        }

        ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2);
        ctx.strokeStyle = "rgba(148, 163, 184, 0.14)";
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 1, y + 1, cell - 2, cell - 2);

        ctx.textAlign = "center";
        if (hz) {
          ctx.fillStyle = "#ffe4e6";
          ctx.font = "bold 10px ui-monospace, monospace";
          ctx.fillText(`${Math.round(hz.depth_cm)}cm`, x + cell / 2, y + cell / 2 + 3);
        } else if (sarClearSet.has(key)) {
          ctx.fillStyle = "#6ee7b7";
          ctx.font = "bold 9px ui-sans-serif, system-ui, sans-serif";
          ctx.fillText("✓ CLEAR", x + cell / 2, y + cell / 2 + 3);
        } else if (!(r === HAVEN_R && c === HAVEN_C)) {
          ctx.fillStyle = "rgba(148, 163, 184, 0.42)";
          ctx.font = "9px ui-monospace, monospace";
          ctx.fillText(`${Math.round(elev)}m`, x + cell / 2, y + cell - 6);
        }
      }
    }

    ctx.fillStyle = "#94a3b8";
    ctx.font = "bold 10px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`NORTH SIDE (TOP OF LAPTOP • OFFSET ${Math.round(state.tableNorthOffsetDeg)}°)`, size / 2, 16);
    ctx.fillText("SOUTH SIDE (SEDAN SPAWN)", size / 2, size - 8);
    ctx.save();
    ctx.translate(13, size / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("WEST (SAR)", 0, 0);
    ctx.restore();
    ctx.save();
    ctx.translate(size - 13, size / 2);
    ctx.rotate(Math.PI / 2);
    ctx.fillText("EAST (SUV)", 0, 0);
    ctx.restore();

    Object.entries(state.routes).forEach(([nid, rObj]) => {
      const style = NODE_STYLES[nid] || { color: "#38bdf8" };
      const pts = rObj.safe_haven_route || [];
      if (pts.length < 2) return;
      ctx.save();
      ctx.strokeStyle = style.color;
      ctx.lineWidth = 3;
      ctx.globalAlpha = 0.78;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      pts.forEach((pt, idx) => {
        const p = cellCenter(pt.grid_row, pt.grid_col);
        if (idx === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();
      ctx.restore();
    });

    const center = cellCenter(HAVEN_R, HAVEN_C);
    const pulseGrad = ctx.createRadialGradient(center.x, center.y, 4, center.x, center.y, cell * 0.85);
    pulseGrad.addColorStop(0, "rgba(16, 185, 129, 0.55)");
    pulseGrad.addColorStop(1, "rgba(16, 185, 129, 0.0)");
    ctx.fillStyle = pulseGrad;
    ctx.beginPath();
    ctx.arc(center.x, center.y, cell * 0.85, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#10b981";
    ctx.strokeStyle = "#ecfdf5";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(center.x, center.y, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#022c22";
    ctx.font = "bold 12px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("★", center.x, center.y + 4);
    ctx.fillStyle = "#a7f3d0";
    ctx.font = "bold 9px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText("LAPTOP 948m", center.x, center.y + 23);

    Object.entries(state.liveNodes).forEach(([nid, node]) => {
      const style = NODE_STYLES[nid] || { label: nid, color: "#f8fafc" };
      const px = pad + (node.pos_col + 0.5) * cell;
      const py = pad + (GRID_SIZE - 1 - node.pos_row + 0.5) * cell;
      const hRad = ((node.heading_deg || 0) * Math.PI) / 180;

      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(hRad);
      ctx.fillStyle = node.arrived ? "#10b981" : node.danger ? "#f43f5e" : style.color;
      ctx.strokeStyle = "#020617";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, -11);
      ctx.lineTo(8, 8);
      ctx.lineTo(0, 4);
      ctx.lineTo(-8, 8);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      if (node.connected) {
        ctx.strokeStyle = style.color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(px, py, 15, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.fillStyle = "rgba(2, 6, 23, 0.85)";
      const tag = node.arrived ? `${style.label} ✓` : `${style.label}`;
      ctx.font = "bold 9px ui-sans-serif, system-ui, sans-serif";
      const tw = ctx.measureText(tag).width + 8;
      ctx.fillRect(px - tw / 2, py - 26, tw, 13);
      ctx.fillStyle = node.arrived ? "#6ee7b7" : style.color;
      ctx.textAlign = "center";
      ctx.fillText(tag, px, py - 16);
    });
  }

  function wireMapClickControls() {
    const canvas = $("ops-map-canvas");
    if (!canvas) return;
    canvas.addEventListener("click", async (ev) => {
      const rect = canvas.getBoundingClientRect();
      const size = Math.min(rect.width, rect.height);
      const pad = 28;
      const cell = (size - pad * 2) / GRID_SIZE;
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      const c = Math.floor((x - pad) / cell);
      const r = GRID_SIZE - 1 - Math.floor((y - pad) / cell);
      if (r < 0 || r >= GRID_SIZE || c < 0 || c >= GRID_SIZE) return;
      if (r === HAVEN_R && c === HAVEN_C) return;

      const isClear = state.mapTool === "CLEAR_HAZARD";
      await fetch("/hazora/core/mesh/gossip_hazard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: state.mapTool,
          grid_row: r,
          grid_col: c,
          water_depth_cm: isClear ? 0.0 : 68.0,
          hazard_label: isClear ? "SAR_CLEARED" : "OPS_MANUAL_HAZARD",
          origin_node_id: "SAR_WAR_ROOM",
          clearance_role: "SAR_OPS",
        }),
      });
    });
  }

  function drawCsiWaveform(csi) {
    const canvas = $("csi-wave-canvas");
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(240, Math.floor(rect.width || 320));
    const h = Math.max(85, Math.floor(rect.height || 96));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = "rgba(148, 163, 184, 0.16)";
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    if (!csi || !csi.raw_waveform || !csi.filtered_waveform) {
      ctx.fillStyle = "rgba(148, 163, 184, 0.55)";
      ctx.font = "11px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillText("Awaiting Drone 2 Disarmed Perch-and-Listen Scan...", w / 2, h / 2 + 4);
      return;
    }

    const raw = csi.raw_waveform;
    const filt = csi.filtered_waveform;
    const plotSeries = (arr, color, lineW, centerVal) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = lineW;
      ctx.beginPath();
      const step = w / Math.max(1, arr.length - 1);
      arr.forEach((v, i) => {
        const y = h / 2 - (v - centerVal) * (h * 0.28);
        if (i === 0) ctx.moveTo(0, y);
        else ctx.lineTo(i * step, y);
      });
      ctx.stroke();
    };

    const rawMean = raw.reduce((a, b) => a + b, 0) / raw.length;
    plotSeries(raw, "rgba(148, 163, 184, 0.35)", 1.2, rawMean);
    plotSeries(filt, csi.respiration_detected ? "#34d399" : "#f43f5e", 2.2, 0.0);
  }

  function renderNodeCards() {
    const host = $("ops-node-cards");
    if (!host) return;
    host.innerHTML = "";
    Object.keys(NODE_STYLES).forEach((nid) => {
      const style = NODE_STYLES[nid];
      const n = state.liveNodes[nid] || { pos_row: 0, pos_col: 0, steps_taken: 0, arrived: false, connected: false, distance_m: 780 };
      const statusBadge = n.arrived
        ? `<span class="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[10px] font-bold">ARRIVED ✓</span>`
        : n.connected
        ? `<span class="px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-300 text-[10px] font-bold">LIVE</span>`
        : `<span class="px-1.5 py-0.5 rounded bg-slate-700/60 text-slate-400 text-[10px]">STANDBY</span>`;
      const card = document.createElement("div");
      card.className = "p-2 rounded-xl bg-slate-900/75 border border-slate-700/60 flex flex-col gap-1";
      card.innerHTML = `
        <div class="flex items-center justify-between">
          <span class="text-[11px] font-bold" style="color:${style.color}">${style.label}</span>
          ${statusBadge}
        </div>
        <div class="flex items-center justify-between text-[11px] text-slate-300 font-mono">
          <span>${n.distance_m}m left</span>
          <span>${n.steps_taken} steps</span>
          <span>${Math.round(n.heading_deg || 0)}°</span>
        </div>
      `;
      host.appendChild(card);
    });
  }

  function renderDrone2(d2) {
    if (!d2) return;
    setText("d2-status", d2.status || "IDLE_PERCH_READY");
    setText("d2-votes", d2.sensor_votes || "0/5");
    setText("d2-class", (d2.detected_device_class || "STANDBY").replace(/_/g, " "));

    const statusEl = $("d2-status");
    if (statusEl) {
      statusEl.className =
        d2.status === "SURVIVOR_LOCK_ACQUIRED"
          ? "text-xs font-black text-emerald-300"
          : d2.status === "REJECTED_PROP_WASH_GUARDRAIL"
          ? "text-xs font-black text-rose-400"
          : "text-xs font-bold text-slate-300";
    }

    const m = d2.sensor_matrix || {};
    const bindPill = (id, hit) => {
      const el = $(id);
      if (!el) return;
      el.dataset.active = hit ? "true" : "false";
    };
    bindPill("s-gsm", m.gsm_900mhz);
    bindPill("s-wifi", m.wifi_24ghz);
    bindPill("s-piezo", m.piezo_acoustic);
    bindPill("s-co2", m.co2_mq135);
    bindPill("s-csi", m.wifi_csi_respiration);

    if (d2.csi_dsp) {
      state.csiData = d2.csi_dsp;
      setText("csi-bpm", `${d2.csi_dsp.computed_bpm || 0} BPM`);
      setText("csi-snr", `SNR ${d2.csi_dsp.snr_db || 0} dB`);
      drawCsiWaveform(d2.csi_dsp);
    }
  }

  function renderStake(st) {
    if (!st) return;
    setText("stake-status", st.status || "NOMINAL_MONITORING");
    setText("stake-moisture", `${st.soil_moisture_pct || 0}%`);
    setText("stake-tilt", `${st.tilt_delta_deg || 0}°`);
    setText("stake-vib", `${st.vibration_g || 0} g`);
    const mBar = $("stake-moisture-bar");
    const tBar = $("stake-tilt-bar");
    if (mBar) mBar.style.width = `${Math.min(100, st.soil_moisture_pct || 0)}%`;
    if (tBar) tBar.style.width = `${Math.min(100, ((st.tilt_delta_deg || 0) / 12) * 100)}%`;
  }

  function renderVision(vt) {
    if (!vt) return;
    setText("v-device", vt.device || "MPS");
    setText("v-fps", `${vt.fps || 0} FPS`);
    setText("v-ms", `${vt.inference_ms || 0} ms`);
    setText("v-surv", `${vt.survivors_locked || 0}`);
    setText("v-link", vt.link_mode || "STANDBY");
  }

  function highlightActiveStage(n) {
    state.activeStage = n;
    document.querySelectorAll("[data-stage]").forEach((btn) => {
      btn.dataset.active = Number(btn.dataset.stage) === n ? "true" : "false";
    });
  }

  async function hydrateState() {
    try {
      const res = await fetch("/hazora/state");
      const data = await res.json();
      state.demGrid = data.dem_grid || [];
      state.hazards = data.active_hazards || [];
      state.safeZones = data.verified_safe_zones || [];
      state.routes = data.all_4_phone_routes || {};
      state.liveNodes = data.live_nodes || {};
      state.floodLevelCm = data.flood_water_level_cm || 0;
      state.tableNorthOffsetDeg = data.table_north_offset_deg || 0;

      const floodSlider = $("flood-slider");
      if (floodSlider) floodSlider.value = state.floodLevelCm;
      setText("flood-readout", `${state.floodLevelCm} cm`);

      const calSlider = $("table-cal-slider");
      if (calSlider) calSlider.value = state.tableNorthOffsetDeg;
      setText("table-cal-readout", `${Math.round(state.tableNorthOffsetDeg)}°`);

      highlightActiveStage(data.active_stage || 1);
      renderNodeCards();
      renderVision(data.vision_telemetry);
      renderStake(data.stake_telemetry);
      renderDrone2(data.drone2_result);
      drawRadialMap();
    } catch (_) {}
  }

  function connectWebSocket() {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}/ws/mission_control`);
    state.ws = ws;

    ws.onopen = () => {
      setText("ws-badge", "MESH WS LIVE");
      pushEventLog("SYSTEM", "Connected to HAZORA Master Kernel (Laptop = Safe Haven [4,4])", "safe");
    };

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      const d = msg.data || {};
      if (msg.type === "node_telemetry") {
        state.liveNodes[d.node_id] = d;
        renderNodeCards();
        drawRadialMap();
        if (d.arrived) {
          pushEventLog("ARRIVAL", `${d.node_id} reached Laptop Safe Haven [4,4]!`, "safe");
        }
      } else if (msg.type === "p2p_hazard_gossip") {
        state.hazards = d.active_hazards || state.hazards;
        state.safeZones = d.verified_safe_zones || state.safeZones;
        state.routes = d.all_4_phone_routes || state.routes;
        drawRadialMap();
        pushEventLog("MESH", d.event_summary || "Mesh route table updated", d.event_summary && d.event_summary.includes("CLEARED") ? "safe" : "warn");
      } else if (msg.type === "flood_level_update") {
        state.floodLevelCm = d.water_level_cm || 0;
        state.hazards = d.active_hazards || state.hazards;
        state.safeZones = d.verified_safe_zones || state.safeZones;
        state.routes = d.all_4_phone_routes || state.routes;
        const sl = $("flood-slider");
        if (sl) sl.value = state.floodLevelCm;
        setText("flood-readout", `${state.floodLevelCm} cm`);
        drawRadialMap();
        pushEventLog("FLOOD", d.event_summary || `Flood surge ${state.floodLevelCm}cm`, "warn");
      } else if (msg.type === "table_calibration") {
        state.tableNorthOffsetDeg = d.table_north_offset_deg || 0;
        const cs = $("table-cal-slider");
        if (cs) cs.value = state.tableNorthOffsetDeg;
        setText("table-cal-readout", `${Math.round(state.tableNorthOffsetDeg)}°`);
        drawRadialMap();
        pushEventLog("CALIBRATE", d.event_summary || "Table-North calibrated", "safe");
      } else if (msg.type === "demo_reset") {
        hydrateState();
        pushEventLog("RESET", msg.status || "Demo baseline restored", "safe");
      } else if (msg.type === "sos_mesh_burst") {
        const dec = d.decoded || {};
        pushEventLog(
          "36B SOS",
          `${dec.node_id || "NODE"} • ${dec.occupants || 2} ppl • ${dec.water_depth_cm || 40}cm • HEX ${String(d.hex_payload || "").slice(0, 16)}...`,
          "danger"
        );
      } else if (msg.type === "vision_telemetry") {
        renderVision(d);
      } else if (msg.type === "smart_stake_telemetry") {
        renderStake(d);
        pushEventLog("STAKE", `${d.status} (M:${d.soil_moisture_pct}% T:${d.tilt_delta_deg}°)`, d.and_gate_passed ? "danger" : "info");
      } else if (msg.type === "rubble_diver_lock") {
        renderDrone2(d);
        pushEventLog("DRONE 2", `${d.status} • Votes ${d.sensor_votes}`, d.status === "SURVIVOR_LOCK_ACQUIRED" ? "safe" : "danger");
      } else if (msg.type === "director_stage") {
        highlightActiveStage(d.stage_id || 1);
        pushEventLog(`STAGE ${d.stage_id}`, d.summary || "Stage executed", "info");
      }
    };

    ws.onclose = () => {
      setText("ws-badge", "RECONNECTING...");
      setTimeout(connectWebSocket, 2500);
    };
  }

  function wireControls() {
    const btnAdd = $("tool-add-hazard");
    const btnClr = $("tool-clear-hazard");
    const syncTools = () => {
      if (btnAdd) btnAdd.dataset.active = state.mapTool === "ADD_HAZARD" ? "true" : "false";
      if (btnClr) btnClr.dataset.active = state.mapTool === "CLEAR_HAZARD" ? "true" : "false";
    };
    if (btnAdd) btnAdd.addEventListener("click", () => { state.mapTool = "ADD_HAZARD"; syncTools(); });
    if (btnClr) btnClr.addEventListener("click", () => { state.mapTool = "CLEAR_HAZARD"; syncTools(); });
    syncTools();

    const floodSlider = $("flood-slider");
    if (floodSlider) {
      floodSlider.addEventListener("input", () => setText("flood-readout", `${floodSlider.value} cm`));
      floodSlider.addEventListener("change", () => {
        fetch("/hazora/core/mesh/flood_level", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ water_level_cm: Number(floodSlider.value) }),
        });
      });
    }

    const calSlider = $("table-cal-slider");
    if (calSlider) {
      calSlider.addEventListener("input", () => setText("table-cal-readout", `${calSlider.value}°`));
      calSlider.addEventListener("change", () => {
        fetch("/hazora/core/calibrate_table", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ table_north_offset_deg: Number(calSlider.value), source_node_id: "OPS_SLIDER" }),
        });
      });
    }

    const snapBtn = $("btn-snap-table-north");
    if (snapBtn) {
      snapBtn.addEventListener("click", () => {
        const south = state.liveNodes["ANDROID_01_SEDAN"];
        const activeAny = Object.values(state.liveNodes).find((n) => n.connected);
        const ref = (south && south.connected) ? south : activeAny;
        const deg = ref ? (ref.raw_heading_deg || 0) : 0;
        fetch("/hazora/core/calibrate_table", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ table_north_offset_deg: deg, source_node_id: ref ? ref.node_id : "OPS_DEFAULT" }),
        });
      });
    }

    document.querySelectorAll("[data-stage]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const st = btn.dataset.stage;
        const mode = btn.dataset.mode || "csi";
        fetch(`/hazora/sim/stage/${st}?mode=${mode}`, { method: "POST" });
      });
    });

    const btnReset = $("btn-reset-baseline");
    if (btnReset) {
      btnReset.addEventListener("click", () => {
        fetch("/hazora/core/mesh/reset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clear_all_red_zones: false }),
        });
      });
    }

    const btnClearAll = $("btn-clear-all");
    if (btnClearAll) {
      btnClearAll.addEventListener("click", () => {
        fetch("/hazora/core/mesh/reset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clear_all_red_zones: true }),
        });
      });
    }

    const btnPropTest = $("btn-test-propwash");
    if (btnPropTest) {
      btnPropTest.addEventListener("click", () => {
        fetch("/hazora/air/rubble_diver_scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            waypoint_id: "WP-DRONE1-01",
            is_motor_disarmed: false,
            rotor_rpm: 4200,
            csi_breathing_bpm: 16.2,
            mq135_co2_ppm: 780.0,
          }),
        });
      });
    }
  }

  function boot() {
    wireMapClickControls();
    wireControls();
    hydrateState();
    connectWebSocket();
    window.addEventListener("resize", () => {
      drawRadialMap();
      drawCsiWaveform(state.csiData);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
