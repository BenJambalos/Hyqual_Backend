const express = require('express');
const pool = require('../db');
const { paramStatus } = require('../utils/status');

const router = express.Router();

// These endpoints are called BY the physical HyQual devices, not by the
// mobile app, so they authenticate with a device_key (issued when the
// device is registered — see POST /api/devices) instead of a user JWT.
async function resolveDevice(deviceKey) {
  const [rows] = await pool.query(
    `SELECT device_id, farm_id, pond_id FROM monitoring_devices WHERE device_key = ?`,
    [deviceKey]
  );
  return rows[0] || null;
}

const TEMPLATES = {
  dissolved_oxygen: {
    label: 'DO',
    unit: 'mg/L',
    low: {
      title: (crit) => (crit ? 'High Risk -Low Dissolve Oxygen' : 'Moderate Risk -Low DO'),
      message: (v, min) => `DO level at ${v} mg/L , above the safe threshold of \u2265 ${min} mg/L`,
      action: (crit) => crit
        ? 'Run emergency aeration immediately and inspect for the cause of the drop (overstocking, organic buildup, or equipment failure).'
        : 'Increase aeration and re-check dissolved oxygen every 30 minutes until it stabilizes.',
    },
  },
  ph: {
    label: 'pH',
    unit: 'pH',
    low: {
      title: () => 'Low pH',
      message: (v, min) => `pH at ${v}, below the safe threshold of \u2265 ${min}`,
      action: () => 'Monitor pH hourly; consider agricultural lime to raise pH gradually.',
    },
    high: {
      title: () => 'Moderate High ph',
      message: (v, max) => `pH trending toward ${v}, nearing the unsafe threshold of \u2264 ${max}.`,
      action: () => 'Monitor pH hourly and avoid adding lime or other pH-raising treatments until it stabilizes.',
    },
  },
  temperature: {
    label: 'Temperature',
    unit: '\u00b0C',
    high: {
      title: () => 'High Water Temperature',
      message: (v, max) => `Temperature at ${v}\u00b0C, above the safe threshold of \u2264 ${max}\u00b0C`,
      action: () => 'Increase water depth or add shading; avoid feeding during peak heat.',
    },
    low: {
      title: () => 'Low Water Temperature',
      message: (v, min) => `Temperature at ${v}\u00b0C, below the safe threshold of \u2265 ${min}\u00b0C`,
      action: () => 'Reduce water exchange rate and monitor for cold stress.',
    },
  },
  salinity: {
    label: 'Salinity',
    unit: 'ppt',
    high: {
      title: () => 'High Salinity',
      message: (v, max) => `Salinity at ${v} ppt, above the safe threshold of \u2264 ${max} ppt`,
      action: () => 'Add fresh water gradually to dilute salinity.',
    },
    low: {
      title: () => 'Low Salinity',
      message: (v, min) => `Salinity at ${v} ppt, below the safe threshold of \u2265 ${min} ppt`,
      action: () => 'Check for freshwater intrusion or heavy rainfall dilution.',
    },
  },
};

async function checkThresholdsAndAlert(conn, { farmId, pondId, deviceId, parameter, value, thresholds }) {
  const t = thresholds[parameter];
  if (!t) return;
  const status = paramStatus(value, t.min, t.max);
  const tmpl = TEMPLATES[parameter];
  const direction = t.min !== null && value < t.min ? 'low' : (t.max !== null && value > t.max ? 'high' : null);

  // Find any still-open (unresolved) alert for this pond+parameter.
  const [openAlerts] = await conn.query(
    `SELECT notification_id FROM early_warning_notifications
     WHERE pond_id = ? AND parameter = ? AND is_resolved = 0 ORDER BY created_at DESC LIMIT 1`,
    [pondId, parameter]
  );

  if (status === 'normal') {
    // Reading is back in range — auto-resolve any open alert for it.
    if (openAlerts.length) {
      await conn.query('UPDATE early_warning_notifications SET is_resolved = 1 WHERE notification_id = ?', [openAlerts[0].notification_id]);
    }
    return;
  }

  if (openAlerts.length) return; // already alerted, don't spam duplicates
  if (!tmpl || !direction || !tmpl[direction]) return;

  const t2 = tmpl[direction];
  const isCritical = status === 'critical';
  const bound = direction === 'low' ? t.min : t.max;
  await conn.query(
    `INSERT INTO early_warning_notifications
       (farm_id, pond_id, device_id, parameter, title, alert_level, alert_message, recommended_action, is_resolved, is_read)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
    [
      farmId, pondId, deviceId, parameter,
      t2.title(isCritical),
      isCritical ? 'critical' : 'medium',
      t2.message(value, bound),
      t2.action(isCritical),
    ]
  );
}

// POST /api/ingest/readings
// { deviceKey, temperature, phLevel, dissolvedOxygen, salinity }
router.post('/ingest/readings', async (req, res) => {
  const { deviceKey, temperature, phLevel, dissolvedOxygen, salinity } = req.body;
  if (!deviceKey) return res.status(401).json({ error: 'deviceKey is required' });

  const device = await resolveDevice(deviceKey);
  if (!device) return res.status(401).json({ error: 'Unknown device key' });
  if (!device.pond_id) return res.status(409).json({ error: 'Device is not assigned to a pond yet' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query(
      `INSERT INTO water_quality_readings (device_id, temperature, ph_level, dissolved_oxygen, salinity)
       VALUES (?, ?, ?, ?, ?)`,
      [device.device_id, temperature ?? null, phLevel ?? null, dissolvedOxygen ?? null, salinity ?? null]
    );

    const [thRows] = await conn.query('SELECT parameter, min_value, max_value FROM parameter_thresholds WHERE farm_id = ?', [device.farm_id]);
    const thresholds = {};
    for (const r of thRows) thresholds[r.parameter] = { min: r.min_value, max: r.max_value };

    const checks = [
      ['temperature', temperature], ['ph', phLevel],
      ['dissolved_oxygen', dissolvedOxygen], ['salinity', salinity],
    ];
    for (const [param, value] of checks) {
      if (value === undefined || value === null) continue;
      await checkThresholdsAndAlert(conn, {
        farmId: device.farm_id, pondId: device.pond_id, deviceId: device.device_id,
        parameter: param, value, thresholds,
      });
    }

    await conn.commit();
    res.status(201).json({ message: 'Reading recorded.' });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// POST /api/ingest/status
// { deviceKey, batteryPercentage, isCharging, connectivityStatus, signalStrength, activeSensorsCount }
router.post('/ingest/status', async (req, res) => {
  const { deviceKey, batteryPercentage, isCharging, connectivityStatus, signalStrength, activeSensorsCount } = req.body;
  if (!deviceKey) return res.status(401).json({ error: 'deviceKey is required' });

  const device = await resolveDevice(deviceKey);
  if (!device) return res.status(401).json({ error: 'Unknown device key' });

  await pool.query(
    `INSERT INTO device_status (device_id, battery_percentage, is_charging, connectivity_status, signal_strength, active_sensors_count)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [device.device_id, batteryPercentage ?? null, isCharging ? 1 : 0, connectivityStatus || 'online', signalStrength || null, activeSensorsCount ?? 0]
  );
  res.status(201).json({ message: 'Status recorded.' });
});

module.exports = router;
