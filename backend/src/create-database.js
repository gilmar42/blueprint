import mysql from 'mysql2/promise';

const host = process.env.DB_HOST || '127.0.0.1';
const port = Number(process.env.DB_PORT || 3306);
const user = process.env.DB_USER || 'root';
const password = process.env.DB_PASSWORD || '';
const database = process.env.DB_NAME || 'vitrine';

if (!/^[A-Za-z0-9_$-]{1,64}$/.test(database)) {
  throw new Error('DB_NAME must contain only letters, numbers, underscore, dash, or dollar sign.');
}

const connection = await mysql.createConnection({ host, port, user, password, charset: 'utf8mb4' });
try {
  await connection.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  console.log(`Database ${database} is ready on ${host}:${port}.`);
} finally {
  await connection.end();
}
