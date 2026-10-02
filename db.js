const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  // Fix 1: Ensure DB_PORT is parsed as a number (Railway passes it as a string)
  port: parseInt(process.env.DB_PORT || '3306', 10), 
  user: process.env.DB_USER,
  // Fix 2: Change DB_PASSWORD to DB_PASS to match your Railway Variables
  password: process.env.DB_PASS, 
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: false,
  decimalNumbers: true, // return DECIMAL columns as JS numbers, not strings
  charset: 'utf8mb4',   // without this, special characters like ≥ get mangled
});

module.exports = pool;
