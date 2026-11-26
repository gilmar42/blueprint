try {
  const rootPassword = process.env.MYSQL_ROOT_PASSWORD || '';
  const appPassword = process.env.MYSQL_PASSWORD || '';
  const redisPassword = process.env.REDIS_PASSWORD || '';
  if (rootPassword.length < 24) throw new Error('MYSQL_ROOT_PASSWORD must contain at least 24 characters in production');
  if (rootPassword === appPassword || rootPassword === redisPassword) {
    throw new Error('MYSQL_ROOT_PASSWORD must be different from application and Redis passwords');
  }
  console.log('Production database secret checks passed');
} catch (error) {
  console.error(`Production configuration check failed: ${error.message}`);
  process.exit(1);
}
