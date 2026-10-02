const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: false,
  decimalNumbers: true, // return DECIMAL columns as JS numbers, not strings
  charset: 'utf8mb4',   // without this, special characters like ≥ get mangled
});

module.exports = pool;
