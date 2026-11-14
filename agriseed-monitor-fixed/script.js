/**
 * AgriSeed Monitor — Modular Client-Side Application Engine (script.js)
 * ----------------------------------------------------------------------------
 * Consolidates the entire AgriSeed Monitor system into clean vanilla JS modules:
 * 1. Seed Profiles & Hardware Guardrails
 * 2. LocalStorage Persistent Store (Devices, Configs, Batches, Readings, Alerts)
 * 3. Controller Validation, Hysteresis Safety, Alert Deduplication & Health Scoring
 * 4. Built-in Autonomous ESP32 Physics & PWM Simulator
 * 5. Custom High-DPI Dual-Axis & Actuator Canvas Chart Renderer (Zero external libs)
 * 6. ESP32 Firmware (.ino) Generator & CSV Exporter
 * 7. Unified Single-Page UI Controller (Overview, WiFi/Sim, Batches, Guide, History)
 */

(function () {
  'use strict';

  // ==========================================================================
  // 1. CONSTANTS, HARDWARE SAFETY BOUNDS & PROVISIONAL SEED PROFILES
  // ==========================================================================
  const STORAGE_KEY = 'agriseed_monitor_state_v1';
  const SELECTED_DEVICE_KEY = 'agriseed_selected_device';
  const DEVICE_OFFLINE_SECONDS = 30;
  const ALERT_COOLDOWN_MINUTES = 15;
  const MAX_STORED_READINGS = 2500;

  const HARDWARE_BOUNDS = {
    ABS_TEMP_MIN: 2.0,
    ABS_TEMP_MAX: 35.0,
    MIN_OPERATING_SPAN: 1.5,
    MIN_HYSTERESIS: 0.6,
    MIN_COMPRESSOR_OFF_SEC: 180,
    MIN_COMPRESSOR_ON_SEC: 60,
    FAN_ABS_MIN: 0,
    FAN_ABS_MAX: 100
  };

  const STARTER_SEED_PROFILES = [
    {
      id: 1,
      name: 'Wheat',
      temp_min: 15.0,
      temp_max: 20.0,
      rh_min: 40.0,
      rh_max: 50.0,
      shelf_days: 360,
      notes:
        'Provisional demo profile (15–20 °C, 40–50% RH, 360 days). Keep grain dried to safe moisture before sealing chamber; verify against ICAR/NBPGR wheat storage standards.'
    },
    {
      id: 2,
      name: 'Barley',
      temp_min: 15.0,
      temp_max: 20.0,
      rh_min: 40.0,
      rh_max: 50.0,
      shelf_days: 360,
      notes:
        'Provisional demo profile (15–20 °C, 40–50% RH, 360 days). Sensitive to high humidity germination loss; verify against ICAR/NBPGR barley recommendations.'
    },
    {
      id: 3,
      name: 'Rice',
      temp_min: 15.0,
      temp_max: 20.0,
      rh_min: 40.0,
      rh_max: 50.0,
      shelf_days: 360,
      notes:
        'Provisional demo profile (15–20 °C, 40–50% RH, 360 days). Avoid condensation when removing paddy batches from cool storage; verify against ICAR/NBPGR standards.'
    },
    {
      id: 4,
      name: 'Maize',
      temp_min: 15.0,
      temp_max: 18.0,
      rh_min: 40.0,
      rh_max: 50.0,
      shelf_days: 210,
      notes:
        'Provisional demo profile (15–18 °C, 40–50% RH, 210 days). Narrower upper temperature band and shorter medium-term storage horizon; verify against ICAR/NBPGR maize rules.'
    },
    {
      id: 5,
      name: 'Chickpea',
      temp_min: 18.0,
      temp_max: 22.0,
      rh_min: 35.0,
      rh_max: 45.0,
      shelf_days: 330,
      notes:
        'Provisional demo profile (18–22 °C, 35–45% RH, 330 days). Pulse crops generally require lower relative humidity (35–45% RH) to deter bruchid and fungal activity; verify with ICAR/NBPGR.'
    },
    {
      id: 6,
      name: 'Mustard',
      temp_min: 15.0,
      temp_max: 20.0,
      rh_min: 35.0,
      rh_max: 45.0,
      shelf_days: 300,
      notes:
        'Provisional demo profile (15–20 °C, 35–45% RH, 300 days). Oilseed crops have higher lipid content and need lower RH (35–45%) to prevent rancidity; verify with ICAR/NBPGR.'
    }
  ];

  // ==========================================================================
  // 2. DATE, FORMATTING & ESCAPE UTILITIES
  // ==========================================================================
  function nowUtc() {
    return new Date().toISOString();
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDateParts(isoString) {
    if (!isoString) return { date: '—', time: '—', full: '—' };
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return { date: '—', time: '—', full: '—' };

    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    const sec = String(d.getSeconds()).padStart(2, '0');

    return {
      date: `${yyyy}-${mm}-${dd}`,
      time: `${hh}:${min}:${sec}`,
      full: `${yyyy}-${mm}-${dd} ${hh}:${min}:${sec}`
    };
  }

  function formatRelativeAge(seconds) {
    if (seconds === null || seconds === undefined) return 'Never connected';
    if (seconds < 5) return 'Just now';
    if (seconds < 60) return `${seconds}s ago`;
    const mins = Math.floor(seconds / 60);
    if (mins < 60) return `${mins}m ${seconds % 60}s ago`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ${mins % 60}m ago`;
  }

  function computeBatchDayMetrics(startedAtIso, plannedDays, referenceMs = Date.now()) {
    const startedMs = Date.parse(startedAtIso);
    if (Number.isNaN(startedMs)) {
      return { days_stored: 0, days_remaining: plannedDays, is_overdue: false };
    }
    const elapsedMs = Math.max(0, referenceMs - startedMs);
    const daysStored = Math.floor(elapsedMs / 86_400_000);
    const daysRemaining = Math.max(0, Number(plannedDays) - daysStored);
    return {
      days_stored: daysStored,
      days_remaining: daysRemaining,
      is_overdue: daysStored >= Number(plannedDays)
    };
  }

  // ==========================================================================
  // 3. PERSISTENT STATE STORE (LocalStorage-backed relational model)
  // ==========================================================================
  function createInitialStoreState() {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const batchStartIso = new Date(nowMs - 14 * 86_400_000).toISOString();

    const defaultConfig = {
      device_id: 'chamber-01',
      target_temp: 17.5,
      temp_min: 15.0,
      temp_max: 20.0,
      cooling_on_temp: 18.2,
      cooling_off_temp: 16.8,
      fan_min_percent: 25,
      fan_max_percent: 85,
      manual_fan_percent: 45,
      control_mode: 'auto',
      manual_expires_at: null,
      config_version: 1,
      updated_at: nowIso
    };

    const ackSnapshot = {
      config_version: 1,
      target_temp: 17.5,
      temp_min: 15.0,
      temp_max: 20.0,
      cooling_on_temp: 18.2,
      cooling_off_temp: 16.8,
      fan_min_percent: 25,
      fan_max_percent: 85,
      control_mode: 'auto',
      manual_fan_percent: 45
    };

    // Pre-seed 64 realistic historical readings over the past 24 hours so both
    // live and historical charts immediately show authentic hysteresis cycles.
    const readings = [];
    let simT = 17.9;
    let simRh = 44.6;
    let simCool = false;
    let simFan = 35;

    for (let i = 63; i >= 0; i--) {
      const ts = new Date(nowMs - i * 15 * 60_000).toISOString();
      if (i > 4) {
        // Historical 15-min intervals
        const drift = simCool ? -0.34 : 0.21;
        simT = Math.max(16.4, Math.min(18.6, simT + drift + (Math.sin(i * 0.7) * 0.08)));
        if (!simCool && simT >= 18.2) simCool = true;
        if (simCool && simT <= 16.8) simCool = false;
      } else {
        // Recent 5-second cadence leading right up to now
        const recentTs = new Date(nowMs - i * 5000).toISOString();
        const drift = simCool ? -0.18 : 0.11;
        simT = Math.max(16.6, Math.min(18.4, simT + drift));
        if (!simCool && simT >= 18.2) simCool = true;
        if (simCool && simT <= 16.8) simCool = false;
        const ratio = Math.max(0, Math.min(1, (simT - 17.5) / 2.5));
        simFan = Math.round(25 + ratio * 60);
        simRh = Number((44.5 + Math.cos(i) * 1.1).toFixed(1));
        readings.push({
          id: 64 - i,
          device_id: 'chamber-01',
          batch_id: 1,
          temp: Number(simT.toFixed(2)),
          humidity: simRh,
          fan_speed_percent: simFan,
          fan_rpm: Math.round(260 + (simFan / 100) * 1940),
          cooling_on: simCool ? 1 : 0,
          sensor_ok: 1,
          is_simulated: 1,
          created_at: recentTs
        });
        continue;
      }

      const ratio = Math.max(0, Math.min(1, (simT - 17.5) / 2.5));
      simFan = Math.round(25 + ratio * 60);
      simRh = Number((44.4 + Math.sin(i * 0.45) * 1.6).toFixed(1));
      readings.push({
        id: 64 - i,
        device_id: 'chamber-01',
        batch_id: 1,
        temp: Number(simT.toFixed(2)),
        humidity: simRh,
        fan_speed_percent: simFan,
        fan_rpm: Math.round(260 + (simFan / 100) * 1940),
        cooling_on: simCool ? 1 : 0,
        sensor_ok: 1,
        is_simulated: 1,
        created_at: ts
      });
    }

    return {
      nextIds: {
        batch: 2,
        reading: readings.length + 1,
        alert: 1
      },
      devices: [
        {
          id: 'chamber-01',
          device_name: 'Primary Seed Chamber 01',
          device_key: 'chamber-01-local-secret-key',
          status: 'online',
          last_seen_at: nowIso,
          acknowledged_config: ackSnapshot,
          last_ack_at: nowIso,
          diagnostics: {
            firmware: 'sim-esp32-v1.0',
            wifi_rssi_dbm: -53,
            uptime_sec: 86400,
            mode: 'normal'
          },
          created_at: batchStartIso
        }
      ],
      configs: {
        'chamber-01': defaultConfig
      },
      batches: [
        {
          id: 1,
          device_id: 'chamber-01',
          seed_profile_id: 1,
          label: 'Rabi Wheat Lot A-101',
          quantity_kg: 45.0,
          started_at: batchStartIso,
          planned_days: 360,
          status: 'active',
          closed_at: null
        }
      ],
      readings,
      alerts: []
    };
  }

  function loadStore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        const fresh = createInitialStoreState();
        saveStore(fresh);
        return fresh;
      }
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.devices) || !parsed.configs) {
        const fresh = createInitialStoreState();
        saveStore(fresh);
        return fresh;
      }
      return parsed;
    } catch {
      return createInitialStoreState();
    }
  }

  function saveStore(state) {
    try {
      if (state.readings.length > MAX_STORED_READINGS) {
        state.readings = state.readings.slice(state.readings.length - MAX_STORED_READINGS);
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Ignore storage quota exceptions cleanly
    }
  }

  let store = loadStore();

  function getSeedProfileById(id) {
    return STARTER_SEED_PROFILES.find((p) => Number(p.id) === Number(id)) || STARTER_SEED_PROFILES[0];
  }

  function getSelectedDeviceId() {
    const saved = localStorage.getItem(SELECTED_DEVICE_KEY);
    if (saved && store.devices.some((d) => d.id === saved)) {
      return saved;
    }
    const fallback = store.devices[0] ? store.devices[0].id : 'chamber-01';
    localStorage.setItem(SELECTED_DEVICE_KEY, fallback);
    return fallback;
  }

  function setSelectedDeviceId(id) {
    localStorage.setItem(SELECTED_DEVICE_KEY, id);
  }

  function getActiveBatchForDevice(deviceId) {
    const row = store.batches.find((b) => b.device_id === deviceId && b.status === 'active');
    if (!row) return null;
    const profile = getSeedProfileById(row.seed_profile_id);
    return {
      ...row,
      seed_name: profile.name,
      temp_min: profile.temp_min,
      temp_max: profile.temp_max,
      rh_min: profile.rh_min,
      rh_max: profile.rh_max,
      shelf_days: profile.shelf_days,
      profile_notes: profile.notes,
      ...computeBatchDayMetrics(row.started_at, row.planned_days)
    };
  }

  // ==========================================================================
  // 4. CONTROLLER VALIDATION, CONNECTIVITY, HYSTERESIS & ALERTS ENGINE
  // ==========================================================================
  function validateControlConfig(input, currentConfig = {}) {
    const errors = [];

    const tempMin = Number(input.temp_min ?? currentConfig.temp_min);
    const tempMax = Number(input.temp_max ?? currentConfig.temp_max);
    const targetTemp = Number(input.target_temp ?? currentConfig.target_temp);

    if (!Number.isFinite(tempMin) || !Number.isFinite(tempMax) || !Number.isFinite(targetTemp)) {
      errors.push('Temperature target and operating limits must be valid numbers.');
    } else {
      if (tempMin < HARDWARE_BOUNDS.ABS_TEMP_MIN || tempMax > HARDWARE_BOUNDS.ABS_TEMP_MAX) {
        errors.push(
          `Operating temperature limits must stay within ${HARDWARE_BOUNDS.ABS_TEMP_MIN} °C and ${HARDWARE_BOUNDS.ABS_TEMP_MAX} °C.`
        );
      }
      if (tempMax - tempMin < HARDWARE_BOUNDS.MIN_OPERATING_SPAN) {
        errors.push(
          `Upper limit must exceed lower limit by at least ${HARDWARE_BOUNDS.MIN_OPERATING_SPAN} °C.`
        );
      }
      if (targetTemp < tempMin + 0.3 || targetTemp > tempMax - 0.3) {
        errors.push(
          'Target temperature must sit at least 0.3 °C inside the configured [Min Limit, Max Limit] band.'
        );
      }
    }

    const coolingOnTemp =
      input.cooling_on_temp !== undefined
        ? Number(input.cooling_on_temp)
        : Number((targetTemp + 0.7).toFixed(1));
    const coolingOffTemp =
      input.cooling_off_temp !== undefined
        ? Number(input.cooling_off_temp)
        : Number((targetTemp - 0.7).toFixed(1));

    if (!Number.isFinite(coolingOnTemp) || !Number.isFinite(coolingOffTemp)) {
      errors.push('Cooling ON and OFF thresholds must be valid numbers.');
    } else {
      if (coolingOnTemp - coolingOffTemp < HARDWARE_BOUNDS.MIN_HYSTERESIS) {
        errors.push(
          `Cooling hysteresis (ON minus OFF threshold) must be at least ${HARDWARE_BOUNDS.MIN_HYSTERESIS} °C to protect the compressor from rapid switching.`
        );
      }
      if (coolingOffTemp < HARDWARE_BOUNDS.ABS_TEMP_MIN || coolingOnTemp > HARDWARE_BOUNDS.ABS_TEMP_MAX) {
        errors.push('Cooling ON/OFF thresholds exceed safe refrigeration bounds.');
      }
      if (coolingOffTemp > targetTemp || coolingOnTemp < targetTemp) {
        errors.push('Target temperature must lie between the Cooling OFF and Cooling ON thresholds.');
      }
    }

    const fanMin = Math.round(Number(input.fan_min_percent ?? currentConfig.fan_min_percent ?? 25));
    const fanMax = Math.round(Number(input.fan_max_percent ?? currentConfig.fan_max_percent ?? 85));

    if (!Number.isFinite(fanMin) || !Number.isFinite(fanMax)) {
      errors.push('Fan minimum and maximum percentages must be valid numbers.');
    } else {
      if (fanMin < HARDWARE_BOUNDS.FAN_ABS_MIN || fanMax > HARDWARE_BOUNDS.FAN_ABS_MAX) {
        errors.push('Fan speed limits must stay between 0% and 100%.');
      }
      if (fanMin > fanMax) {
        errors.push('Minimum fan speed cannot exceed maximum fan speed.');
      }
    }

    const controlMode = String(input.control_mode ?? currentConfig.control_mode ?? 'auto').toLowerCase();
    if (controlMode !== 'auto' && controlMode !== 'manual') {
      errors.push('Control mode must be either "auto" or "manual".');
    }

    let manualFanPercent = Math.round(
      Number(input.manual_fan_percent ?? currentConfig.manual_fan_percent ?? Math.max(fanMin, 40))
    );
    if (!Number.isFinite(manualFanPercent) || manualFanPercent < 0 || manualFanPercent > 100) {
      errors.push('Manual fan speed must be between 0% and 100%.');
    } else if (controlMode === 'manual' && (manualFanPercent < fanMin || manualFanPercent > fanMax)) {
      errors.push(
        `Manual fan speed (${manualFanPercent}%) must stay within configured fan hardware limits (${fanMin}%–${fanMax}%).`
      );
    } else {
      manualFanPercent = Math.min(fanMax, Math.max(fanMin, manualFanPercent));
    }

    const timeoutMinutes = Math.min(
      240,
      Math.max(1, Math.round(Number(input.manual_timeout_minutes ?? 30)))
    );

    const manualExpiresAt =
      controlMode === 'manual'
        ? new Date(Date.now() + timeoutMinutes * 60_000).toISOString()
        : null;

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    return {
      valid: true,
      value: {
        target_temp: Number(targetTemp.toFixed(1)),
        temp_min: Number(tempMin.toFixed(1)),
        temp_max: Number(tempMax.toFixed(1)),
        cooling_on_temp: Number(coolingOnTemp.toFixed(1)),
        cooling_off_temp: Number(coolingOffTemp.toFixed(1)),
        fan_min_percent: fanMin,
        fan_max_percent: fanMax,
        manual_fan_percent: manualFanPercent,
        control_mode: controlMode,
        manual_expires_at: manualExpiresAt
      }
    };
  }

  function computeDeviceConnectivity(device) {
    if (!device || !device.last_seen_at) {
      return {
        is_online: false,
        is_stale: true,
        seconds_since_seen: null,
        offline_threshold_sec: DEVICE_OFFLINE_SECONDS
      };
    }
    const seenMs = Date.parse(device.last_seen_at);
    const ageSec = Number.isNaN(seenMs) ? null : Math.max(0, Math.round((Date.now() - seenMs) / 1000));
    const isOnline = ageSec !== null && ageSec <= DEVICE_OFFLINE_SECONDS;
    return {
      is_online: isOnline,
      is_stale: !isOnline,
      seconds_since_seen: ageSec,
      offline_threshold_sec: DEVICE_OFFLINE_SECONDS
    };
  }

  function isConfigAcknowledged(configRow, deviceRow) {
    if (!configRow || !deviceRow || !deviceRow.acknowledged_config) {
      return { synced: false, acknowledged: null };
    }
    const ack = deviceRow.acknowledged_config;
    const synced =
      Number(ack.config_version) === Number(configRow.config_version) ||
      (Number(ack.target_temp) === Number(configRow.target_temp) &&
        Number(ack.temp_min) === Number(configRow.temp_min) &&
        Number(ack.temp_max) === Number(configRow.temp_max) &&
        Number(ack.fan_min_percent) === Number(configRow.fan_min_percent) &&
        Number(ack.fan_max_percent) === Number(configRow.fan_max_percent) &&
        String(ack.control_mode) === String(configRow.control_mode) &&
        (configRow.control_mode !== 'manual' ||
          Number(ack.manual_fan_percent) === Number(configRow.manual_fan_percent)));
    return { synced, acknowledged: ack };
  }

  function raiseAlertWithCooldown({ deviceId, batchId = null, kind, message }) {
    const cutoffIso = new Date(Date.now() - ALERT_COOLDOWN_MINUTES * 60_000).toISOString();
    const recent = store.alerts.find(
      (a) =>
        a.device_id === deviceId &&
        a.kind === kind &&
        (a.resolved_at === null || a.created_at >= cutoffIso)
    );
    if (recent) return null;

    const alertObj = {
      id: store.nextIds.alert++,
      device_id: deviceId,
      batch_id: batchId,
      kind,
      message,
      created_at: nowUtc(),
      acknowledged: 0,
      acknowledged_at: null,
      resolved_at: null
    };
    store.alerts.unshift(alertObj);
    return alertObj.id;
  }

  function resolveAlertsByKind(deviceId, kinds) {
    const now = nowUtc();
    for (const a of store.alerts) {
      if (a.device_id === deviceId && a.resolved_at === null && kinds.includes(a.kind)) {
        a.resolved_at = now;
      }
    }
  }

  function evaluateReadingAlerts({ device, config, activeBatch, reading }) {
    const batchId = activeBatch ? activeBatch.id : null;
    const rhMin = activeBatch ? activeBatch.rh_min : 35.0;
    const rhMax = activeBatch ? activeBatch.rh_max : 55.0;

    resolveAlertsByKind(device.id, ['device_offline']);

    if (!reading.sensor_ok || reading.temp === null || reading.humidity === null) {
      raiseAlertWithCooldown({
        deviceId: device.id,
        batchId,
        kind: 'sensor_failure',
        message: `DHT22 sensor fault reported by ${device.id}. ESP32 entered safe fallback mode; verify sensor wiring on GPIO 4.`
      });
      return;
    }

    resolveAlertsByKind(device.id, ['sensor_failure']);

    if (reading.temp > config.temp_max) {
      raiseAlertWithCooldown({
        deviceId: device.id,
        batchId,
        kind: 'high_temp',
        message: `High chamber temperature: ${reading.temp.toFixed(1)} °C exceeds upper limit (${config.temp_max.toFixed(1)} °C).`
      });
      resolveAlertsByKind(device.id, ['low_temp']);
    } else if (reading.temp < config.temp_min) {
      raiseAlertWithCooldown({
        deviceId: device.id,
        batchId,
        kind: 'low_temp',
        message: `Low chamber temperature: ${reading.temp.toFixed(1)} °C is below lower limit (${config.temp_min.toFixed(1)} °C).`
      });
      resolveAlertsByKind(device.id, ['high_temp']);
    } else if (reading.temp <= config.temp_max - 0.3 && reading.temp >= config.temp_min + 0.3) {
      resolveAlertsByKind(device.id, ['high_temp', 'low_temp']);
    }

    if (reading.humidity > rhMax) {
      raiseAlertWithCooldown({
        deviceId: device.id,
        batchId,
        kind: 'high_humidity',
        message: `High relative humidity: ${reading.humidity.toFixed(1)}% exceeds allowed limit (${rhMax.toFixed(0)}% RH). Check door seal and desiccant.`
      });
      resolveAlertsByKind(device.id, ['low_humidity']);
    } else if (reading.humidity < rhMin) {
      raiseAlertWithCooldown({
        deviceId: device.id,
        batchId,
        kind: 'low_humidity',
        message: `Low relative humidity: ${reading.humidity.toFixed(1)}% is below allowed minimum (${rhMin.toFixed(0)}% RH).`
      });
      resolveAlertsByKind(device.id, ['high_humidity']);
    } else if (reading.humidity <= rhMax - 1.5 && reading.humidity >= rhMin + 1.5) {
      resolveAlertsByKind(device.id, ['high_humidity', 'low_humidity']);
    }
  }

  function computeVisualChamberStatus({
    isOnline,
    isStale,
    latestReading,
    config,
    rhMin,
    rhMax,
    configSynced
  }) {
    if (!isOnline || isStale || !latestReading) {
      return {
        level: 'grey',
        label: !latestReading ? 'No Readings Yet' : 'Device Offline / Stale Data',
        detail: !latestReading
          ? 'Waiting for ESP32 or Simulator telemetry.'
          : 'Last reading is older than the 30s live freshness window. Values shown are historical.'
      };
    }

    if (!latestReading.sensor_ok || latestReading.temp === null || latestReading.humidity === null) {
      return {
        level: 'red',
        label: 'Sensor Fault — Fallback Active',
        detail:
          'DHT22 failed validation. Safe fallback circulation active (40% PWM, Cooling OFF); inspect GPIO 4.'
      };
    }

    const t = latestReading.temp;
    const h = latestReading.humidity;

    if (t > config.temp_max || t < config.temp_min || h > rhMax || h < rhMin) {
      const reasons = [];
      if (t > config.temp_max) reasons.push(`Temp ${t.toFixed(1)} °C > ${config.temp_max.toFixed(1)} °C`);
      if (t < config.temp_min) reasons.push(`Temp ${t.toFixed(1)} °C < ${config.temp_min.toFixed(1)} °C`);
      if (h > rhMax) reasons.push(`Humidity ${h.toFixed(1)}% > ${rhMax.toFixed(0)}%`);
      if (h < rhMin) reasons.push(`Humidity ${h.toFixed(1)}% < ${rhMin.toFixed(0)}%`);
      return {
        level: 'red',
        label: 'Operating Limit Exceeded',
        detail: reasons.join(' · ')
      };
    }

    const nearTempLimit = t >= config.temp_max - 0.8 || t <= config.temp_min + 0.8;
    const nearRhLimit = h >= rhMax - 2.5 || h <= rhMin + 2.5;

    if (nearTempLimit || nearRhLimit || config.control_mode === 'manual' || !configSynced) {
      const notes = [];
      if (nearTempLimit) notes.push('Temperature approaching boundary');
      if (nearRhLimit) notes.push('Humidity approaching boundary');
      if (config.control_mode === 'manual') notes.push('Manual fan override active');
      if (!configSynced) notes.push('Waiting for ESP32 config acknowledgement');
      return {
        level: 'amber',
        label: 'Attention / Advisory',
        detail: notes.join(' · ')
      };
    }

    return {
      level: 'green',
      label: 'Nominal Operating Range',
      detail: 'Temperature, relative humidity, and device heartbeat are within target limits.'
    };
  }

  function runMaintenanceChecks() {
    const nowIso = nowUtc();
    const offlineCutoffIso = new Date(Date.now() - DEVICE_OFFLINE_SECONDS * 1000).toISOString();
    let changed = false;

    // 1. Auto-expire manual fan overrides
    for (const cfg of Object.values(store.configs)) {
      if (cfg.control_mode === 'manual' && cfg.manual_expires_at && cfg.manual_expires_at <= nowIso) {
        cfg.control_mode = 'auto';
        cfg.manual_expires_at = null;
        cfg.config_version += 1;
        cfg.updated_at = nowIso;
        changed = true;
      }
    }

    // 2. Detect stale/offline chambers
    for (const dev of store.devices) {
      if (dev.status !== 'offline' && dev.last_seen_at && dev.last_seen_at < offlineCutoffIso) {
        dev.status = 'offline';
        const activeBatch = getActiveBatchForDevice(dev.id);
        raiseAlertWithCooldown({
          deviceId: dev.id,
          batchId: activeBatch ? activeBatch.id : null,
          kind: 'device_offline',
          message: `Chamber ${dev.id} has not reported for over ${DEVICE_OFFLINE_SECONDS}s. ESP32 continues local temperature control using its last valid configuration.`
        });
        changed = true;
      }
    }

    // 3. Batch storage horizon alerts
    for (const b of store.batches) {
      if (b.status !== 'active') continue;
      const metrics = computeBatchDayMetrics(b.started_at, b.planned_days);
      if (metrics.is_overdue) {
        if (
          raiseAlertWithCooldown({
            deviceId: b.device_id,
            batchId: b.id,
            kind: 'batch_overdue',
            message: `Seed batch "${b.label}" has reached its planned storage limit (${b.planned_days} days). Inspect seed viability.`
          })
        ) {
          changed = true;
        }
      } else if (metrics.days_remaining <= 7) {
        if (
          raiseAlertWithCooldown({
            deviceId: b.device_id,
            batchId: b.id,
            kind: 'batch_expiring',
            message: `Seed batch "${b.label}" has ${metrics.days_remaining} day(s) remaining out of ${b.planned_days} planned days.`
          })
        ) {
          changed = true;
        }
      }
    }

    if (changed) saveStore(store);
  }

  // ==========================================================================
  // 5. HARDWARE-FREE ESP32 CHAMBER PHYSICS SIMULATOR
  // ==========================================================================
  class ChamberSimulator {
    constructor(deviceId = 'chamber-01') {
      this.deviceId = deviceId;
      this.intervalMs = 5000;
      this.mode = 'normal';
      this.running = false;
      this.timer = null;
      this.tickCount = 0;

      const latest = [...store.readings].reverse().find((r) => r.device_id === deviceId && r.sensor_ok);
      this.temp = latest && latest.temp !== null ? latest.temp : 17.8;
      this.humidity = latest && latest.humidity !== null ? latest.humidity : 44.8;
      this.coolingOn = latest ? Boolean(latest.cooling_on) : false;
      this.lastCoolingSwitchMs = Date.now() - 240_000;
      this.commandedFanPercent = latest ? latest.fan_speed_percent : 35;

      this.localConfig = {
        ...(store.configs[deviceId] || {}),
        min_compressor_off_sec: 15,
        min_compressor_on_sec: 10
      };
    }

    setMode(newMode) {
      const allowed = [
        'normal',
        'high_temp',
        'low_temp',
        'high_humidity',
        'sensor_fault',
        'no_rpm',
        'offline'
      ];
      if (allowed.includes(newMode)) {
        this.mode = newMode;
      }
    }

    start() {
      if (this.running) return;
      this.running = true;
      this.step();
      this.timer = setInterval(() => this.step(), this.intervalMs);
    }

    stop() {
      this.running = false;
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }

    getStatus() {
      return {
        running: this.running,
        device_id: this.deviceId,
        mode: this.mode,
        tick_count: this.tickCount
      };
    }

    step() {
      this.tickCount += 1;
      const serverCfg = store.configs[this.deviceId];

      // 1. Poll configuration from controller unless simulating Wi-Fi offline
      if (this.mode !== 'offline' && serverCfg) {
        this.localConfig = {
          ...this.localConfig,
          ...serverCfg,
          min_compressor_off_sec: 15,
          min_compressor_on_sec: 10
        };
      }

      // 2. Execute local autonomous physics + hysteresis + PWM fan control
      this.updatePhysics();

      // If simulating offline radio disconnect, do not transmit reading
      if (this.mode === 'offline') {
        runMaintenanceChecks();
        refreshActiveViews();
        return;
      }

      // 3. Construct & ingest telemetry reading
      const sensorOk = this.mode !== 'sensor_fault';
      const simulatedRpm =
        this.mode === 'no_rpm'
          ? null
          : this.commandedFanPercent <= 0
            ? 0
            : Math.round(
                260 + (this.commandedFanPercent / 100) * 1940 + (Math.random() - 0.5) * 28
              );

      const now = nowUtc();
      const activeBatch = getActiveBatchForDevice(this.deviceId);
      const reading = {
        id: store.nextIds.reading++,
        device_id: this.deviceId,
        batch_id: activeBatch ? activeBatch.id : null,
        temp: sensorOk ? Number(this.temp.toFixed(2)) : null,
        humidity: sensorOk ? Number(this.humidity.toFixed(1)) : null,
        fan_speed_percent: this.commandedFanPercent,
        fan_rpm: simulatedRpm,
        cooling_on: this.coolingOn ? 1 : 0,
        sensor_ok: sensorOk ? 1 : 0,
        is_simulated: 1,
        created_at: now
      };

      store.readings.push(reading);

      const dev = store.devices.find((d) => d.id === this.deviceId);
      if (dev) {
        dev.status = sensorOk ? 'online' : 'fault';
        dev.last_seen_at = now;
        dev.last_ack_at = now;
        dev.acknowledged_config = {
          config_version: this.localConfig.config_version,
          target_temp: this.localConfig.target_temp,
          temp_min: this.localConfig.temp_min,
          temp_max: this.localConfig.temp_max,
          cooling_on_temp: this.localConfig.cooling_on_temp,
          cooling_off_temp: this.localConfig.cooling_off_temp,
          fan_min_percent: this.localConfig.fan_min_percent,
          fan_max_percent: this.localConfig.fan_max_percent,
          control_mode: this.localConfig.control_mode,
          manual_fan_percent: this.localConfig.manual_fan_percent
        };
        dev.diagnostics = {
          firmware: 'sim-esp32-v1.0',
          wifi_rssi_dbm: -54 + Math.round((Math.random() - 0.5) * 6),
          uptime_sec: 86400 + this.tickCount * 5,
          mode: this.mode
        };

        if (serverCfg) {
          evaluateReadingAlerts({
            device: dev,
            config: serverCfg,
            activeBatch,
            reading: {
              temp: reading.temp,
              humidity: reading.humidity,
              sensor_ok: sensorOk
            }
          });
        }
      }

      runMaintenanceChecks();
      saveStore(store);
      refreshActiveViews();
    }

    updatePhysics() {
      const now = Date.now();
      const cfg = this.localConfig;

      if (this.mode === 'sensor_fault') {
        this.coolingOn = false;
        this.commandedFanPercent = Math.min(cfg.fan_max_percent, Math.max(cfg.fan_min_percent, 40));
        return;
      }

      if (this.mode === 'high_temp') {
        this.temp = cfg.temp_max + 2.1 + (Math.random() - 0.5) * 0.3;
        this.humidity = 46.0 + (Math.random() - 0.5) * 1.2;
      } else if (this.mode === 'low_temp') {
        this.temp = cfg.temp_min - 1.8 + (Math.random() - 0.5) * 0.3;
        this.humidity = 44.0 + (Math.random() - 0.5) * 1.2;
      } else if (this.mode === 'high_humidity') {
        this.temp = cfg.target_temp + (Math.random() - 0.5) * 0.4;
        this.humidity = 64.5 + (Math.random() - 0.5) * 1.5;
      } else {
        const noise = (Math.random() - 0.5) * 0.12;
        const delta = this.coolingOn ? -0.22 : 0.11;
        this.temp = Math.max(4.0, Math.min(34.0, this.temp + delta + noise));

        const rhPull = (44.5 - this.humidity) * 0.14;
        const rhCoolEffect = this.coolingOn ? -0.15 : 0.1;
        this.humidity = Math.max(
          25.0,
          Math.min(85.0, this.humidity + rhPull + rhCoolEffect + (Math.random() - 0.5) * 0.6)
        );
      }

      // Separate Cooling Hysteresis + Compressor Minimum ON/OFF Rest
      const elapsedSec = (now - this.lastCoolingSwitchMs) / 1000;
      if (!this.coolingOn) {
        if (this.temp >= cfg.cooling_on_temp && elapsedSec >= cfg.min_compressor_off_sec) {
          this.coolingOn = true;
          this.lastCoolingSwitchMs = now;
        }
      } else if (this.temp <= cfg.cooling_off_temp && elapsedSec >= cfg.min_compressor_on_sec) {
        this.coolingOn = false;
        this.lastCoolingSwitchMs = now;
      }

      // Separate PWM Circulation Fan Control
      let desiredFan = cfg.fan_min_percent;
      if (cfg.control_mode === 'manual') {
        desiredFan = Math.min(cfg.fan_max_percent, Math.max(cfg.fan_min_percent, cfg.manual_fan_percent));
      } else if (this.temp <= cfg.target_temp) {
        desiredFan = cfg.fan_min_percent;
      } else if (this.temp >= cfg.temp_max) {
        desiredFan = cfg.fan_max_percent;
      } else {
        const span = Math.max(0.5, cfg.temp_max - cfg.target_temp);
        const ratio = (this.temp - cfg.target_temp) / span;
        desiredFan = Math.round(cfg.fan_min_percent + ratio * (cfg.fan_max_percent - cfg.fan_min_percent));
      }

      const maxStep = 15;
      const diff = desiredFan - this.commandedFanPercent;
      if (Math.abs(diff) <= maxStep) {
        this.commandedFanPercent = desiredFan;
      } else {
        this.commandedFanPercent += Math.sign(diff) * maxStep;
      }
    }
  }

  const simulator = new ChamberSimulator('chamber-01');

  // ==========================================================================
  // 6. HIGH-DPI INTERACTIVE CANVAS LINE CHART ENGINE (Zero External Dependencies)
  // ==========================================================================
  class DualLineChart {
    constructor({ canvasId, tooltipId, dualAxis = true, series }) {
      this.canvas = document.getElementById(canvasId);
      this.tooltip = document.getElementById(tooltipId);
      this.dualAxis = dualAxis;
      this.series = series; // [{ label, color, fillRgba, unit, axis: 'left'|'right', stepped }]
      this.labels = [];
      this.datasets = [[], []];
      this.hoverIndex = null;

      this.bindEvents();
    }

    bindEvents() {
      if (!this.canvas) return;
      this.canvas.addEventListener('mousemove', (e) => {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const padLeft = 48;
        const padRight = this.dualAxis ? 46 : 20;
        const plotW = Math.max(10, rect.width - padLeft - padRight);

        if (this.labels.length === 0) return;
        const rel = Math.max(0, Math.min(1, (x - padLeft) / plotW));
        const idx = Math.round(rel * Math.max(0, this.labels.length - 1));
        this.hoverIndex = idx;
        this.draw();
        this.updateTooltip(idx, rect.width, rect.height, padLeft, plotW);
      });

      this.canvas.addEventListener('mouseleave', () => {
        this.hoverIndex = null;
        if (this.tooltip) this.tooltip.classList.add('hidden');
        this.draw();
      });
    }

    setData(labels, series0, series1) {
      this.labels = labels || [];
      this.datasets = [series0 || [], series1 || []];
      if (this.hoverIndex !== null && this.hoverIndex >= this.labels.length) {
        this.hoverIndex = null;
      }
      this.draw();
    }

    computeScale(values, fallbackMin, fallbackMax, fixedBounds = false) {
      if (fixedBounds) return { min: fallbackMin, max: fallbackMax };
      const valid = values.filter((v) => v !== null && v !== undefined && Number.isFinite(v));
      if (valid.length === 0) return { min: fallbackMin, max: fallbackMax };
      let minV = Math.min(...valid);
      let maxV = Math.max(...valid);
      const pad = Math.max(1.5, (maxV - minV) * 0.22);
      minV = Math.floor(minV - pad);
      maxV = Math.ceil(maxV + pad);
      if (maxV - minV < 4) maxV = minV + 4;
      return { min: minV, max: maxV };
    }

    updateTooltip(idx, width, _height, padLeft, plotW) {
      if (!this.tooltip || idx === null || !this.labels[idx]) {
        if (this.tooltip) this.tooltip.classList.add('hidden');
        return;
      }
      const xPos =
        this.labels.length === 1
          ? padLeft + plotW / 2
          : padLeft + (idx / (this.labels.length - 1)) * plotW;

      const v0 = this.datasets[0][idx];
      const v1 = this.datasets[1][idx];
      const s0 = this.series[0];
      const s1 = this.series[1];

      const f0 = v0 !== null && v0 !== undefined ? `${Number(v0).toFixed(s0.decimals ?? 1)}${s0.unit}` : 'FAULT';
      const f1 = v1 !== null && v1 !== undefined ? `${Number(v1).toFixed(s1.decimals ?? 1)}${s1.unit}` : 'FAULT';

      this.tooltip.innerHTML = `<div><strong>${escapeHtml(this.labels[idx])}</strong></div><div>${escapeHtml(s0.label)}: ${f0}</div><div>${escapeHtml(s1.label)}: ${f1}</div>`;
      this.tooltip.classList.remove('hidden');

      const clampedX = Math.max(75, Math.min(width - 75, xPos));
      this.tooltip.style.left = `${clampedX}px`;
      this.tooltip.style.top = `42px`;
    }

    draw() {
      if (!this.canvas) return;
      const rect = this.canvas.parentElement.getBoundingClientRect();
      const width = Math.max(260, rect.width);
      const height = Math.max(200, rect.height);
      const dpr = window.devicePixelRatio || 1;

      if (this.canvas.width !== Math.round(width * dpr) || this.canvas.height !== Math.round(height * dpr)) {
        this.canvas.width = Math.round(width * dpr);
        this.canvas.height = Math.round(height * dpr);
      }

      const ctx = this.canvas.getContext('2d');
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, height);

      const padLeft = 48;
      const padRight = this.dualAxis ? 46 : 20;
      const padTop = 16;
      const padBottom = 30;
      const plotW = width - padLeft - padRight;
      const plotH = height - padTop - padBottom;

      const leftScale = this.dualAxis
        ? this.computeScale(this.datasets[0], 10, 26, false)
        : this.computeScale([...this.datasets[0], ...this.datasets[1]], 0, 100, true);
      const rightScale = this.dualAxis
        ? this.computeScale(this.datasets[1], 25, 75, false)
        : leftScale;

      // Grid lines & Y-axis ticks
      const steps = 4;
      ctx.font = '500 11px "JetBrains Mono", monospace';
      ctx.textBaseline = 'middle';

      for (let i = 0; i <= steps; i++) {
        const ratio = i / steps;
        const y = padTop + plotH - ratio * plotH;

        ctx.strokeStyle = 'rgba(22, 40, 28, 0.08)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(padLeft + plotW, y);
        ctx.stroke();

        const lVal = leftScale.min + ratio * (leftScale.max - leftScale.min);
        ctx.fillStyle = this.series[0].color;
        ctx.textAlign = 'right';
        ctx.fillText(`${Math.round(lVal)}${this.series[0].unit}`, padLeft - 7, y);

        if (this.dualAxis) {
          const rVal = rightScale.min + ratio * (rightScale.max - rightScale.min);
          ctx.fillStyle = '#4e7a61';
          ctx.textAlign = 'left';
          ctx.fillText(`${Math.round(rVal)}${this.series[1].unit}`, padLeft + plotW + 7, y);
        }
      }

      if (this.labels.length === 0) {
        ctx.fillStyle = '#5d7062';
        ctx.textAlign = 'center';
        ctx.font = '500 13px "Plus Jakarta Sans", sans-serif';
        ctx.fillText('No telemetry samples in selected range', padLeft + plotW / 2, padTop + plotH / 2);
        ctx.restore();
        return;
      }

      // X-axis labels
      const maxXLabels = Math.min(this.labels.length, Math.max(3, Math.floor(plotW / 88)));
      const stride = Math.max(1, Math.ceil((this.labels.length - 1) / (maxXLabels - 1)));
      ctx.fillStyle = '#5d7062';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';

      for (let i = 0; i < this.labels.length; i += stride) {
        const x =
          this.labels.length === 1
            ? padLeft + plotW / 2
            : padLeft + (i / (this.labels.length - 1)) * plotW;
        ctx.fillText(this.labels[i], x, padTop + plotH + 8);
      }

      // Plot each dataset
      this.datasets.forEach((values, sIdx) => {
        const meta = this.series[sIdx];
        const scale = sIdx === 0 || !this.dualAxis ? leftScale : rightScale;
        const pts = [];

        values.forEach((v, idx) => {
          if (v === null || v === undefined || !Number.isFinite(v)) {
            pts.push(null);
            return;
          }
          const x =
            this.labels.length === 1
              ? padLeft + plotW / 2
              : padLeft + (idx / (this.labels.length - 1)) * plotW;
          const norm = (v - scale.min) / Math.max(0.001, scale.max - scale.min);
          const y = padTop + plotH - Math.max(0, Math.min(1, norm)) * plotH;
          pts.push({ x, y });
        });

        // Contiguous segments (respecting sensor fault gaps)
        const segments = [];
        let cur = [];
        pts.forEach((pt) => {
          if (pt) {
            cur.push(pt);
          } else if (cur.length > 0) {
            segments.push(cur);
            cur = [];
          }
        });
        if (cur.length > 0) segments.push(cur);

        segments.forEach((seg) => {
          if (meta.fillRgba && seg.length >= 2) {
            const grad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
            grad.addColorStop(0, meta.fillRgba);
            grad.addColorStop(1, 'rgba(255,255,255,0.0)');
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.moveTo(seg[0].x, padTop + plotH);
            seg.forEach((p, idx) => {
              if (meta.stepped && idx > 0) {
                ctx.lineTo(p.x, seg[idx - 1].y);
              }
              ctx.lineTo(p.x, p.y);
            });
            ctx.lineTo(seg[seg.length - 1].x, padTop + plotH);
            ctx.closePath();
            ctx.fill();
          }

          ctx.strokeStyle = meta.color;
          ctx.lineWidth = 2.2;
          ctx.lineJoin = 'round';
          ctx.beginPath();
          seg.forEach((p, idx) => {
            if (idx === 0) {
              ctx.moveTo(p.x, p.y);
            } else if (meta.stepped) {
              ctx.lineTo(p.x, seg[idx - 1].y);
              ctx.lineTo(p.x, p.y);
            } else {
              ctx.lineTo(p.x, p.y);
            }
          });
          ctx.stroke();

          seg.forEach((p) => {
            ctx.fillStyle = meta.color;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 2.3, 0, Math.PI * 2);
            ctx.fill();
          });
        });
      });

      // Crosshair hover guide
      if (this.hoverIndex !== null && this.labels[this.hoverIndex]) {
        const hx =
          this.labels.length === 1
            ? padLeft + plotW / 2
            : padLeft + (this.hoverIndex / (this.labels.length - 1)) * plotW;

        ctx.strokeStyle = 'rgba(22, 40, 28, 0.28)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(hx, padTop);
        ctx.lineTo(hx, padTop + plotH);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.restore();
    }
  }

  // ==========================================================================
  // 7. ESP32 FIRMWARE SKETCH GENERATOR & CSV DOWNLOADER
  // ==========================================================================
  function generateEsp32FirmwareSketch(deviceId) {
    const cfg = store.configs[deviceId] || store.configs['chamber-01'];
    const deviceRow = store.devices.find((d) => d.id === deviceId);
    const deviceKey = deviceRow && deviceRow.device_key ? deviceRow.device_key : 'chamber-01-local-secret-key';
    return `/**
 * ============================================================================
 * seed_chamber.ino — AgriSeed Monitor Autonomous ESP32 Controller
 * Generated for Device: ${deviceId}
 * ============================================================================
 * GPIO 4  : DHT22 temperature/humidity data pin (+ 4.7k-10k pull-up to 3.3V)
 * GPIO 25 : 25 kHz PWM Fan output -> MOSFET / 4-wire PWM fan control input
 * GPIO 26 : Cooling relay output  -> Opto-isolated SSR / contactor interface
 * GPIO 2  : Status LED (solid online, fast blink during DHT22 sensor fault)
 * GPIO 27 : Optional 3.3V open-collector fan tachometer input
 * ============================================================================
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <DHT.h>
#include <ArduinoJson.h>

const char* WIFI_SSID     = "YOUR_LOCAL_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_LOCAL_WIFI_PASSWORD";
const char* SERVER_BASE   = "http://192.168.1.5:3000";
const char* DEVICE_ID     = "${deviceId}";
const char* DEVICE_KEY    = ${JSON.stringify(deviceKey)};

constexpr uint8_t PIN_DHT        = 4;
constexpr uint8_t PIN_FAN_PWM    = 25;
constexpr uint8_t PIN_COOL_RELAY = 26;
constexpr uint8_t PIN_STATUS_LED = 2;
constexpr bool    HAS_TACHOMETER = false;

DHT dht(PIN_DHT, DHT22);

float targetTemp     = ${cfg.target_temp.toFixed(1)}f;
float tempMin        = ${cfg.temp_min.toFixed(1)}f;
float tempMax        = ${cfg.temp_max.toFixed(1)}f;
float coolingOnTemp  = ${cfg.cooling_on_temp.toFixed(1)}f;
float coolingOffTemp = ${cfg.cooling_off_temp.toFixed(1)}f;
uint8_t fanMinPct    = ${cfg.fan_min_percent};
uint8_t fanMaxPct    = ${cfg.fan_max_percent};

bool coolingRelayOn  = false;
uint32_t lastSwitchMs= 0;
float currentFanPct  = 30.0f;

void setup() {
  Serial.begin(115200);
  pinMode(PIN_COOL_RELAY, OUTPUT);
  digitalWrite(PIN_COOL_RELAY, LOW);
  pinMode(PIN_STATUS_LED, OUTPUT);
  dht.begin();
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void loop() {
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  uint32_t nowMs = millis();

  if (isnan(t) || isnan(h)) {
    digitalWrite(PIN_COOL_RELAY, LOW);
    coolingRelayOn = false;
    digitalWrite(PIN_STATUS_LED, ((nowMs / 250) % 2) ? HIGH : LOW);
  } else {
    digitalWrite(PIN_STATUS_LED, WiFi.status() == WL_CONNECTED ? HIGH : LOW);
    if (!coolingRelayOn && t >= coolingOnTemp && (nowMs - lastSwitchMs >= 180000UL)) {
      coolingRelayOn = true;
      lastSwitchMs = nowMs;
      digitalWrite(PIN_COOL_RELAY, HIGH);
    } else if (coolingRelayOn && t <= coolingOffTemp && (nowMs - lastSwitchMs >= 60000UL)) {
      coolingRelayOn = false;
      lastSwitchMs = nowMs;
      digitalWrite(PIN_COOL_RELAY, LOW);
    }
    float ratio = constrain((t - targetTemp) / max(0.5f, tempMax - targetTemp), 0.0f, 1.0f);
    currentFanPct = fanMinPct + ratio * (fanMaxPct - fanMinPct);
  }
  delay(2500);
}
`;
  }

  function triggerBlobDownload(filename, mimeType, content) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ==========================================================================
  // 8. UI STATE & VIEW CONTROLLERS
  // ==========================================================================
  let activeSection = 'overview';
  let controlModeDraft = 'auto';
  let formDirty = false;
  let historyRange = '24h';
  let historyPage = 1;
  let historyTotalPages = 1;
  let alertFilter = 'all';

  let liveChart = null;
  let historyClimateChart = null;
  let historyActuatorChart = null;

  function showNotice(message, kind = 'success') {
    const box = document.getElementById('globalNotice');
    if (!box) return;
    box.textContent = message;
    box.className = `feedback-banner ${kind}`;
    setTimeout(() => {
      if (box.textContent === message) {
        box.className = 'feedback-banner hidden';
      }
    }, 5500);
  }

  function startLiveClock() {
    const clockEl = document.getElementById('valLiveClock');
    const tick = () => {
      if (!clockEl) return;
      clockEl.textContent = new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    };
    tick();
    setInterval(tick, 1000);
  }

  function populateChamberDropdown() {
    const select = document.getElementById('sidebarChamberSelect');
    if (!select) return;
    const activeId = getSelectedDeviceId();
    select.innerHTML = store.devices
      .map(
        (d) =>
          `<option value="${escapeHtml(d.id)}" ${d.id === activeId ? 'selected' : ''}>${escapeHtml(d.device_name)} (${escapeHtml(d.id)})</option>`
      )
      .join('');
  }

  function activateSection(sectionName, scrollToAlerts = false) {
    const valid = ['overview', 'wifi', 'batches', 'guide', 'history'];
    activeSection = valid.includes(sectionName) ? sectionName : 'overview';

    document.querySelectorAll('.workspace-section').forEach((el) => {
      el.classList.toggle('hidden', el.id !== `section-${activeSection}`);
    });

    document.querySelectorAll('.nav-item-btn[data-section]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.section === activeSection);
    });

    const sidebar = document.getElementById('appSidebar');
    if (sidebar) sidebar.classList.remove('open');

    if (window.location.hash !== `#${activeSection}`) {
      history.replaceState(null, '', `#${activeSection}`);
    }

    refreshActiveViews();

    if (scrollToAlerts && activeSection === 'history') {
      const alertsEl = document.getElementById('alertsHistorySection');
      if (alertsEl) alertsEl.scrollIntoView({ behavior: 'smooth' });
    }
  }

  function updateRadialGauge(percentValue, centerText) {
    const arc = document.getElementById('rpmGaugeArc');
    const label = document.getElementById('rpmGaugeCenter');
    const circumference = 2 * Math.PI * 25;
    const clamped = Math.max(0, Math.min(100, Number(percentValue) || 0));
    const offset = circumference * (1 - clamped / 100);
    if (arc) arc.style.strokeDashoffset = offset.toFixed(2);
    if (label) label.textContent = centerText;
  }

  function syncControlFormFromConfig(config, activeBatch) {
    controlModeDraft = config.control_mode;
    updateControlModeUI();

    document.getElementById('sliderTargetTemp').value = config.target_temp;
    document.getElementById('readoutTargetTemp').textContent = `${config.target_temp.toFixed(1)}°C`;

    document.getElementById('inputTempMin').value = config.temp_min.toFixed(1);
    document.getElementById('inputTempMax').value = config.temp_max.toFixed(1);
    document.getElementById('inputCoolOff').value = config.cooling_off_temp.toFixed(1);
    document.getElementById('inputCoolOn').value = config.cooling_on_temp.toFixed(1);

    document.getElementById('inputFanMin').value = config.fan_min_percent;
    document.getElementById('inputFanMax').value = config.fan_max_percent;
    document.getElementById('inputManualFan').value = config.manual_fan_percent;

    const sliderFan = document.getElementById('sliderFanControl');
    const readoutFan = document.getElementById('readoutFanControl');
    if (controlModeDraft === 'manual') {
      sliderFan.value = config.manual_fan_percent;
      readoutFan.textContent = `${config.manual_fan_percent}%`;
    } else {
      sliderFan.value = config.fan_max_percent;
      readoutFan.textContent = `${config.fan_max_percent}%`;
    }

    const presetSelect = document.getElementById('presetSeedSelect');
    if (presetSelect && activeBatch && activeBatch.seed_profile_id) {
      presetSelect.value = String(activeBatch.seed_profile_id);
    }
  }

  function updateControlModeUI() {
    const autoBtn = document.getElementById('modeAutoBtn');
    const manualBtn = document.getElementById('modeManualBtn');
    const sliderLabel = document.getElementById('sliderFanLabel');
    const sliderFan = document.getElementById('sliderFanControl');
    const readoutFan = document.getElementById('readoutFanControl');
    const returnAutoBtn = document.getElementById('returnAutoBtn');

    const isManual = controlModeDraft === 'manual';
    autoBtn.className = `btn btn-sm ${!isManual ? 'btn-primary' : 'btn-secondary'}`;
    manualBtn.className = `btn btn-sm ${isManual ? 'btn-primary' : 'btn-secondary'}`;

    if (isManual) {
      sliderLabel.textContent = 'Manual Fan Speed (%)';
      const val = document.getElementById('inputManualFan').value || 45;
      sliderFan.value = val;
      readoutFan.textContent = `${val}%`;
      returnAutoBtn.classList.remove('hidden');
    } else {
      sliderLabel.textContent = 'Max Circulation Fan (%)';
      const val = document.getElementById('inputFanMax').value || 85;
      sliderFan.value = val;
      readoutFan.textContent = `${val}%`;
      returnAutoBtn.classList.add('hidden');
    }
  }

  function renderOverviewAndStatus() {
    const deviceId = getSelectedDeviceId();
    const device = store.devices.find((d) => d.id === deviceId) || store.devices[0];
    const config = store.configs[device.id];
    const activeBatch = getActiveBatchForDevice(device.id);
    const connectivity = computeDeviceConnectivity(device);
    const reconciliation = isConfigAcknowledged(config, device);

    const deviceReadings = store.readings.filter((r) => r.device_id === device.id);
    const latestReading = deviceReadings.length > 0 ? deviceReadings[deviceReadings.length - 1] : null;

    const rhMin = activeBatch ? activeBatch.rh_min : 35.0;
    const rhMax = activeBatch ? activeBatch.rh_max : 55.0;

    const vs = computeVisualChamberStatus({
      isOnline: connectivity.is_online,
      isStale: connectivity.is_stale,
      latestReading,
      config,
      rhMin,
      rhMax,
      configSynced: reconciliation.synced
    });

    // 1. Top Status Strip
    const strip = document.getElementById('chamberStatusStrip');
    const glyphMap = { green: '●', amber: '▲', red: '✖', grey: '○' };
    strip.className = `status-strip ${vs.level}`;
    document.getElementById('statusTitle').textContent = `${glyphMap[vs.level] || '○'} ${vs.label}`;
    document.getElementById('statusDetail').textContent = vs.detail;

    const simSummary = document.getElementById('simQuickSummary');
    const quickSimBtn = document.getElementById('quickSimToggleBtn');
    if (device.id === 'chamber-01') {
      const st = simulator.getStatus();
      simSummary.textContent = st.running ? `Sim Active (${st.mode})` : 'Sim Paused';
      quickSimBtn.textContent = st.running ? 'Sim Settings' : 'Start Sim';
      quickSimBtn.classList.remove('hidden');
    } else {
      simSummary.textContent = 'External ESP32 Chamber';
      quickSimBtn.classList.add('hidden');
    }

    // 2. Freshness & Stale Dimming
    const ageLabel = formatRelativeAge(connectivity.seconds_since_seen);
    document.getElementById('deviceFreshnessText').textContent = connectivity.is_online
      ? `${device.id} Online · Last reading ${ageLabel}`
      : `${device.id} Offline / Stale · Last seen ${ageLabel}`;

    ['cellTemp', 'cellHumidity', 'cellFan'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('stale-dim', connectivity.is_stale);
    });

    // 3. Live Metric Cells
    const valTemp = document.getElementById('valTemp');
    const subTemp = document.getElementById('subTemp');
    const valHumidity = document.getElementById('valHumidity');
    const subHumidity = document.getElementById('subHumidity');
    const valFanPrimary = document.getElementById('valFanPrimary');
    const subFan = document.getElementById('subFan');
    const subBatchClock = document.getElementById('subBatchClock');

    if (!latestReading) {
      valTemp.textContent = '—';
      valTemp.className = 'metric-value';
      subTemp.textContent = `Allowed ${config.temp_min.toFixed(1)}–${config.temp_max.toFixed(1)}°C · Target ${config.target_temp.toFixed(1)}°C`;

      valHumidity.textContent = '—';
      valHumidity.className = 'metric-value';
      subHumidity.textContent = `Allowed ${rhMin.toFixed(0)}–${rhMax.toFixed(0)}% RH`;

      valFanPrimary.textContent = '—';
      subFan.textContent = 'Waiting for telemetry';
      updateRadialGauge(0, '—');
    } else if (!latestReading.sensor_ok || latestReading.temp === null || latestReading.humidity === null) {
      valTemp.textContent = 'Sensor Fault';
      valTemp.className = 'metric-value fault';
      subTemp.textContent = 'Fallback Active · Cooling OFF · Verify DHT22';

      valHumidity.textContent = 'Sensor Fault';
      valHumidity.className = 'metric-value fault';
      subHumidity.textContent = `Allowed ${rhMin.toFixed(0)}–${rhMax.toFixed(0)}% RH`;

      valFanPrimary.textContent = `${latestReading.fan_speed_percent.toFixed(0)}% PWM`;
      subFan.textContent =
        latestReading.fan_rpm !== null
          ? `Fallback circulation · ${latestReading.fan_rpm} Sim RPM`
          : 'Fallback circulation · RPM Unavailable';
      updateRadialGauge(latestReading.fan_speed_percent, `${latestReading.fan_speed_percent.toFixed(0)}%`);
    } else {
      const stalePrefix = connectivity.is_stale ? 'Stale ' : '';
      valTemp.className = 'metric-value';
      valTemp.textContent = `${stalePrefix}${latestReading.temp.toFixed(1)}°C`;
      subTemp.textContent = `Allowed ${config.temp_min.toFixed(1)}–${config.temp_max.toFixed(1)}°C · Target ${config.target_temp.toFixed(1)}°C · ${latestReading.cooling_on ? 'Cooling ON' : 'Cooling Standby'}`;

      valHumidity.className = 'metric-value';
      valHumidity.textContent = `${stalePrefix}${latestReading.humidity.toFixed(1)}%`;
      subHumidity.textContent = `Allowed ${rhMin.toFixed(0)}–${rhMax.toFixed(0)}% RH · ${latestReading.is_simulated ? 'Simulated DHT22' : 'Hardware DHT22'}`;

      if (latestReading.fan_rpm !== null && latestReading.fan_rpm !== undefined) {
        valFanPrimary.textContent = `${latestReading.fan_rpm} RPM`;
        subFan.textContent = `Commanded: ${latestReading.fan_speed_percent.toFixed(0)}% (${config.control_mode === 'manual' ? 'Manual' : 'Auto'}) · ${latestReading.is_simulated ? 'Simulated RPM' : 'Measured RPM'}`;
        updateRadialGauge(latestReading.fan_speed_percent, 'RPM');
      } else {
        valFanPrimary.textContent = `${latestReading.fan_speed_percent.toFixed(0)}% PWM`;
        subFan.textContent = `Commanded: ${latestReading.fan_speed_percent.toFixed(0)}% (${config.control_mode === 'manual' ? 'Manual' : 'Auto'}) · Measured RPM Unavailable`;
        updateRadialGauge(latestReading.fan_speed_percent, `${latestReading.fan_speed_percent.toFixed(0)}%`);
      }
    }

    if (activeBatch) {
      subBatchClock.textContent = `${activeBatch.seed_name} (${activeBatch.label}) · ${activeBatch.days_stored}d stored · ${activeBatch.days_remaining}d remaining`;
      document.getElementById('activeBatchHorizonBox').textContent =
        `${activeBatch.days_stored}d stored / ${activeBatch.days_remaining}d left`;
    } else {
      subBatchClock.textContent = 'No active seed batch — start one in Seed Selection';
      document.getElementById('activeBatchHorizonBox').textContent = 'No active batch';
    }

    // 4. Control Form & Reconciliation Bar
    if (!formDirty) {
      syncControlFormFromConfig(config, activeBatch);
    }

    const syncEl = document.getElementById('configSyncText');
    const expiryEl = document.getElementById('manualExpiryNote');
    if (reconciliation.synced) {
      syncEl.textContent = `Requested v${config.config_version} · Acknowledged by ESP32`;
      syncEl.className = 'meta-line tabular sync-status-line ok';
    } else {
      const ackVer = reconciliation.acknowledged ? `v${reconciliation.acknowledged.config_version || '?'}` : 'none';
      syncEl.textContent = `Requested v${config.config_version} · Pending ESP32 Sync (Device at ${ackVer})`;
      syncEl.className = 'meta-line tabular sync-status-line pending';
    }

    if (config.control_mode === 'manual' && config.manual_expires_at) {
      const minsLeft = Math.max(0, Math.ceil((Date.parse(config.manual_expires_at) - Date.now()) / 60_000));
      expiryEl.textContent = `Manual fan override (${config.manual_fan_percent}%) auto-returns to Automatic in ${minsLeft} min`;
    } else {
      expiryEl.textContent = `Auto cooling hysteresis (${config.cooling_off_temp.toFixed(1)}–${config.cooling_on_temp.toFixed(1)}°C) + ramped PWM fan (${config.fan_min_percent}–${config.fan_max_percent}%)`;
    }

    // 5. Active Unacknowledged Alerts
    const unacked = store.alerts.filter((a) => a.device_id === device.id && !a.acknowledged);
    const alertsPanel = document.getElementById('activeAlertsPanel');
    const alertsList = document.getElementById('activeAlertsList');
    if (unacked.length === 0) {
      alertsPanel.classList.add('hidden');
      alertsList.innerHTML = '';
    } else {
      alertsPanel.classList.remove('hidden');
      alertsList.innerHTML = unacked
        .slice(0, 8)
        .map((a) => {
          const dt = formatDateParts(a.created_at);
          const isCrit = ['high_temp', 'low_temp', 'sensor_failure'].includes(a.kind);
          const rec = a.resolved_at ? ` · Recovered at ${formatDateParts(a.resolved_at).time}` : ' · Active condition';
          return `
            <div class="alert-row ${isCrit ? 'critical' : ''}">
              <div>
                <div class="alert-row-title">${escapeHtml(a.message)}</div>
                <div class="alert-row-meta tabular">${escapeHtml(a.kind.replace(/_/g, ' '))} · ${dt.full}${rec}</div>
              </div>
              <button type="button" class="btn btn-secondary btn-sm ack-alert-btn" data-alert-id="${a.id}">
                Acknowledge
              </button>
            </div>
          `;
        })
        .join('');

      alertsList.querySelectorAll('.ack-alert-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          acknowledgeAlertById(Number(btn.dataset.alertId));
        });
      });
    }

    // 6. Real-Time Graph (Last 36 points)
    if (activeSection === 'overview' && liveChart) {
      const pts = deviceReadings.slice(-36);
      liveChart.setData(
        pts.map((p) => formatDateParts(p.created_at).time),
        pts.map((p) => (p.sensor_ok ? p.temp : null)),
        pts.map((p) => (p.sensor_ok ? p.humidity : null))
      );
    }

    // 7. Recent Storage Logs (Last 10 rows)
    const tbody = document.getElementById('recentLogsBody');
    const recent10 = [...deviceReadings].reverse().slice(0, 10);
    if (recent10.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" class="empty-table-cell">No sensor readings recorded for ${escapeHtml(device.id)} yet.</td></tr>`;
    } else {
      tbody.innerHTML = recent10
        .map((row) => {
          const dt = formatDateParts(row.created_at);
          const batchObj = store.batches.find((b) => b.id === row.batch_id);
          const seedName = batchObj ? getSeedProfileById(batchObj.seed_profile_id).name : 'Unassigned';
          return `
            <tr>
              <td>${dt.date}</td>
              <td>${dt.time}</td>
              <td>${escapeHtml(seedName)}</td>
              <td class="num">${row.sensor_ok && row.temp !== null ? row.temp.toFixed(1) : 'FAULT'}</td>
              <td class="num">${row.sensor_ok && row.humidity !== null ? row.humidity.toFixed(1) : 'FAULT'}</td>
              <td class="num">${row.fan_speed_percent.toFixed(0)}%</td>
              <td class="num">${row.fan_rpm !== null ? row.fan_rpm : 'Unavailable'}</td>
              <td>${row.cooling_on ? 'ON' : 'Standby'}</td>
              <td>${row.is_simulated ? 'Simulated' : 'ESP32'}</td>
            </tr>
          `;
        })
        .join('');
    }
  }

  function renderWifiSection() {
    const deviceId = getSelectedDeviceId();
    const device = store.devices.find((d) => d.id === deviceId) || store.devices[0];
    const config = store.configs[device.id];
    const reconciliation = isConfigAcknowledged(config, device);

    document.getElementById('detectedLanUrl').textContent = window.location.origin;

    document.getElementById('requestedConfigPre').textContent = JSON.stringify(
      {
        config_version: config.config_version,
        target_temp: config.target_temp,
        temp_min: config.temp_min,
        temp_max: config.temp_max,
        cooling_on_temp: config.cooling_on_temp,
        cooling_off_temp: config.cooling_off_temp,
        fan_min_percent: config.fan_min_percent,
        fan_max_percent: config.fan_max_percent,
        control_mode: config.control_mode,
        manual_fan_percent: config.manual_fan_percent
      },
      null,
      2
    );

    document.getElementById('ackConfigPre').textContent = reconciliation.acknowledged
      ? JSON.stringify(reconciliation.acknowledged, null, 2)
      : 'No configuration acknowledgement received from this chamber yet.';

    const st = simulator.getStatus();
    document.getElementById('simStateLabel').textContent = st.running
      ? `Running on ${st.device_id} · Tick #${st.tick_count}`
      : `Paused on ${st.device_id}`;

    const simSelect = document.getElementById('simScenarioSelect');
    if (document.activeElement !== simSelect) {
      simSelect.value = st.mode;
    }
  }

  function renderBatchesSection() {
    const deviceId = getSelectedDeviceId();
    document.getElementById('activeBatchChamberTag').textContent = `Chamber: ${deviceId}`;

    const activeBatch = getActiveBatchForDevice(deviceId);
    const activeBox = document.getElementById('activeBatchContainer');

    if (activeBatch) {
      const pct = Math.min(100, Math.round((activeBatch.days_stored / activeBatch.planned_days) * 100));
      activeBox.innerHTML = `
        <div class="batch-summary-header">
          <div>
            <div class="batch-summary-title">
              ${escapeHtml(activeBatch.label)} · ${escapeHtml(activeBatch.seed_name)}
            </div>
            <div class="meta-line tabular">
              Quantity: ${activeBatch.quantity_kg} kg · Started: ${formatDateParts(activeBatch.started_at).full} (local time) · Envelope: ${activeBatch.temp_min}–${activeBatch.temp_max}°C, ${activeBatch.rh_min}–${activeBatch.rh_max}% RH
            </div>
            <div class="meta-line tabular batch-summary-horizon">
              ${activeBatch.days_stored} Days Stored · ${activeBatch.days_remaining} Days Remaining (of ${activeBatch.planned_days} planned days)
            </div>
          </div>
          <button type="button" id="closeActiveBatchBtn" class="btn btn-danger btn-sm">
            Close Active Batch
          </button>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width: ${pct}%;"></div>
        </div>
      `;

      document.getElementById('closeActiveBatchBtn').addEventListener('click', () => {
        const target = store.batches.find((b) => b.id === activeBatch.id);
        if (target) {
          target.status = 'closed';
          target.closed_at = nowUtc();
          saveStore(store);
          showNotice(`Closed batch "${target.label}".`, 'success');
          refreshActiveViews();
        }
      });
    } else {
      activeBox.innerHTML = `<p class="meta-line">No active batch in <strong>${escapeHtml(deviceId)}</strong>. Use the form below to start tracking a new seed batch.</p>`;
    }

    const sortedBatches = [...store.batches].sort((a, b) => {
      if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
      return b.started_at.localeCompare(a.started_at);
    });

    const tbody = document.getElementById('batchesTableBody');
    if (sortedBatches.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty-table-cell">No batches created yet.</td></tr>`;
    } else {
      tbody.innerHTML = sortedBatches
        .map((b) => {
          const prof = getSeedProfileById(b.seed_profile_id);
          const metrics = computeBatchDayMetrics(
            b.started_at,
            b.planned_days,
            b.closed_at ? Date.parse(b.closed_at) : Date.now()
          );
          return `
            <tr>
              <td>${escapeHtml(b.label)}</td>
              <td>${escapeHtml(prof.name)}</td>
              <td>${escapeHtml(b.device_id)}</td>
              <td class="num">${b.quantity_kg}</td>
              <td>${formatDateParts(b.started_at).date}</td>
              <td class="num">${metrics.days_stored}</td>
              <td class="num">${b.status === 'active' ? metrics.days_remaining : '—'}</td>
              <td>${b.status === 'active' ? 'Active' : 'Closed'}</td>
            </tr>
          `;
        })
        .join('');
    }
  }

  function renderHistorySection() {
    const deviceId = getSelectedDeviceId();
    const hoursMap = { '24h': 24, '7d': 168, '30d': 720 };
    const bucketSecMap = { '24h': 300, '7d': 1800, '30d': 7200 };
    const hours = hoursMap[historyRange] || 24;
    const bucketMs = (bucketSecMap[historyRange] || 300) * 1000;
    const sinceIso = new Date(Date.now() - hours * 3600_000).toISOString();

    const filteredAsc = store.readings.filter(
      (r) => r.device_id === deviceId && r.created_at >= sinceIso
    );

    const validTemps = filteredAsc.filter((r) => r.sensor_ok && r.temp !== null).map((r) => r.temp);
    const validRhs = filteredAsc.filter((r) => r.sensor_ok && r.humidity !== null).map((r) => r.humidity);
    const avg = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);

    const tAvg = avg(validTemps);
    const hAvg = avg(validRhs);
    const fAvg = avg(filteredAsc.map((r) => r.fan_speed_percent));
    const cDuty = avg(filteredAsc.map((r) => (r.cooling_on ? 100 : 0)));

    document.getElementById('statSamples').textContent = String(filteredAsc.length);
    document.getElementById('statTempSummary').textContent =
      tAvg !== null
        ? `${Math.min(...validTemps).toFixed(1)} / ${tAvg.toFixed(1)} / ${Math.max(...validTemps).toFixed(1)} °C`
        : '—';
    document.getElementById('statRhSummary').textContent =
      hAvg !== null
        ? `${Math.min(...validRhs).toFixed(0)} / ${hAvg.toFixed(0)} / ${Math.max(...validRhs).toFixed(0)} %`
        : '—';
    document.getElementById('statFanCoolSummary').textContent =
      fAvg !== null ? `${fAvg.toFixed(0)}% Fan · ${cDuty.toFixed(0)}% Cool` : '—';

    // Downsample chart series if > 100 samples
    let chartPts = [];
    if (filteredAsc.length <= 100) {
      chartPts = filteredAsc.map((r) => ({
        time: r.created_at,
        temp: r.sensor_ok ? r.temp : null,
        rh: r.sensor_ok ? r.humidity : null,
        fan: r.fan_speed_percent,
        cool: r.cooling_on ? 100 : 0
      }));
    } else {
      const buckets = new Map();
      filteredAsc.forEach((r) => {
        const key = Math.floor(Date.parse(r.created_at) / bucketMs);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(r);
      });
      for (const group of buckets.values()) {
        const gTemps = group.filter((x) => x.sensor_ok && x.temp !== null).map((x) => x.temp);
        const gRhs = group.filter((x) => x.sensor_ok && x.humidity !== null).map((x) => x.humidity);
        chartPts.push({
          time: group[0].created_at,
          temp: avg(gTemps),
          rh: avg(gRhs),
          fan: avg(group.map((x) => x.fan_speed_percent)),
          cool: avg(group.map((x) => (x.cooling_on ? 100 : 0)))
        });
      }
    }

    const labels = chartPts.map((p) => {
      const dt = formatDateParts(p.time);
      return historyRange === '24h' ? dt.time : `${dt.date.slice(5)} ${dt.time.slice(0, 5)}`;
    });

    if (historyClimateChart) {
      historyClimateChart.setData(
        labels,
        chartPts.map((p) => p.temp),
        chartPts.map((p) => p.rh)
      );
    }
    if (historyActuatorChart) {
      historyActuatorChart.setData(
        labels,
        chartPts.map((p) => p.fan),
        chartPts.map((p) => p.cool)
      );
    }

    // Strictly 50 rows per page pagination
    const pageSize = 50;
    const totalRows = filteredAsc.length;
    historyTotalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    if (historyPage > historyTotalPages) historyPage = historyTotalPages;

    const descRows = [...filteredAsc].reverse();
    const pageRows = descRows.slice((historyPage - 1) * pageSize, historyPage * pageSize);

    document.getElementById('paginationInfoTop').textContent =
      `Page ${historyPage} of ${historyTotalPages} (50 rows/page)`;
    document.getElementById('paginationSummary').textContent =
      `Total ${totalRows} reading(s) in ${historyRange.toUpperCase()} window`;

    document.getElementById('prevPageBtn').disabled = historyPage <= 1;
    document.getElementById('nextPageBtn').disabled = historyPage >= historyTotalPages;

    const tbody = document.getElementById('historyTableBody');
    if (pageRows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="10" class="empty-table-cell">No readings found in the selected time range.</td></tr>`;
    } else {
      tbody.innerHTML = pageRows
        .map((r) => {
          const dt = formatDateParts(r.created_at);
          const b = store.batches.find((x) => x.id === r.batch_id);
          const sName = b ? getSeedProfileById(b.seed_profile_id).name : 'Unassigned';
          const bLabel = b ? b.label : '—';
          return `
            <tr>
              <td>${dt.date}</td>
              <td>${dt.time}</td>
              <td>${escapeHtml(sName)} (${escapeHtml(bLabel)})</td>
              <td class="num">${r.sensor_ok && r.temp !== null ? r.temp.toFixed(2) : '—'}</td>
              <td class="num">${r.sensor_ok && r.humidity !== null ? r.humidity.toFixed(1) : '—'}</td>
              <td class="num">${r.fan_speed_percent.toFixed(0)}%</td>
              <td class="num">${r.fan_rpm !== null ? r.fan_rpm : 'Unavailable'}</td>
              <td>${r.cooling_on ? 'ON' : 'OFF'}</td>
              <td>${r.sensor_ok ? 'OK' : 'FAULT'}</td>
              <td>${r.is_simulated ? 'Simulated' : 'ESP32'}</td>
            </tr>
          `;
        })
        .join('');
    }

    // Alerts Table
    const alertsBody = document.getElementById('alertsHistoryBody');
    const alertsFiltered = store.alerts.filter(
      (a) => a.device_id === deviceId && (alertFilter === 'all' || !a.acknowledged)
    );
    if (alertsFiltered.length === 0) {
      alertsBody.innerHTML = `<tr><td colspan="6" class="empty-table-cell">No alerts recorded for this filter.</td></tr>`;
    } else {
      alertsBody.innerHTML = alertsFiltered
        .map((a) => {
          const created = formatDateParts(a.created_at).full;
          const recovery = a.resolved_at
            ? `Recovered ${formatDateParts(a.resolved_at).full}`
            : 'Active / Unresolved';
          const actionHtml = a.acknowledged
            ? 'Acknowledged'
            : `<button type="button" class="btn btn-secondary btn-sm ack-hist-btn" data-id="${a.id}">Acknowledge</button>`;
          return `
            <tr>
              <td>${created}</td>
              <td>${escapeHtml(a.device_id)}</td>
              <td>${escapeHtml(a.kind)}</td>
              <td class="wrap-cell">${escapeHtml(a.message)}</td>
              <td>${recovery}</td>
              <td>${actionHtml}</td>
            </tr>
          `;
        })
        .join('');

      alertsBody.querySelectorAll('.ack-hist-btn').forEach((btn) => {
        btn.addEventListener('click', () => acknowledgeAlertById(Number(btn.dataset.id)));
      });
    }
  }

  function acknowledgeAlertById(alertId) {
    const row = store.alerts.find((a) => a.id === alertId);
    if (!row) return;
    row.acknowledged = 1;
    row.acknowledged_at = nowUtc();
    saveStore(store);
    refreshActiveViews();
  }

  function populateSeedProfilesUI() {
    const presetSelect = document.getElementById('presetSeedSelect');
    const batchSelect = document.getElementById('batchSeedProfile');
    const guideGrid = document.getElementById('seedGuideGrid');

    presetSelect.innerHTML = STARTER_SEED_PROFILES.map(
      (p) =>
        `<option value="${p.id}">${escapeHtml(p.name)} (${p.temp_min}–${p.temp_max}°C · ${p.rh_min}–${p.rh_max}% RH)</option>`
    ).join('');

    batchSelect.innerHTML = STARTER_SEED_PROFILES.map(
      (p) =>
        `<option value="${p.id}">${escapeHtml(p.name)} — ${p.shelf_days} days (${p.temp_min}–${p.temp_max}°C)</option>`
    ).join('');

    batchSelect.addEventListener('change', () => {
      const chosen = getSeedProfileById(batchSelect.value);
      if (chosen) document.getElementById('batchPlannedDays').value = chosen.shelf_days;
    });

    guideGrid.innerHTML = STARTER_SEED_PROFILES.map(
      (p) => `
        <article class="seed-item">
          <div>
            <h3 class="seed-item-title">${escapeHtml(p.name)}</h3>
            <div class="seed-item-envelope">
              ${p.temp_min}–${p.temp_max}°C · ${p.rh_min}–${p.rh_max}% RH · ${p.shelf_days} Days
            </div>
            <p class="seed-item-notes">${escapeHtml(p.notes)}</p>
          </div>
          <button type="button" class="btn btn-secondary btn-sm use-profile-btn" data-profile-id="${p.id}">
            Select for New Batch
          </button>
        </article>
      `
    ).join('');

    guideGrid.querySelectorAll('.use-profile-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const chosen = getSeedProfileById(btn.dataset.profileId);
        batchSelect.value = String(chosen.id);
        document.getElementById('batchPlannedDays').value = chosen.shelf_days;
        activateSection('batches');
      });
    });
  }

  function refreshActiveViews() {
    renderOverviewAndStatus();
    if (activeSection === 'wifi') renderWifiSection();
    if (activeSection === 'batches') renderBatchesSection();
    if (activeSection === 'history') renderHistorySection();
  }

  // ==========================================================================
  // 9. EVENT LISTENERS & INITIALIZATION
  // ==========================================================================
  function bindAllEvents() {
    // Mobile sidebar toggle
    const mobileBtn = document.getElementById('mobileMenuBtn');
    const sidebar = document.getElementById('appSidebar');
    mobileBtn.addEventListener('click', () => {
      const isOpen = sidebar.classList.toggle('open');
      mobileBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });

    // Sidebar Navigation
    document.querySelectorAll('.nav-item-btn[data-section]').forEach((btn) => {
      btn.addEventListener('click', () => activateSection(btn.dataset.section));
    });

    // Quick jumps
    document.getElementById('manageBatchJumpBtn').addEventListener('click', () => activateSection('batches'));
    document.getElementById('jumpToHistoryBtn').addEventListener('click', () => activateSection('history'));
    document.getElementById('viewAllAlertsJumpBtn').addEventListener('click', () => activateSection('history', true));
    document.getElementById('quickSimToggleBtn').addEventListener('click', () => {
      if (!simulator.running) {
        simulator.start();
        showNotice('Started built-in ESP32 chamber simulator.', 'success');
        refreshActiveViews();
      } else {
        activateSection('wifi');
      }
    });

    // Chamber selector
    document.getElementById('sidebarChamberSelect').addEventListener('change', (e) => {
      setSelectedDeviceId(e.target.value);
      formDirty = false;
      historyPage = 1;
      refreshActiveViews();
    });

    // Reset Demo State
    document.getElementById('resetDemoDataBtn').addEventListener('click', () => {
      store = createInitialStoreState();
      saveStore(store);
      setSelectedDeviceId('chamber-01');
      populateChamberDropdown();
      simulator.setMode('normal');
      if (!simulator.running) simulator.start();
      formDirty = false;
      historyPage = 1;
      showNotice('Chamber state, batches, and 24h telemetry restored to clean defaults.', 'success');
      refreshActiveViews();
    });

    // Control Panel Form
    const form = document.getElementById('controlForm');
    const sliderTemp = document.getElementById('sliderTargetTemp');
    const readoutTemp = document.getElementById('readoutTargetTemp');
    const sliderFan = document.getElementById('sliderFanControl');
    const readoutFan = document.getElementById('readoutFanControl');
    const presetSelect = document.getElementById('presetSeedSelect');

    form.addEventListener('input', () => {
      formDirty = true;
    });

    sliderTemp.addEventListener('input', () => {
      const t = Number(sliderTemp.value);
      readoutTemp.textContent = `${t.toFixed(1)}°C`;
      document.getElementById('inputCoolOff').value = (t - 0.7).toFixed(1);
      document.getElementById('inputCoolOn').value = (t + 0.7).toFixed(1);
    });

    sliderFan.addEventListener('input', () => {
      const pct = Number(sliderFan.value);
      readoutFan.textContent = `${pct}%`;
      if (controlModeDraft === 'manual') {
        document.getElementById('inputManualFan').value = pct;
      } else {
        document.getElementById('inputFanMax').value = pct;
      }
    });

    presetSelect.addEventListener('change', () => {
      formDirty = true;
      const chosen = getSeedProfileById(presetSelect.value);
      const mid = Number(((chosen.temp_min + chosen.temp_max) / 2).toFixed(1));
      sliderTemp.value = mid;
      readoutTemp.textContent = `${mid.toFixed(1)}°C`;
      document.getElementById('inputTempMin').value = chosen.temp_min.toFixed(1);
      document.getElementById('inputTempMax').value = chosen.temp_max.toFixed(1);
      const half = Math.max(0.4, Math.min(0.8, Number(((chosen.temp_max - chosen.temp_min) * 0.2).toFixed(1))));
      document.getElementById('inputCoolOff').value = (mid - half).toFixed(1);
      document.getElementById('inputCoolOn').value = (mid + half).toFixed(1);
    });

    document.getElementById('modeAutoBtn').addEventListener('click', () => {
      formDirty = true;
      controlModeDraft = 'auto';
      updateControlModeUI();
    });

    document.getElementById('modeManualBtn').addEventListener('click', () => {
      formDirty = true;
      controlModeDraft = 'manual';
      updateControlModeUI();
    });

    document.getElementById('returnAutoBtn').addEventListener('click', () => {
      const cfg = store.configs[getSelectedDeviceId()];
      if (!cfg) return;
      cfg.control_mode = 'auto';
      cfg.manual_expires_at = null;
      cfg.config_version += 1;
      cfg.updated_at = nowUtc();
      formDirty = false;
      saveStore(store);
      showNotice('Returned chamber fan control to Automatic mode.', 'success');
      refreshActiveViews();
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const deviceId = getSelectedDeviceId();
      const currentCfg = store.configs[deviceId];

      const validation = validateControlConfig(
        {
          target_temp: Number(sliderTemp.value),
          temp_min: Number(document.getElementById('inputTempMin').value),
          temp_max: Number(document.getElementById('inputTempMax').value),
          cooling_off_temp: Number(document.getElementById('inputCoolOff').value),
          cooling_on_temp: Number(document.getElementById('inputCoolOn').value),
          fan_min_percent: Number(document.getElementById('inputFanMin').value),
          fan_max_percent: Number(document.getElementById('inputFanMax').value),
          manual_fan_percent: Number(document.getElementById('inputManualFan').value),
          manual_timeout_minutes: Number(document.getElementById('inputManualTimeout').value),
          control_mode: controlModeDraft
        },
        currentCfg
      );

      if (!validation.valid) {
        showNotice(validation.errors[0], 'error');
        return;
      }

      store.configs[deviceId] = {
        ...currentCfg,
        ...validation.value,
        config_version: currentCfg.config_version + 1,
        updated_at: nowUtc()
      };
      formDirty = false;
      saveStore(store);
      showNotice('Control configuration saved. Simulator/ESP32 will acknowledge on next poll.', 'success');
      refreshActiveViews();
    });

    // Simulator Controls
    document.getElementById('simStartBtn').addEventListener('click', () => {
      simulator.setMode(document.getElementById('simScenarioSelect').value);
      simulator.start();
      showNotice('Simulator running (5s telemetry interval).', 'success');
      refreshActiveViews();
    });

    document.getElementById('simStopBtn').addEventListener('click', () => {
      simulator.stop();
      showNotice('Simulator paused.', 'warning');
      refreshActiveViews();
    });

    document.getElementById('simStepBtn').addEventListener('click', () => {
      simulator.setMode(document.getElementById('simScenarioSelect').value);
      simulator.step();
    });

    document.getElementById('simScenarioSelect').addEventListener('change', (e) => {
      simulator.setMode(e.target.value);
      if (simulator.running) simulator.step();
      else refreshActiveViews();
    });

    // Download ESP32 Sketch
    document.getElementById('downloadFirmwareBtn').addEventListener('click', () => {
      const devId = getSelectedDeviceId();
      const code = generateEsp32FirmwareSketch(devId);
      triggerBlobDownload('seed_chamber.ino', 'text/x-arduino;charset=utf-8', code);
      showNotice(`Downloaded seed_chamber.ino preconfigured for ${devId}.`, 'success');
    });

    // Register Additional Chamber
    document.getElementById('registerDeviceForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const rawId = document.getElementById('newDeviceId').value.trim().toLowerCase();
      const rawName = document.getElementById('newDeviceName').value.trim();
      const rawKey = document.getElementById('newDeviceKey').value.trim();

      if (!/^[a-z0-9][a-z0-9-_]{2,31}$/.test(rawId)) {
        showNotice('Device ID must be 3–32 lowercase letters, numbers, hyphens, or underscores.', 'error');
        return;
      }
      if (rawName.length < 2 || rawName.length > 60) {
        showNotice('Chamber name must be between 2 and 60 characters.', 'error');
        return;
      }
      if (rawKey.length < 8) {
        showNotice('Shared Device Key must be at least 8 characters.', 'error');
        return;
      }
      if (store.devices.some((d) => d.id === rawId)) {
        showNotice(`Device "${rawId}" is already registered.`, 'error');
        return;
      }

      const now = nowUtc();
      store.devices.push({
        id: rawId,
        device_name: rawName,
        device_key: rawKey,
        status: 'offline',
        last_seen_at: null,
        acknowledged_config: null,
        last_ack_at: null,
        diagnostics: null,
        created_at: now
      });
      store.configs[rawId] = {
        device_id: rawId,
        target_temp: 17.5,
        temp_min: 15.0,
        temp_max: 20.0,
        cooling_on_temp: 18.2,
        cooling_off_temp: 16.8,
        fan_min_percent: 25,
        fan_max_percent: 85,
        manual_fan_percent: 45,
        control_mode: 'auto',
        manual_expires_at: null,
        config_version: 1,
        updated_at: now
      };
      saveStore(store);

      document.getElementById('newDeviceId').value = '';
      document.getElementById('newDeviceName').value = '';
      document.getElementById('newDeviceKey').value = '';
      populateChamberDropdown();
      showNotice(`Registered chamber "${rawId}".`, 'success');
    });

    // Create Seed Batch
    document.getElementById('createBatchForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const deviceId = getSelectedDeviceId();
      const existing = getActiveBatchForDevice(deviceId);
      if (existing) {
        showNotice(
          `Chamber ${deviceId} already has an active batch ("${existing.label}"). Close it before starting a new batch.`,
          'error'
        );
        return;
      }

      const profile = getSeedProfileById(document.getElementById('batchSeedProfile').value);
      const label = document.getElementById('batchLabel').value.trim();
      const qty = Number(document.getElementById('batchQty').value);
      const plannedDays = Math.round(Number(document.getElementById('batchPlannedDays').value));
      const applyTemps = document.getElementById('batchApplyTemps').checked;

      if (label.length < 2 || label.length > 80) {
        showNotice('Batch label must be between 2 and 80 characters.', 'error');
        return;
      }
      if (!Number.isFinite(qty) || qty < 0.5 || qty > 50000) {
        showNotice('Quantity must be between 0.5 kg and 50,000 kg.', 'error');
        return;
      }
      if (!Number.isFinite(plannedDays) || plannedDays < 1 || plannedDays > 3650) {
        showNotice('Planned storage days must be between 1 and 3,650.', 'error');
        return;
      }

      const now = nowUtc();
      store.batches.push({
        id: store.nextIds.batch++,
        device_id: deviceId,
        seed_profile_id: profile.id,
        label,
        quantity_kg: Number(qty.toFixed(2)),
        started_at: now,
        planned_days: plannedDays,
        status: 'active',
        closed_at: null
      });

      if (applyTemps && store.configs[deviceId]) {
        const midpoint = Number(((profile.temp_min + profile.temp_max) / 2).toFixed(1));
        const halfHyst = Math.max(
          0.4,
          Math.min(0.8, Number(((profile.temp_max - profile.temp_min) * 0.2).toFixed(1)))
        );
        store.configs[deviceId] = {
          ...store.configs[deviceId],
          target_temp: midpoint,
          temp_min: profile.temp_min,
          temp_max: profile.temp_max,
          cooling_on_temp: Number((midpoint + halfHyst).toFixed(1)),
          cooling_off_temp: Number((midpoint - halfHyst).toFixed(1)),
          config_version: store.configs[deviceId].config_version + 1,
          updated_at: now
        };
      }

      document.getElementById('batchLabel').value = '';
      formDirty = false;
      saveStore(store);
      showNotice(`Started new ${profile.name} batch "${label}" on ${deviceId}.`, 'success');
      refreshActiveViews();
    });

    // History Range, Pagination, CSV & Alert Filter
    document.querySelectorAll('.range-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        historyRange = btn.dataset.range;
        historyPage = 1;
        document.querySelectorAll('.range-btn').forEach((b) => {
          b.className = `btn btn-sm range-btn ${b.dataset.range === historyRange ? 'btn-primary' : 'btn-secondary'}`;
        });
        renderHistorySection();
      });
    });

    document.getElementById('prevPageBtn').addEventListener('click', () => {
      if (historyPage > 1) {
        historyPage -= 1;
        renderHistorySection();
      }
    });

    document.getElementById('nextPageBtn').addEventListener('click', () => {
      if (historyPage < historyTotalPages) {
        historyPage += 1;
        renderHistorySection();
      }
    });

    document.getElementById('exportCsvBtn').addEventListener('click', () => {
      const deviceId = getSelectedDeviceId();
      const hoursMap = { '24h': 24, '7d': 168, '30d': 720 };
      const sinceIso = new Date(Date.now() - (hoursMap[historyRange] || 24) * 3600_000).toISOString();
      const rows = store.readings
        .filter((r) => r.device_id === deviceId && r.created_at >= sinceIso)
        .reverse();

      const escapeCsv = (val) => {
        if (val === null || val === undefined) return '';
        const s = String(val);
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };

      const header = [
        'id',
        'created_at_utc',
        'device_id',
        'batch_label',
        'seed_profile',
        'temp_c',
        'humidity_percent',
        'fan_command_percent',
        'fan_measured_rpm',
        'cooling_on',
        'sensor_ok',
        'source'
      ].join(',');

      const lines = rows.map((r) => {
        const b = store.batches.find((x) => x.id === r.batch_id);
        const sName = b ? getSeedProfileById(b.seed_profile_id).name : '';
        const bLabel = b ? b.label : '';
        return [
          r.id,
          r.created_at,
          r.device_id,
          bLabel,
          sName,
          r.temp,
          r.humidity,
          r.fan_speed_percent,
          r.fan_rpm !== null ? r.fan_rpm : 'unavailable',
          r.cooling_on ? 'ON' : 'OFF',
          r.sensor_ok ? 'OK' : 'FAULT',
          r.is_simulated ? 'SIMULATED' : 'HARDWARE'
        ]
          .map(escapeCsv)
          .join(',');
      });

      const filename = `agriseed-${deviceId}-${historyRange}-${new Date().toISOString().slice(0, 10)}.csv`;
      triggerBlobDownload(filename, 'text/csv;charset=utf-8', [header, ...lines].join('\r\n'));
      showNotice(`Exported ${rows.length} telemetry rows to ${filename}.`, 'success');
    });

    const allAlertsBtn = document.getElementById('filterAllAlertsBtn');
    const actAlertsBtn = document.getElementById('filterActiveAlertsBtn');
    allAlertsBtn.addEventListener('click', () => {
      alertFilter = 'all';
      allAlertsBtn.className = 'btn btn-primary btn-sm';
      actAlertsBtn.className = 'btn btn-secondary btn-sm';
      renderHistorySection();
    });
    actAlertsBtn.addEventListener('click', () => {
      alertFilter = 'active';
      actAlertsBtn.className = 'btn btn-primary btn-sm';
      allAlertsBtn.className = 'btn btn-secondary btn-sm';
      renderHistorySection();
    });

    window.addEventListener('resize', () => {
      if (activeSection === 'overview' && liveChart) liveChart.draw();
      if (activeSection === 'history') {
        if (historyClimateChart) historyClimateChart.draw();
        if (historyActuatorChart) historyActuatorChart.draw();
      }
    });
  }

  function boot() {
    startLiveClock();
    populateChamberDropdown();
    populateSeedProfilesUI();

    liveChart = new DualLineChart({
      canvasId: 'liveDualChart',
      tooltipId: 'liveChartTooltip',
      dualAxis: true,
      series: [
        { label: 'Temperature', color: '#184e31', fillRgba: 'rgba(31, 92, 58, 0.22)', unit: '°C', decimals: 1 },
        { label: 'Humidity', color: '#6ea885', fillRgba: 'rgba(110, 168, 133, 0.18)', unit: '%', decimals: 1 }
      ]
    });

    historyClimateChart = new DualLineChart({
      canvasId: 'historyClimateChart',
      tooltipId: 'historyClimateTooltip',
      dualAxis: true,
      series: [
        { label: 'Avg Temp', color: '#184e31', fillRgba: 'rgba(24, 78, 49, 0.16)', unit: '°C', decimals: 2 },
        { label: 'Avg Humidity', color: '#6ea885', fillRgba: 'rgba(110, 168, 133, 0.15)', unit: '%', decimals: 1 }
      ]
    });

    historyActuatorChart = new DualLineChart({
      canvasId: 'historyActuatorChart',
      tooltipId: 'historyActuatorTooltip',
      dualAxis: false,
      series: [
        { label: 'Commanded Fan', color: '#2563eb', fillRgba: 'rgba(37, 99, 235, 0.14)', unit: '%', decimals: 0 },
        { label: 'Cooling Duty', color: '#d97706', fillRgba: null, unit: '%', decimals: 0, stepped: true }
      ]
    });

    bindAllEvents();

    const initialHash = (window.location.hash || '#overview').replace(/^#/, '');
    activateSection(initialHash);

    // Start built-in autonomous 5-second ESP32 simulator & 10-second stale watchdog
    simulator.start();
    setInterval(() => {
      runMaintenanceChecks();
      refreshActiveViews();
    }, 5000);
  }

  boot();
})();
