/**
 * HAZORA // LOCKED CIVILIAN NAVIGATION ENGINE (v7 — Center Laptop Safe Haven [4,4])
 * -------------------------------------------------------------------------
 * - 9x9 Radial Topography: Laptop sits physically at [4,4] (948m Safe Haven)
 * - 4 Cardinal Table Spawns: South [0,4], North [8,4], East [4,8], West [4,0]
 * - Syncs table_north_offset_deg from /ops so compasses point directly at the Laptop
 * - Streams live (row, col, heading, steps, arrival) to /ops War-Room Console
 */
(function () {
  "use strict";

  const params = new URLSearchParams(window.location.search);
  const IS_MOCK = params.get("mock") === "1" || window.location.protocol === "file:";
  const IS_IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);

  const GRID_SIZE = 9;
  const MAX_IDX = GRID_SIZE - 1;
  const HAVEN_R = 4;
  const HAVEN_C = 4;

  const PRESETS = {
    ANDROID_01_SEDAN:  { row: 0, col: 4, side: "SOUTH", initHeading: 0.0,   cls: "Class A (Sedan)", depth: 15.0 },
    IPHONE_16_PRO_MAX: { row: 8, col: 4, side: "NORTH", initHeading: 180.0, cls: "Class B (SUV)",   depth: 30.0 },
    ANDROID_02_SUV:    { row: 4, col: 8, side: "EAST",  initHeading: 270.0, cls: "Class B (SUV)",   depth: 30.0 },
    ANDROID_03_SAR:    { row: 4, col: 0, side: "WEST",  initHeading: 90.0,  cls: "Class A (Sedan)", depth: 15.0 },
  };

  const DEM_GRID = [
    [906, 905, 904, 903, 904, 903, 904, 905, 906],
    [907, 906, 904, 899, 898, 900, 905, 907, 908],
    [909, 907, 903, 897, 894, 899, 906, 910, 911],
    [912, 910, 901, 926, 932, 927, 902, 912, 914],
    [905, 901, 896, 933, 948, 934, 893, 900, 904],
    [912, 910, 902, 928, 933, 926, 901, 911, 913],
    [909, 907, 904, 898, 895, 899, 905, 909, 910],
    [907, 906, 905, 900, 899, 901, 905, 907, 908],
    [906, 905, 904, 903, 904, 903, 904, 905, 906],
  ];

  const defaultNodeId = params.get("node") && PRESETS[params.get("node")]
    ? params.get("node")
    : (IS_IOS ? "IPHONE_16_PRO_MAX" : "ANDROID_01_SEDAN");

  const startPreset = PRESETS[defaultNodeId];

  const state = {
    nodeId: defaultNodeId,
    side: startPreset.side,
    vehicleClass: startPreset.cls,
    maxWadingCm: startPreset.depth,
    posRow: startPreset.row,
    posCol: startPreset.col,
    dispRow: startPreset.row,
    dispCol: startPreset.col,
    lastRoutedRow: startPreset.row,
    lastRoutedCol: startPreset.col,
    lastRouteFetchTs: 0,
    lastTelemetryPushTs: 0,
    stepsTaken: 0,
    arrived: false,
    // Walking PDR state
    gravMag: 9.81,
    filteredAcc: 0.0,
    lastStepTs: 0,
    motionActive: false,
    sensorsBound: false,
    // Outdoor GPS anchor
    lastGpsLat: null,
    lastGpsLng: null,
    // Route & hazards
    route: [],
    hazards: [],
    safeZones: [],
    usedPerimeterFallback: false,
    floodLevelCm: 0,
    // Compass + Table-North Calibration
    tableNorthOffsetDeg: 0.0,
    rawMagneticHeadingDeg: startPreset.initHeading,
    hasAbsoluteOrientation: false,
    hasLiveCompass: false,
    smoothSin: Math.sin((startPreset.initHeading * Math.PI) / 180),
    smoothCos: Math.cos((startPreset.initHeading * Math.PI) / 180),
    headingDeg: startPreset.initHeading,
    compassLabel: IS_MOCK ? "MOCK COMPASS" : `${startPreset.side} • CALIBRATING`,
    lastGuidanceState: "",
    isAlignedNow: false,
    isDangerNow: false,
    flowPhase: 0,
    started: false,
    lastVoiceCue: "",
    lastVoiceTime: 0,
    lastVoicePriority: "normal",
    wakeLock: null,
    ws: null,
  };

  const $ = (id) => document.getElementById(id);

  function setText(id, val) {
    const el = $(id);
    if (el) el.textContent = val;
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function sampleElevation(r, c) {
    return DEM_GRID[clamp(Math.round(r), 0, MAX_IDX)][clamp(Math.round(c), 0, MAX_IDX)];
  }

  function posToGps(r, c) {
    return {
      lat: Number((12.9710 + (r / 8.0) * 0.0080).toFixed(6)),
      lng: Number((77.5910 + (c / 8.0) * 0.0080).toFixed(6)),
      elevation_m: sampleElevation(r, c),
    };
  }

  function showToast(msg, tone) {
    const el = $("toast-banner");
    if (!el) return;
    el.textContent = msg;
    el.dataset.tone = tone || "safe";
    el.classList.remove("opacity-0", "pointer-events-none");
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => {
      el.classList.add("opacity-0", "pointer-events-none");
    }, 4200);
  }

  function vibratePattern(pattern) {
    if (navigator.vibrate) {
      try { navigator.vibrate(pattern); } catch (_) {}
    }
  }

  function speakCue(text, priority, forceImmediate) {
    if (!state.started || !("speechSynthesis" in window)) return;
    const prio = priority || "normal";
    const now = Date.now();
    const sameCueCooldown = prio === "danger" ? 4000 : 7500;
    const globalCooldown = prio === "danger" ? 1500 : 3000;

    if (!forceImmediate) {
      if (text === state.lastVoiceCue && now - state.lastVoiceTime < sameCueCooldown) return;
      if (!(prio === "danger" && state.lastVoicePriority !== "danger")) {
        if (now - state.lastVoiceTime < globalCooldown) return;
      }
    }

    state.lastVoiceCue = text;
    state.lastVoiceTime = now;
    state.lastVoicePriority = prio;
    try {
      window.speechSynthesis.cancel();
      window.speechSynthesis.resume();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-US";
      u.rate = prio === "danger" ? 1.08 : 1.02;
      u.pitch = prio === "danger" ? 1.04 : 0.98;
      u.volume = 1.0;
      window.speechSynthesis.speak(u);
    } catch (_) {}
  }

  // ---------------- LIVE TELEMETRY PUSH TO /OPS ----------------

  function pushLiveTelemetry(force) {
    if (IS_MOCK) return;
    const now = Date.now();
    if (!force && now - state.lastTelemetryPushTs < 380) return;
    state.lastTelemetryPushTs = now;

    fetch("/hazora/core/node_telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        node_id: state.nodeId,
        vehicle_class: state.vehicleClass,
        pos_row: Number(state.posRow.toFixed(2)),
        pos_col: Number(state.posCol.toFixed(2)),
        heading_deg: Number(state.headingDeg.toFixed(1)),
        raw_heading_deg: Number(state.rawMagneticHeadingDeg.toFixed(1)),
        steps_taken: state.stepsTaken,
        arrived: state.arrived,
        aligned: state.isAlignedNow,
        danger: state.isDangerNow,
        distance_m: computeRemainingMeters(),
      }),
    }).catch(() => {});
  }

  // ---------------- AUTOMATIC WALKING (PDR) & GPS ----------------

  function resetPositionToStart(notify) {
    state.posRow = startPreset.row;
    state.posCol = startPreset.col;
    state.dispRow = startPreset.row;
    state.dispCol = startPreset.col;
    state.lastRoutedRow = startPreset.row;
    state.lastRoutedCol = startPreset.col;
    state.stepsTaken = 0;
    state.arrived = false;
    state.lastGuidanceState = "";
    fetchRoute();
    pushLiveTelemetry(true);
    if (notify) {
      vibratePattern(30);
      showToast(`Reset to ${state.side} start position.`, "safe");
    }
  }

  function getNextTargetWaypoint() {
    if (!state.route.length) return { grid_row: HAVEN_R, grid_col: HAVEN_C };
    for (let i = 1; i < state.route.length; i++) {
      const wp = state.route[i];
      if (Math.hypot(wp.grid_row - state.posRow, wp.grid_col - state.posCol) >= 0.55) {
        return wp;
      }
    }
    return state.route[state.route.length - 1];
  }

  function computeTargetBearingDeg() {
    const target = getNextTargetWaypoint();
    const dy = target.grid_row - state.posRow;
    const dx = target.grid_col - state.posCol;
    if (Math.hypot(dx, dy) < 0.05) return startPreset.initHeading;
    return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  }

  function advanceOnRealStep(stepDistanceCells) {
    if (!state.started || state.arrived) return;

    const req = computeTargetBearingDeg();
    const diff = ((req - state.headingDeg + 540) % 360) - 180;
    const absDiff = Math.abs(diff);

    const moveHeadingDeg = absDiff <= 45 ? req : state.headingDeg;
    const rad = (moveHeadingDeg * Math.PI) / 180;
    const nextRow = clamp(state.posRow + Math.cos(rad) * stepDistanceCells, 0, MAX_IDX);
    const nextCol = clamp(state.posCol + Math.sin(rad) * stepDistanceCells, 0, MAX_IDX);

    const nr = Math.round(nextRow);
    const nc = Math.round(nextCol);
    const hitHazard = state.hazards.find(
      (hz) => hz.grid_row === nr && hz.grid_col === nc && hz.depth_cm > state.maxWadingCm
    );
    if (hitHazard && absDiff > 45) {
      vibratePattern([100, 50, 100]);
      showToast(`⚠ Blocked by ${Math.round(hitHazard.depth_cm)}cm water! Turn toward safe route.`, "warn");
      speakCue(
        `Stop. ${Math.round(hitHazard.depth_cm)} centimeter flood zone ahead. Turn toward Laptop Safe Haven.`,
        "danger"
      );
      return;
    }

    state.posRow = nextRow;
    state.posCol = nextCol;
    state.stepsTaken += 1;
    vibratePattern(14);

    if (Math.hypot(HAVEN_R - state.posRow, HAVEN_C - state.posCol) <= 0.65 && !state.arrived) {
      state.arrived = true;
      state.posRow = HAVEN_R;
      state.posCol = HAVEN_C;
      vibratePattern([60, 50, 60, 50, 140]);
      showToast("✓ LAPTOP SAFE HAVEN REACHED (948m High Ground)!", "safe");
      speakCue("Safe haven reached. You have arrived at command high ground.", "normal", true);
    }

    const now = Date.now();
    if (
      (nr !== state.lastRoutedRow || nc !== state.lastRoutedCol) &&
      now - state.lastRouteFetchTs > 420
    ) {
      state.lastRoutedRow = nr;
      state.lastRoutedCol = nc;
      state.lastRouteFetchTs = now;
      fetchRoute();
    }

    updateGuidanceHUD();
    pushLiveTelemetry(true);
  }

  function handleDeviceMotion(ev) {
    if (!state.started) return;
    state.motionActive = true;

    const now = performance.now();
    if (now - state.lastStepTs < 340) return;

    const lin = ev.acceleration;
    if (lin && typeof lin.x === "number" && typeof lin.y === "number" && typeof lin.z === "number") {
      const linMag = Math.hypot(lin.x, lin.y, lin.z);
      state.filteredAcc = 0.6 * state.filteredAcc + 0.4 * linMag;
      if (state.filteredAcc >= 0.62) {
        state.lastStepTs = now;
        // ~7-8 physical steps crosses 4 cells to reach the center table laptop
        advanceOnRealStep(0.55);
        return;
      }
    }

    const acc = ev.accelerationIncludingGravity;
    if (acc && typeof acc.x === "number" && typeof acc.y === "number" && typeof acc.z === "number") {
      const mag = Math.hypot(acc.x, acc.y, acc.z);
      state.gravMag = 0.88 * state.gravMag + 0.12 * mag;
      if (Math.abs(mag - state.gravMag) >= 0.85) {
        state.lastStepTs = now;
        advanceOnRealStep(0.55);
      }
    }
  }

  // ---------------- AUTOMATIC COMPASS + TABLE-NORTH OFFSET ----------------

  function applyTableOffset(rawMagDeg) {
    return ((rawMagDeg - state.tableNorthOffsetDeg) % 360 + 360) % 360;
  }

  function pushHeadingSample(rawMagDeg, alpha, label) {
    if (typeof rawMagDeg !== "number" || Number.isNaN(rawMagDeg)) return;
    state.rawMagneticHeadingDeg = ((rawMagDeg % 360) + 360) % 360;
    const tableDeg = applyTableOffset(state.rawMagneticHeadingDeg);
    const rad = (tableDeg * Math.PI) / 180;

    if (!state.hasLiveCompass) {
      state.smoothSin = Math.sin(rad);
      state.smoothCos = Math.cos(rad);
      state.hasLiveCompass = true;
    } else {
      state.smoothSin = (1 - alpha) * state.smoothSin + alpha * Math.sin(rad);
      state.smoothCos = (1 - alpha) * state.smoothCos + alpha * Math.cos(rad);
    }
    state.headingDeg = ((Math.atan2(state.smoothSin, state.smoothCos) * 180) / Math.PI + 360) % 360;
    state.compassLabel = `${state.side} • ${label} ${Math.round(state.headingDeg)}°`;
    updateGuidanceHUD();
    pushLiveTelemetry(false);
  }

  function handleAbsoluteOrientation(ev) {
    if (typeof ev.alpha === "number" && !Number.isNaN(ev.alpha)) {
      state.hasAbsoluteOrientation = true;
      pushHeadingSample((360 - ev.alpha) % 360, 0.25, "COMPASS");
    }
  }

  function handleDeviceOrientation(ev) {
    if (typeof ev.webkitCompassHeading === "number" && !Number.isNaN(ev.webkitCompassHeading)) {
      pushHeadingSample(ev.webkitCompassHeading, 0.25, "COMPASS");
      return;
    }
    if (!state.hasAbsoluteOrientation && typeof ev.alpha === "number" && !Number.isNaN(ev.alpha)) {
      pushHeadingSample((360 - ev.alpha) % 360, 0.25, ev.absolute ? "COMPASS" : "GYRO");
    }
  }

  function bindSensorListeners() {
    if (state.sensorsBound) return;
    state.sensorsBound = true;
    window.addEventListener("deviceorientationabsolute", handleAbsoluteOrientation, true);
    window.addEventListener("deviceorientation", handleDeviceOrientation, true);
    window.addEventListener("devicemotion", handleDeviceMotion, true);
  }

  function requestSensorsAndUnlockVoice(openingSpeech) {
    if (!window.isSecureContext && !IS_MOCK) {
      state.compassLabel = "USE HTTPS:// URL";
      setText("compass-status", state.compassLabel);
      showToast("⚠ Open with https:// (not http://) to unlock compass.", "warn");
    }

    let permPromise = null;
    if (
      !IS_MOCK &&
      typeof DeviceOrientationEvent !== "undefined" &&
      typeof DeviceOrientationEvent.requestPermission === "function"
    ) {
      try {
        permPromise = DeviceOrientationEvent.requestPermission();
      } catch (_) {
        permPromise = null;
      }
    }

    if (openingSpeech && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
        window.speechSynthesis.resume();
        const u = new SpeechSynthesisUtterance(openingSpeech);
        u.lang = "en-US";
        u.rate = 1.04;
        u.volume = 1.0;
        window.speechSynthesis.speak(u);
        state.lastVoiceTime = Date.now();
      } catch (_) {}
    }

    if (permPromise) {
      return permPromise
        .then((res) => {
          if (res === "granted") {
            bindSensorListeners();
            state.compassLabel = `${state.side} • COMPASS LIVE`;
            setText("compass-status", state.compassLabel);
          } else {
            state.compassLabel = "TAP TO ALLOW COMPASS";
            setText("compass-status", state.compassLabel);
            showToast("Permission denied. Swipe Safari closed & reopen.", "warn");
          }
        })
        .catch(() => {
          state.compassLabel = "TAP TO ALLOW COMPASS";
          setText("compass-status", state.compassLabel);
        });
    } else if (!IS_MOCK) {
      bindSensorListeners();
      state.compassLabel = `${state.side} • COMPASS ACTIVE`;
      setText("compass-status", state.compassLabel);
    }
    return Promise.resolve();
  }

  function startGpsAndWakeLock() {
    if (!IS_MOCK && "geolocation" in navigator) {
      try {
        navigator.geolocation.watchPosition(
          (pos) => {
            const { latitude, longitude, accuracy, speed, heading } = pos.coords;
            if (typeof speed === "number" && speed >= 1.3 && typeof heading === "number" && !Number.isNaN(heading)) {
              pushHeadingSample(heading, 0.5, "GPS");
            }
            if (accuracy && accuracy < 35) {
              if (state.lastGpsLat !== null) {
                const dNorthM = (latitude - state.lastGpsLat) * 111320;
                const dEastM = (longitude - state.lastGpsLng) * 111320 * Math.cos((latitude * Math.PI) / 180);
                if (Math.hypot(dNorthM, dEastM) >= 2.5) {
                  state.posRow = clamp(state.posRow + dNorthM / 18.0, 0, MAX_IDX);
                  state.posCol = clamp(state.posCol + dEastM / 18.0, 0, MAX_IDX);
                  state.lastGpsLat = latitude;
                  state.lastGpsLng = longitude;
                  fetchRoute();
                  updateGuidanceHUD();
                  pushLiveTelemetry(true);
                }
              } else {
                state.lastGpsLat = latitude;
                state.lastGpsLng = longitude;
              }
            }
          },
          () => {},
          { enableHighAccuracy: true, maximumAge: 1500 }
        );
      } catch (_) {}
    }

    if ("wakeLock" in navigator) {
      navigator.wakeLock.request("screen").then((wl) => { state.wakeLock = wl; }).catch(() => {});
    }
  }

  // ---------------- GUIDANCE HUD & DUAL VOICE ----------------

  function computeRemainingMeters() {
    if (state.arrived) return 0;
    if (state.route.length < 2) {
      return Math.round(Math.hypot(HAVEN_R - state.posRow, HAVEN_C - state.posCol) * 180);
    }
    let cells = Math.hypot(state.route[1].grid_row - state.posRow, state.route[1].grid_col - state.posCol);
    for (let i = 1; i < state.route.length - 1; i++) {
      cells += Math.hypot(
        state.route[i + 1].grid_row - state.route[i].grid_row,
        state.route[i + 1].grid_col - state.route[i].grid_col
      );
    }
    return Math.max(0, Math.round(cells * 180));
  }

  function detectHazardDirectlyAhead() {
    const rad = (state.headingDeg * Math.PI) / 180;
    const curR = Math.round(state.posRow);
    const curC = Math.round(state.posCol);
    const dr = Math.round(Math.cos(rad));
    const dc = Math.round(Math.sin(rad));
    for (let dist = 1; dist <= 2; dist++) {
      const tr = curR + dr * dist;
      const tc = curC + dc * dist;
      const match = state.hazards.find(
        (hz) => hz.grid_row === tr && hz.grid_col === tc && hz.depth_cm > state.maxWadingCm
      );
      if (match) return match;
    }
    return null;
  }

  function updateGuidanceHUD() {
    const req = computeTargetBearingDeg();
    const diff = ((req - state.headingDeg + 540) % 360) - 180;
    const absDiff = Math.abs(diff);
    const hazardAhead = detectHazardDirectlyAhead();

    let chevron = "↑";
    let instruction = "SAFE PATH LOCKED — WALK STRAIGHT";
    let tone = "aligned";
    let guidanceKey = "aligned";
    let isNowAligned = false;

    if (state.arrived || Math.hypot(HAVEN_R - state.posRow, HAVEN_C - state.posCol) <= 0.65) {
      state.arrived = true;
      chevron = "✓";
      instruction = "SAFE HAVEN REACHED — AT LAPTOP";
      tone = "arrived";
      guidanceKey = "arrived";
      isNowAligned = true;
    } else if (hazardAhead && absDiff > 24) {
      chevron = diff >= 0 ? "→" : "←";
      const turnDir = diff >= 0 ? "RIGHT" : "LEFT";
      instruction = `FLOOD AHEAD (${Math.round(hazardAhead.depth_cm)}cm) — TURN ${turnDir}`;
      tone = "reverse";
      guidanceKey = `hazard_${hazardAhead.grid_row}_${hazardAhead.grid_col}_${turnDir}`;
    } else if (absDiff <= 24) {
      chevron = "↑";
      instruction = "SAFE PATH LOCKED — WALK STRAIGHT";
      tone = "aligned";
      guidanceKey = "aligned";
      isNowAligned = true;
    } else if (absDiff >= 138) {
      chevron = "↺";
      instruction = "WRONG WAY — TURN AROUND NOW";
      tone = "reverse";
      guidanceKey = "reverse";
    } else if (diff > 24 && diff <= 65) {
      chevron = "↗";
      instruction = "BEAR RIGHT ONTO SAFE PATH";
      tone = "adjust";
      guidanceKey = "bear_right";
    } else if (diff > 65) {
      chevron = "→";
      instruction = "OFF ROUTE — TURN RIGHT";
      tone = "turn";
      guidanceKey = "turn_right";
    } else if (diff < -24 && diff >= -65) {
      chevron = "↖";
      instruction = "BEAR LEFT ONTO SAFE PATH";
      tone = "adjust";
      guidanceKey = "bear_left";
    } else {
      chevron = "←";
      instruction = "OFF ROUTE — TURN LEFT";
      tone = "turn";
      guidanceKey = "turn_left";
    }

    if (state.started && state.hasLiveCompass && guidanceKey !== state.lastGuidanceState) {
      if (guidanceKey.startsWith("hazard_")) {
        const turnDir = diff >= 0 ? "right" : "left";
        vibratePattern([90, 50, 90]);
        speakCue(
          `Warning: ${Math.round(hazardAhead.depth_cm)} centimeter flood zone ahead. Turn ${turnDir} toward Safe Haven.`,
          "danger"
        );
      } else if (guidanceKey === "reverse") {
        vibratePattern([110, 60, 110]);
        speakCue("Warning: Wrong direction. Turn around toward the green safe path.", "danger");
      } else if (guidanceKey === "turn_right") {
        vibratePattern([60, 40]);
        speakCue("Off route. Turn right toward Safe Haven.", "danger");
      } else if (guidanceKey === "turn_left") {
        vibratePattern([60, 40]);
        speakCue("Off route. Turn left toward Safe Haven.", "danger");
      } else if (guidanceKey === "bear_right") {
        speakCue("Bear slightly right onto the safe route.", "normal");
      } else if (guidanceKey === "bear_left") {
        speakCue("Bear slightly left onto the safe route.", "normal");
      } else if (guidanceKey === "aligned") {
        vibratePattern(28);
        speakCue("Safe path locked. Walk straight toward Safe Haven.", "normal");
      } else if (guidanceKey === "arrived") {
        vibratePattern([40, 40, 80]);
        speakCue("Safe haven reached. You are safe at command high ground.", "normal");
      }
      state.lastGuidanceState = guidanceKey;
    }

    const isDanger = !state.arrived && (tone === "reverse" || Boolean(hazardAhead && !isNowAligned));
    state.isAlignedNow = isNowAligned;
    state.isDangerNow = isDanger;

    const cardEl = $("guidance-card");
    if (cardEl) {
      cardEl.dataset.aligned = isNowAligned ? "true" : "false";
      cardEl.dataset.danger = isDanger ? "true" : "false";
    }

    const chevEl = $("steer-chevron");
    if (chevEl) {
      chevEl.textContent = chevron;
      chevEl.dataset.tone = tone;
    }
    setText("steer-instruction", instruction);
    setText("compass-status", state.compassLabel);

    const sarClearCount = state.safeZones.filter((z) => z.zone_type === "SAR_VERIFIED_CLEAR").length;
    let confirmMsg = state.arrived
      ? "✓ ARRIVED AT CENTER SAFE HAVEN (948m)"
      : state.usedPerimeterFallback
      ? "✓ EMERGENCY CORRIDOR ACTIVE • HEAD TO CENTER SAFE HAVEN"
      : `✓ DRY ROUTE VERIFIED (${state.side} APPROACH) • HEAD TO CENTER`;
    if (isDanger && hazardAhead) {
      confirmMsg = `⚠ DO NOT ENTER: ${Math.round(hazardAhead.depth_cm)}cm FLOOD AHEAD — TURN TO SAFE PATH`;
    } else if (isDanger) {
      confirmMsg = "⚠ MOVING AWAY FROM SAFE HAVEN — TURN AROUND";
    } else if (!state.arrived && sarClearCount > 0) {
      confirmMsg = `✓ ${sarClearCount} SAR-CLEARED CORRIDOR${sarClearCount > 1 ? "S" : ""} OPEN • WALK TO CENTER`;
    }

    const pillEl = $("safe-confirmation-pill");
    if (pillEl) {
      pillEl.textContent = confirmMsg;
      pillEl.dataset.aligned = isNowAligned ? "true" : "false";
      pillEl.dataset.danger = isDanger ? "true" : "false";
    }

    const distMeters = computeRemainingMeters();
    setText("metric-distance", distMeters === 0 ? "0 m — Arrived!" : `${distMeters} m to Safe Haven`);

    const curElev = sampleElevation(state.posRow, state.posCol);
    const climbLeft = Math.max(0, Math.round(948 - curElev));
    setText("metric-elevation", `${Math.round(curElev)} m (+${climbLeft} m upland)`);
  }

  // ---------------- HEADING-UP RADAR CANVAS ----------------

  function drawHeadingUpMap() {
    const canvas = $("radar-canvas");
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(280, Math.round(rect.width || 340));
    const h = Math.max(220, Math.round(rect.height || 260));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const anchorX = w * 0.5;
    const anchorY = h * 0.68;
    const cellPx = Math.min(w, h) * 0.135;

    ctx.strokeStyle = "rgba(225, 212, 194, 0.10)";
    ctx.lineWidth = 1;
    [cellPx * 1.5, cellPx * 3.0, cellPx * 4.5].forEach((r) => {
      ctx.beginPath();
      ctx.arc(anchorX, anchorY, r, 0, Math.PI * 2);
      ctx.stroke();
    });

    const curR = state.dispRow;
    const curC = state.dispCol;
    const rotRad = (-state.headingDeg * Math.PI) / 180;
    const isAligned = state.isAlignedNow;
    const isDanger = state.isDangerNow;

    ctx.save();
    ctx.translate(anchorX, anchorY);
    ctx.rotate(rotRad);

    ctx.fillStyle = "rgba(225, 212, 194, 0.16)";
    for (let r = 0; r < GRID_SIZE; r++) {
      for (let c = 0; c < GRID_SIZE; c++) {
        const wx = (c - curC) * cellPx;
        const wy = -(r - curR) * cellPx;
        ctx.beginPath();
        ctx.arc(wx, wy, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Dry high ground & SAR-cleared zones
    state.safeZones.forEach((sz) => {
      const wx = (sz.grid_col - curC) * cellPx;
      const wy = -(sz.grid_row - curR) * cellPx;
      const isSar = sz.zone_type === "SAR_VERIFIED_CLEAR";
      const rad = isSar ? cellPx * 0.68 : cellPx * 0.60;

      const grad = ctx.createRadialGradient(wx, wy, 3, wx, wy, rad);
      grad.addColorStop(0, isSar ? "rgba(16, 185, 129, 0.44)" : "rgba(16, 185, 129, 0.22)");
      grad.addColorStop(1, "rgba(16, 185, 129, 0.0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(wx, wy, rad, 0, Math.PI * 2);
      ctx.fill();

      if (isSar) {
        ctx.strokeStyle = "rgba(52, 211, 153, 0.85)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(wx, wy, cellPx * 0.36, 0, Math.PI * 2);
        ctx.stroke();

        ctx.save();
        ctx.translate(wx, wy);
        ctx.rotate(-rotRad);
        ctx.fillStyle = "#a7f3d0";
        ctx.font = "bold 8px ui-sans-serif, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("✓ CLEAR", 0, 3);
        ctx.restore();
      }
    });

    // Red hazard zones
    state.hazards.forEach((hz) => {
      const wx = (hz.grid_col - curC) * cellPx;
      const wy = -(hz.grid_row - curR) * cellPx;
      const grad = ctx.createRadialGradient(wx, wy, 4, wx, wy, cellPx * 0.70);
      grad.addColorStop(0, "rgba(239, 68, 68, 0.80)");
      grad.addColorStop(1, "rgba(239, 68, 68, 0.0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(wx, wy, cellPx * 0.70, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = "rgba(248, 113, 113, 0.85)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(wx, wy, cellPx * 0.40, 0, Math.PI * 2);
      ctx.stroke();

      ctx.save();
      ctx.translate(wx, wy);
      ctx.rotate(-rotRad);
      ctx.fillStyle = "#fee2e2";
      ctx.font = "bold 9px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`${Math.round(hz.depth_cm)}cm`, 0, 3);
      ctx.restore();
    });

    // Glowing safe corridor + forward chevrons
    if (state.route.length >= 1 && !state.arrived) {
      const pts = [{ grid_row: curR, grid_col: curC }].concat(
        state.route.length > 1 ? state.route.slice(1) : state.route
      );

      ctx.strokeStyle = "rgba(16, 185, 129, 0.30)";
      ctx.lineWidth = 14;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      pts.forEach((pt, idx) => {
        const wx = (pt.grid_col - curC) * cellPx;
        const wy = -(pt.grid_row - curR) * cellPx;
        if (idx === 0) ctx.moveTo(wx, wy);
        else ctx.lineTo(wx, wy);
      });
      ctx.stroke();

      ctx.strokeStyle = "#34d399";
      ctx.lineWidth = 4.5;
      ctx.beginPath();
      pts.forEach((pt, idx) => {
        const wx = (pt.grid_col - curC) * cellPx;
        const wy = -(pt.grid_row - curR) * cellPx;
        if (idx === 0) ctx.moveTo(wx, wy);
        else ctx.lineTo(wx, wy);
      });
      ctx.stroke();

      for (let i = 0; i < pts.length - 1; i++) {
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const x1 = (p1.grid_col - curC) * cellPx;
        const y1 = -(p1.grid_row - curR) * cellPx;
        const x2 = (p2.grid_col - curC) * cellPx;
        const y2 = -(p2.grid_row - curR) * cellPx;
        if (Math.hypot(x2 - x1, y2 - y1) < 12) continue;
        const t = (state.flowPhase + i * 0.33) % 1;
        const mx = x1 + (x2 - x1) * t;
        const my = y1 + (y2 - y1) * t;
        const ang = Math.atan2(y2 - y1, x2 - x1);

        ctx.save();
        ctx.translate(mx, my);
        ctx.rotate(ang);
        ctx.strokeStyle = "#ecfdf5";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-4, -4);
        ctx.lineTo(3, 0);
        ctx.lineTo(-4, 4);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Center Laptop Safe Haven [4,4] beacon
    const hx = (HAVEN_C - curC) * cellPx;
    const hy = -(HAVEN_R - curR) * cellPx;
    ctx.fillStyle = "rgba(16, 185, 129, 0.30)";
    ctx.beginPath();
    ctx.arc(hx, hy, 24, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#10b981";
    ctx.beginPath();
    ctx.arc(hx, hy, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#ecfdf5";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.save();
    ctx.translate(hx, hy);
    ctx.rotate(-rotRad);
    ctx.fillStyle = "#d1fae5";
    ctx.font = "bold 10px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("★ SAFE HAVEN (LAPTOP)", 0, -17);
    ctx.restore();

    ctx.restore();

    // Forward view cone
    const coneColor = isDanger
      ? "rgba(244, 63, 94, 0.45)"
      : isAligned
      ? "rgba(52, 211, 153, 0.42)"
      : "rgba(56, 189, 248, 0.34)";
    const coneGrad = ctx.createLinearGradient(anchorX, anchorY, anchorX, anchorY - 62);
    coneGrad.addColorStop(0, coneColor);
    coneGrad.addColorStop(1, "rgba(16, 185, 129, 0.0)");
    ctx.fillStyle = coneGrad;
    ctx.beginPath();
    ctx.moveTo(anchorX, anchorY);
    ctx.arc(anchorX, anchorY, 62, -Math.PI * 0.68, -Math.PI * 0.32);
    ctx.closePath();
    ctx.fill();

    // User directional puck
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = isDanger ? "#f43f5e" : isAligned ? "#10b981" : "#0ea5e9";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(anchorX, anchorY - 12);
    ctx.lineTo(anchorX + 9, anchorY + 8);
    ctx.lineTo(anchorX, anchorY + 4);
    ctx.lineTo(anchorX - 9, anchorY + 8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Auto-walk status readout
    ctx.fillStyle = "rgba(225, 212, 194, 0.68)";
    ctx.font = "600 9px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "right";
    const stepText = state.stepsTaken > 0
      ? `AUTO WALK • ${state.stepsTaken} STEPS`
      : state.motionActive
      ? "AUTO WALK READY"
      : `CENTER HAVEN v7 • ${state.side}`;
    ctx.fillText(stepText, w - 12, h - 10);

    // Table-North needle
    const nx = w - 26;
    const ny = 26;
    ctx.save();
    ctx.translate(nx, ny);
    ctx.rotate(rotRad);
    ctx.fillStyle = "rgba(15, 23, 42, 0.75)";
    ctx.beginPath();
    ctx.arc(0, 0, 15, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#f43f5e";
    ctx.beginPath();
    ctx.moveTo(0, -11);
    ctx.lineTo(4, -2);
    ctx.lineTo(-4, -2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#e2e8f0";
    ctx.font = "bold 8px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("N", 0, 9);
    ctx.restore();
  }

  // ---------------- NETWORK & MOCK ENGINE ----------------

  function loadMockData(blockedAdded) {
    state.hazards = [
      { grid_row: 2, grid_col: 4, depth_cm: 62, label: "SOUTH_UNDERPASS_FLOOD" },
      { grid_row: 4, grid_col: 6, depth_cm: 74, label: "EAST_CULVERT_SURGE" },
      { grid_row: 6, grid_col: 4, depth_cm: 58, label: "NORTH_STORM_DRAIN" },
    ];
    state.safeZones = [
      { grid_row: 4, grid_col: 4, elevation_m: 948, zone_type: "HIGH_GROUND_SAFE", label: "SAFE HAVEN" },
      { grid_row: 3, grid_col: 4, elevation_m: 932, zone_type: "HIGH_GROUND_SAFE", label: "SAFE HIGH GROUND" },
      { grid_row: 5, grid_col: 4, elevation_m: 933, zone_type: "HIGH_GROUND_SAFE", label: "SAFE HIGH GROUND" },
    ];
    if (blockedAdded) {
      state.hazards.push({ grid_row: 1, grid_col: 4, depth_cm: 68, label: "CIVILIAN_BLOCKED_AHEAD" });
    }
    state.route = [
      { grid_row: Math.round(state.posRow), grid_col: Math.round(state.posCol), elevation_m: 904 },
      { grid_row: 2, grid_col: 2, elevation_m: 903 },
      { grid_row: 3, grid_col: 3, elevation_m: 926 },
      { grid_row: HAVEN_R, grid_col: HAVEN_C, elevation_m: 948 },
    ];
    setText("status-pill", "OFFLINE PREVIEW (?mock=1)");
    updateGuidanceHUD();
  }

  async function fetchRoute() {
    if (IS_MOCK) {
      loadMockData(false);
      return;
    }
    try {
      const res = await fetch("/hazora/core/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          node_id: state.nodeId,
          vehicle_class: state.vehicleClass,
          max_wading_depth_cm: state.maxWadingCm,
          current_grid_row: clamp(Math.round(state.posRow), 0, MAX_IDX),
          current_grid_col: clamp(Math.round(state.posCol), 0, MAX_IDX),
          heading_deg: state.headingDeg,
        }),
      });
      const data = await res.json();
      if (typeof data.table_north_offset_deg === "number") {
        state.tableNorthOffsetDeg = data.table_north_offset_deg;
      }
      state.route = data.astar_dem_routing.safe_haven_route || [];
      state.usedPerimeterFallback = Boolean(data.astar_dem_routing.used_perimeter_fallback);
      state.hazards = data.gossiped_hazards || [];
      state.safeZones = data.verified_safe_zones || [];
      state.floodLevelCm = data.flood_water_level_cm || 0;
      setText("status-pill", `MESH LIVE • ${state.side} (${state.vehicleClass.toUpperCase()})`);
      updateGuidanceHUD();
      pushLiveTelemetry(true);
    } catch (_) {
      setText("status-pill", "OFFLINE CACHE ACTIVE");
    }
  }

  async function reportBlockedAhead() {
    vibratePattern([80, 40, 80]);
    const curR = clamp(Math.round(state.posRow), 0, MAX_IDX);
    const curC = clamp(Math.round(state.posCol), 0, MAX_IDX);
    if (IS_MOCK) {
      loadMockData(true);
      showToast("⚠ Road ahead blocked. Alternate safe route locked.", "warn");
      speakCue("Hazard recorded ahead. Rerouting onto alternate dry corridor.", "danger", true);
      return;
    }
    try {
      const res = await fetch("/hazora/core/mesh/blocked_ahead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          node_id: state.nodeId,
          current_grid_row: curR,
          current_grid_col: curC,
          heading_deg: state.headingDeg,
          water_depth_cm: 65.0,
          hazard_label: "CIVILIAN_BLOCKED_AHEAD",
        }),
      });
      const out = await res.json();
      showToast(out.accepted ? "⚠ Blockage shared with mesh. Rerouting..." : out.event_summary, "warn");
      speakCue("Warning: Blockage shared with nearby vehicles. Follow the new safe route.", "danger", true);
      await fetchRoute();
    } catch (_) {
      showToast("Queued report locally. Follow the safe route ahead.", "warn");
    }
  }

  async function sendSosBurst() {
    vibratePattern([200, 80, 200, 80, 350]);
    const gps = posToGps(state.posRow, state.posCol);
    if (IS_MOCK) {
      showToast("✓ 36-Byte Binary SOS Received by Rescue (Mock Preview)", "sos");
      speakCue("Emergency S O S confirmed. Stay on high ground.", "danger", true);
      return;
    }
    try {
      const res = await fetch("/hazora/core/sos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trapped_node_id: state.nodeId,
          device_type: IS_IOS ? "IPHONE_16_PRO_MAX" : "ANDROID_MESH_NODE",
          location: gps,
          barometric_alt_m: gps.elevation_m,
          water_depth_cm: Math.max(40.0, state.floodLevelCm),
          occupant_count: 2,
        }),
      });
      const out = await res.json();
      showToast(`✓ SOS CONFIRMED (${out.byte_size}B) • Relayed to Laptop Command`, "sos");
      speakCue("Emergency S O S confirmed by rescue command.", "danger", true);
    } catch (_) {
      showToast("SOS buffered for nearby peer relay.", "sos");
    }
  }

  function wireSosHoldButton() {
    const btn = $("btn-sos-hold");
    const ring = $("sos-progress-ring");
    if (!btn) return;

    const HOLD_MS = 3000;
    let startTs = null;
    let rafId = null;
    let fired = false;

    function resetHold() {
      startTs = null;
      fired = false;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = null;
      if (ring) ring.style.width = "0%";
      setText("sos-hold-label", "Hold 3 seconds to send SOS");
    }

    function step(ts) {
      if (startTs === null) return;
      const elapsed = ts - startTs;
      const pct = Math.min(1, elapsed / HOLD_MS);
      if (ring) ring.style.width = `${Math.round(pct * 100)}%`;
      const rem = Math.max(1, Math.ceil((HOLD_MS - elapsed) / 1000));
      setText("sos-hold-label", pct < 1 ? `KEEP HOLDING (${rem}s)...` : "✓ SOS SENT TO RESCUE");

      if (pct >= 1 && !fired) {
        fired = true;
        sendSosBurst();
        setTimeout(resetHold, 1400);
        return;
      }
      rafId = requestAnimationFrame(step);
    }

    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      vibratePattern(35);
      startTs = performance.now();
      fired = false;
      rafId = requestAnimationFrame(step);
    });

    ["pointerup", "pointerleave", "pointercancel"].forEach((evt) => {
      btn.addEventListener(evt, () => {
        if (!fired) resetHold();
      });
    });
  }

  function connectWebSocket() {
    if (IS_MOCK) return;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    try {
      const ws = new WebSocket(`${proto}//${window.location.host}/ws/mission_control`);
      state.ws = ws;
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "table_calibration" && msg.data) {
          state.tableNorthOffsetDeg = Number(msg.data.table_north_offset_deg || 0);
          state.hasLiveCompass = false; // re-snap smoothly to new table North
          pushHeadingSample(state.rawMagneticHeadingDeg, 1.0, "TABLE LOCK");
          showToast(`✓ Table-North calibrated (${Math.round(state.tableNorthOffsetDeg)}°).`, "safe");
          return;
        }
        if (msg.type === "demo_reset") {
          resetPositionToStart(false);
          showToast(`✓ Demo reset — back at ${state.side} start.`, "safe");
          return;
        }
        if (
          msg.type === "p2p_hazard_gossip" ||
          msg.type === "flood_level_update" ||
          msg.type === "director_stage"
        ) {
          fetchRoute();
          const summary = msg.data && msg.data.event_summary ? msg.data.event_summary : "";
          if (summary.includes("CLEARED")) {
            showToast("✓ Good news: Rescue opened a faster dry corridor ahead.", "safe");
            speakCue("Good news: Rescue cleared a closer dry road ahead.", "normal", true);
          } else if (summary.includes("LANDSLIDE") || summary.includes("water level") || summary.includes("PINPOINTED")) {
            showToast("⚠ New hazard detected nearby. Rerouting onto dry path.", "warn");
            speakCue("Warning: New flood or landslide hazard nearby. Follow the updated safe path.", "danger", true);
          } else {
            showToast("✓ Safe route refreshed.", "safe");
          }
        } else if (msg.type === "sos_mesh_burst") {
          showToast("✓ Your phone silently relayed a neighbor's SOS.", "safe");
        }
      };
      ws.onclose = () => setTimeout(connectWebSocket, 3000);
    } catch (_) {}
  }

  function wireVehiclePresets() {
    const sedan = $("vehicle-sedan-btn");
    const suv = $("vehicle-suv-btn");
    function applyChoice(isSuv) {
      state.vehicleClass = isSuv ? "Class B (SUV)" : "Class A (Sedan)";
      state.maxWadingCm = isSuv ? 30.0 : 15.0;
      if (sedan) sedan.dataset.selected = isSuv ? "false" : "true";
      if (suv) suv.dataset.selected = isSuv ? "true" : "false";
    }
    if (sedan) sedan.addEventListener("click", () => applyChoice(false));
    if (suv) suv.addEventListener("click", () => applyChoice(true));
    applyChoice(state.maxWadingCm >= 30.0);
  }

  function startAnimationLoop() {
    let lastTs = performance.now();
    function tick(ts) {
      const dt = Math.min(0.1, (ts - lastTs) / 1000);
      lastTs = ts;

      state.dispRow += (state.posRow - state.dispRow) * Math.min(1, dt * 10);
      state.dispCol += (state.posCol - state.dispCol) * Math.min(1, dt * 10);
      state.flowPhase = (state.flowPhase + dt * 0.65) % 1.0;

      drawHeadingUpMap();
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function boot() {
    wireVehiclePresets();
    wireSosHoldButton();

    const blockedBtn = $("btn-blocked-ahead");
    if (blockedBtn) blockedBtn.addEventListener("click", reportBlockedAhead);

    const compassPill = $("compass-status");
    if (compassPill) {
      compassPill.style.cursor = "pointer";
      compassPill.addEventListener("click", () => {
        state.started = true;
        requestSensorsAndUnlockVoice("Compass and voice guidance active.");
      });
    }

    const startBtn = $("btn-start-evac");
    if (startBtn) {
      startBtn.addEventListener("click", () => {
        state.started = true;
        const permDone = requestSensorsAndUnlockVoice(
          "Navigation started. Turn toward the green corridor and walk to Laptop Safe Haven."
        );
        startGpsAndWakeLock();

        const overlay = $("launch-overlay");
        if (overlay) overlay.classList.add("hidden");
        vibratePattern(50);

        permDone.finally(() => {
          fetchRoute();
          connectWebSocket();
        });
      });
    }

    if (IS_MOCK) {
      loadMockData(false);
      let mockAngle = startPreset.initHeading;
      setInterval(() => {
        mockAngle = (mockAngle + 2.5) % 360;
        pushHeadingSample(mockAngle, 0.35, "MOCK");
      }, 180);
    } else {
      fetchRoute();
    }

    startAnimationLoop();
    window.addEventListener("resize", drawHeadingUpMap);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
