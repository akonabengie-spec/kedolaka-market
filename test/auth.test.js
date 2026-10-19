const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
require('dotenv').config();

test('registration, login, account retrieval, and logout use persistent revocable sessions', {
  skip: !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL to an initialized disposable PostgreSQL database.'
}, async function () {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.JWT_SECRET = 'integration-test-secret-only-not-for-production-675';
  const { app } = require('../server/api');
  const { query, pool } = require('../server/db');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(function (resolve) { server.once('listening', resolve); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const suffix = crypto.randomInt(0, 10000000).toString().padStart(7, '0');
  const email = `test-${crypto.randomUUID()}@example.test`;
  const password = 'TestPassword-675!';
  let cookie = '';

  async function request(path, options) {
    return fetch(baseUrl + path, Object.assign({ headers: {} }, options || {}));
  }

  try {
    const registration = await request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fullName: 'Test Buyer', email, phoneNumber: '+6757' + suffix,
        password, role: 'buyer', homeProvince: 'NCD'
      })
    });
    assert.equal(registration.status, 201);
    const registrationCookie = registration.headers.get('set-cookie') || '';
    cookie = registrationCookie.split(';')[0];
    assert.match(cookie, /^kundu_session=/);
    assert.match(registrationCookie, /httponly/i);
    assert.match(registrationCookie, /samesite=lax/i);

    const duplicate = await request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fullName: 'Duplicate Buyer', email, phoneNumber: '+6758' + suffix,
        password, role: 'buyer', homeProvince: 'NCD'
      })
    });
    assert.equal(duplicate.status, 409);

    const savedUser = await query('SELECT password_hash FROM users WHERE email = $1', [email]);
    assert.equal(savedUser.rows.length, 1);
    assert.notEqual(savedUser.rows[0].password_hash, password);
    assert.equal(await require('bcryptjs').compare(password, savedUser.rows[0].password_hash), true);

    const login = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.toUpperCase(), password })
    });
    assert.equal(login.status, 200);
    cookie = (login.headers.get('set-cookie') || '').split(';')[0];

    const invalidLogin = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'IncorrectPassword-675!' })
    });
    assert.equal(invalidLogin.status, 401);

    const currentUser = await request('/api/auth/me', { headers: { Cookie: cookie } });
    assert.equal(currentUser.status, 200);
    assert.equal((await currentUser.json()).user.email, email);

    const vendorDenied = await request('/api/vendor/dashboard', { headers: { Cookie: cookie } });
    assert.equal(vendorDenied.status, 403);
    const adminDenied = await request('/api/admin/dashboard', { headers: { Cookie: cookie } });
    assert.equal(adminDenied.status, 403);

    const unauthorized = await request('/api/auth/me');
    assert.equal(unauthorized.status, 401);

    const expiringLogin = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    assert.equal(expiringLogin.status, 200);
    const expiringCookie = (expiringLogin.headers.get('set-cookie') || '').split(';')[0];
    const token = decodeURIComponent(expiringCookie.slice(expiringCookie.indexOf('=') + 1));
    const sessionId = require('jsonwebtoken').decode(token).jti;
    await query("UPDATE auth_sessions SET expires_at = NOW() - INTERVAL '1 minute' WHERE session_id = $1", [sessionId]);
    const expired = await request('/api/auth/me', { headers: { Cookie: expiringCookie } });
    assert.equal(expired.status, 401);

    const logout = await request('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(logout.status, 200);
    const revoked = await request('/api/auth/me', { headers: { Cookie: cookie } });
    assert.equal(revoked.status, 401);
  } finally {
    await query('DELETE FROM users WHERE email = $1', [email]);
    await new Promise(function (resolve, reject) {
      server.close(function (error) { if (error) reject(error); else resolve(); });
    });
    await pool.end();
  }
});