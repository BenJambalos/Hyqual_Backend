const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/profile
router.get('/profile', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT a.account_id, a.username, a.role, up.first_name, up.middle_name, up.last_name, up.email, up.phone
     FROM accounts a JOIN user_profiles up ON up.account_id = a.account_id
     WHERE a.account_id = ?`,
    [req.accountId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Profile not found' });
  res.json(rows[0]);
});

// PUT /api/profile  { firstName, middleName, lastName, email, phone }
router.put('/profile', async (req, res) => {
  const { firstName, middleName, lastName, email, phone } = req.body;
  await pool.query(
    `UPDATE user_profiles SET
       first_name = COALESCE(?, first_name),
       middle_name = ?,
       last_name = COALESCE(?, last_name),
       email = COALESCE(?, email),
       phone = ?
     WHERE account_id = ?`,
    [firstName, middleName ?? null, lastName, email, phone ?? null, req.accountId]
  );
  res.json({ message: 'Profile updated.' });
});

// GET /api/farm
router.get('/farm', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM aquaculture_farms WHERE farm_id = ?', [req.farmId]);
  if (!rows.length) return res.status(404).json({ error: 'Farm not found' });
  res.json(rows[0]);
});

// PUT /api/farm  { farmName, city, barangay, province, zip }
router.put('/farm', async (req, res) => {
  const { farmName, city, barangay, province, zip } = req.body;
  await pool.query(
    `UPDATE aquaculture_farms SET
       farm_name = COALESCE(?, farm_name),
       municipality = COALESCE(?, municipality),
       barangay = COALESCE(?, barangay),
       province = COALESCE(?, province),
       zip_code = COALESCE(?, zip_code)
     WHERE farm_id = ?`,
    [farmName, city, barangay, province, zip, req.farmId]
  );
  res.json({ message: 'Farm details updated.' });
});

module.exports = router;
