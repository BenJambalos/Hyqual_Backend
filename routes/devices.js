const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function timeAgo(date) {
  if (!date) return 'never';
  const diffMs = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function connStatusToAppStatus(device, latestStatus) {
  // App only distinguishes online/offline/unassigned; "weak" from the
  // schema's connectivity_status ENUM is folded into "offline" for the
  // simple status pill, but exposed separately in the detail response.
  if (!device.pond_id) return 'unassigned';
  if (latestStatus?.connectivity_status === 'online') return 'online';
  return 'offline';
}

const DEVICE_QUERY = `
  SELECT md.device_id, md.device_name, md.status AS device_record_status, md.pond_id, md.installed_at,
    p.pond_name,
    ds.battery_percentage, ds.is_charging, ds.connectivity_status, ds.signal_strength,
    ds.active_sensors_count, ds.recorded_at
  FROM monitoring_devices md
  LEFT JOIN ponds p ON p.pond_id = md.pond_id
  LEFT JOIN device_status ds ON ds.status_id = (
    SELECT ds2.status_id FROM device_status ds2 WHERE ds2.device_id = md.device_id ORDER BY ds2.recorded_at DESC LIMIT 1
  )
  WHERE md.farm_id = ?
`;

function deviceRowToListJson(row) {
  return {
    id: String(row.device_id),
    name: row.device_name,
    pond: row.pond_name || 'Unassigned',
    status: connStatusToAppStatus(row, row),
    registeredDate: new Date(row.installed_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    lastSync: timeAgo(row.recorded_at),
  };
}

// GET /api/devices
router.get('/devices', async (req, res) => {
  const [rows] = await pool.query(DEVICE_QUERY + ' ORDER BY md.device_id', [req.farmId]);
  res.json(rows.map(deviceRowToListJson));
});

// POST /api/devices  { name, pondId? }
router.post('/devices', async (req, res) => {
  const { name, pondId } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const deviceKey = 'dk_' + crypto.randomBytes(16).toString('hex');
  const [result] = await pool.query(
    'INSERT INTO monitoring_devices (farm_id, pond_id, device_name, status, device_key) VALUES (?, ?, ?, ?, ?)',
    [req.farmId, pondId || null, name, 'active', deviceKey]
  );
  // Give it an initial (offline, unsynced) status row so it shows up
  // sensibly in lists before its first real check-in.
  await pool.query(
    `INSERT INTO device_status (device_id, connectivity_status, active_sensors_count) VALUES (?, 'offline', 0)`,
    [result.insertId]
  );
  res.status(201).json({ id: String(result.insertId), name, deviceKey });
});

// PUT /api/devices/:id  { name, pondId }  — also used for reassignment
router.put('/devices/:id', async (req, res) => {
  const { name, pondId } = req.body;
  const [result] = await pool.query(
    'UPDATE monitoring_devices SET device_name = COALESCE(?, device_name), pond_id = ? WHERE device_id = ? AND farm_id = ?',
    [name, pondId === undefined ? null : pondId, req.params.id, req.farmId]
  );
  if (!result.affectedRows) return res.status(404).json({ error: 'Device not found' });
  res.json({ message: 'Device updated.' });
});

// DELETE /api/devices/:id
router.delete('/devices/:id', async (req, res) => {
  const [result] = await pool.query('DELETE FROM monitoring_devices WHERE device_id = ? AND farm_id = ?', [req.params.id, req.farmId]);
  if (!result.affectedRows) return res.status(404).json({ error: 'Device not found' });
  res.json({ message: 'Device removed.' });
});

// POST /api/devices/:id/assign  { pondId }
router.post('/devices/:id/assign', async (req, res) => {
  const { pondId } = req.body;
  if (!pondId) return res.status(400).json({ error: 'pondId is required' });
  const [result] = await pool.query(
    'UPDATE monitoring_devices SET pond_id = ? WHERE device_id = ? AND farm_id = ?',
    [pondId, req.params.id, req.farmId]
  );
  if (!result.affectedRows) return res.status(404).json({ error: 'Device not found' });
  res.json({ message: 'Device assigned.' });
});

// GET /api/devices/:id  — full detail for Device Status screen
router.get('/devices/:id', async (req, res) => {
  const [rows] = await pool.query(DEVICE_QUERY + ' AND md.device_id = ?', [req.farmId, req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Device not found' });
  const row = rows[0];
  const online = row.connectivity_status === 'online';

  res.json({
    id: String(row.device_id),
    name: row.device_name,
    pond: row.pond_name || null,
    online,
    connectivityStatus: row.connectivity_status || 'offline',
    batteryPercent: row.battery_percentage !== null ? Number(row.battery_percentage) : 0,
    solarCharging: !!row.is_charging,
    wifiStable: row.connectivity_status === 'online',
    activeSensors: row.active_sensors_count ?? 0,
    totalSensors: 4,
    lastSync: timeAgo(row.recorded_at),
  });
});

module.exports = router;
