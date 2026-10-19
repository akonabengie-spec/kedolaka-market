require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const multer = require('multer');
const nodemailer = require('nodemailer');
const path = require('node:path');
const { pool, query, checkDatabase, checkSchema } = require('./db');
const { getPaymentConfiguration, validatePaymentConfiguration } = require('./payments');
const { authenticateToken, optionalAuthenticateToken, requireRole } = require('./security');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;
const root = path.resolve(__dirname, '..');
const uploadsRoot = path.resolve(process.env.UPLOADS_DIR || path.join(root, 'uploads'));
const productImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 }
});
function parseProductImageUpload(req, res, next) {
  productImageUpload.single('productImage')(req, res, function (error) {
    if (error instanceof multer.MulterError) {
      const message = error.code === 'LIMIT_FILE_SIZE'
        ? 'Product images must be 5 MB or smaller.'
        : 'Only one product image can be uploaded at a time.';
      return res.status(400).json(errorResponse(400, 'invalid_image_upload', message));
    }
    return error ? next(error) : next();
  });
}
const COOKIE_NAME = 'kundu_session';
const SESSION_SECONDS = 86400;
const PROVINCES = [
  'NCD', 'Morobe', 'Western Highlands', 'East New Britain', 'Eastern Highlands', 'Madang',
  'Milne Bay', 'East Sepik', 'West Sepik', 'Bougainville', 'Manus', 'New Ireland',
  'West New Britain', 'Central', 'Gulf', 'Oro', 'Western', 'Southern Highlands',
  'Enga', 'Hela', 'Jiwaka', 'Chimbu'
];
const SHIPPING_PROVIDERS = new Set(['PMV', 'Ship', 'AirNiugini', 'Pickup']);
const LEGACY_SHIPPING_PROVIDERS = new Set(['PostPNG']);
const LOCAL_SHIPPING_PROVIDERS = new Set(['PMV', 'Pickup']);
const INTERPROVINCE_SHIPPING_PROVIDERS = new Set(['Ship', 'AirNiugini']);
const PRODUCT_DELIVERY_TYPES = new Set(['delivery', 'pickup', 'both']);
const PRODUCT_ADDITIONAL_DETAIL_FIELDS = Object.freeze([
  'brand', 'model', 'dimensions', 'materials', 'origin', 'warranty',
  'deliveryAreas', 'dispatchTime', 'deliveryEstimate', 'pickupDetails', 'deliveryRestrictions'
]);
const VENDOR_PAYMENT_METHODS = Object.freeze({
  bank_transfer: { name: 'Bank transfer', databaseMethod: 'manual_bank_transfer' },
  mobile_wallet: { name: 'Mobile wallet', databaseMethod: 'mobile_wallet' },
  cash_on_delivery: { name: 'Cash on delivery', databaseMethod: 'cash_on_delivery' },
  in_person: { name: 'Pay in person', databaseMethod: 'in_person' }
});
const MANUAL_PAYMENT_METHODS = new Set(Object.keys(VENDOR_PAYMENT_METHODS).map(function (id) {
  return VENDOR_PAYMENT_METHODS[id].databaseMethod;
}).concat(['manual_bank_transfer', 'cash_on_delivery', 'in_person']));
const origins = new Set((process.env.CORS_ORIGINS || `http://localhost:${PORT}`)
  .split(',').map(function (origin) { return origin.trim(); }).filter(Boolean));

function availableStockSql(productAlias) {
  return `GREATEST(${productAlias}.stock_quantity - COALESCE((
    SELECT SUM(ir.quantity) FROM inventory_reservations ir
     WHERE ir.product_id = ${productAlias}.product_id AND ir.status = 'reserved' AND ir.expires_at > clock_timestamp()
  ), 0), 0)`;
}

async function lockCheckoutCart(client, userId) {
  await client.query(
    `SELECT ci.product_id
       FROM cart_items ci
       JOIN products p ON p.product_id = ci.product_id
       JOIN vendors v ON v.vendor_id = p.vendor_id
      WHERE ci.user_id = $1
      ORDER BY ci.product_id
      FOR UPDATE OF ci, p, v`,
    [userId]
  );
}

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'self'"],
      imgSrc: ["'self'", 'https:', 'data:'],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"]
    }
  }
}));
app.use(cors({
  origin: function (origin, callback) {
    if (!origin || origins.has(origin)) return callback(null, true);
    return callback(null, false);
  },
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(function (req, res, next) {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.headers.origin && !origins.has(req.headers.origin)) {
    return res.status(403).json(errorResponse(403, 'origin_not_allowed', 'Request origin is not allowed.'));
  }
  return next();
});

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/signup', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth/reset-password', authLimiter);

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeProductAdditionalDetails(body, requireAll) {
  const details = {};
  for (const field of PRODUCT_ADDITIONAL_DETAIL_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) {
      if (requireAll) return null;
      continue;
    }
    const value = body[field];
    if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 500) return null;
    details[field] = value.trim();
  }
  return details;
}

function normalizeProductDeliveryContacts(value, required) {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (error) {
      return null;
    }
  }
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || value.length > PROVINCES.length) return null;
  const seenProvinces = new Set();
  const contacts = [];
  for (const contact of value) {
    if (!contact || typeof contact !== 'object' || Array.isArray(contact) ||
        !PROVINCES.includes(contact.province) || seenProvinces.has(contact.province)) return null;
    const name = normalizeString(contact.name);
    const phone = normalizePhoneNumber(contact.phone);
    const transport = normalizeString(contact.transport);
    const route = normalizeString(contact.route);
    if (name.length < 2 || name.length > 120 || !/^\+675[78]\d{7}$/.test(phone) ||
        transport.length < 2 || transport.length > 120 || route.length < 2 || route.length > 500 ||
        /[\u0000-\u001f\u007f]/.test(name + transport + route)) return null;
    seenProvinces.add(contact.province);
    contacts.push({ province: contact.province, name, phone, transport, route });
  }
  return contacts;
}

function normalizeCategoryFilter(value) {
  const category = normalizeString(value);
  return category.toLowerCase() === 'all' ? '' : category.slice(0, 80);
}

function normalizePhoneNumber(value) {
  const raw = normalizeString(value).replace(/[\s().-]/g, '');
  return raw;
}

function isShippingProviderValidForRoute(provider, origin, destination) {
  if (origin === destination) return LOCAL_SHIPPING_PROVIDERS.has(provider);
  return INTERPROVINCE_SHIPPING_PROVIDERS.has(provider);
}

function normalizeVendorPaymentMethods(value) {
  if (!Array.isArray(value) || value.length > Object.keys(VENDOR_PAYMENT_METHODS).length) return null;
  const seen = new Set();
  const methods = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        !Object.prototype.hasOwnProperty.call(VENDOR_PAYMENT_METHODS, entry.id) || seen.has(entry.id)) return null;
    const instructions = normalizeString(entry.instructions).replace(/\r\n?/g, '\n');
    if (instructions.length < 5 || instructions.length > 1000 || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(instructions)) return null;
    const referencePhoneRaw = typeof entry.referencePhone === 'string' ? entry.referencePhone : '';
    const referenceWhatsappRaw = typeof entry.referenceWhatsapp === 'string' ? entry.referenceWhatsapp : '';
    const referencePhone = normalizePhoneNumber(referencePhoneRaw);
    const referenceWhatsapp = normalizePhoneNumber(referenceWhatsappRaw);
    const isPngPhone = function (value) { return /^\+675[78]\d{7}$/.test(value); };
    if (/[^\d+\s().-]/.test(referencePhoneRaw + referenceWhatsappRaw) ||
        (referencePhone && !isPngPhone(referencePhone)) || (referenceWhatsapp && !isPngPhone(referenceWhatsapp)) ||
        (['bank_transfer', 'mobile_wallet'].includes(entry.id) && !referencePhone && !referenceWhatsapp)) return null;
    seen.add(entry.id);
    methods.push({
      id: entry.id,
      name: VENDOR_PAYMENT_METHODS[entry.id].name,
      instructions,
      referencePhone,
      referenceWhatsapp
    });
  }
  return methods;
}

function vendorCheckoutUuid(groupKey, vendorId) {
  const bytes = crypto.createHash('sha256').update(`${groupKey}:${vendorId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizeRole(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeProvince(value) {
  const raw = normalizeString(value);
  return PROVINCES.find(function (province) { return province.toLowerCase() === raw.toLowerCase(); }) || null;
}

function parsePositiveId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function parseQueryInteger(value, defaultValue, minimum, maximum) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : null;
}

function parsePriceFilter(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,7})(\.\d{1,2})?$/.test(value)) return undefined;
  const amount = Number(value);
  return Number.isFinite(amount) && amount <= 10000000 ? value : undefined;
}

function checkoutFingerprint(checkout) {
  return crypto.createHash('sha256').update(JSON.stringify([
    checkout.deliveryProvince,
    checkout.deliveryAddress,
    checkout.phoneNumber,
    checkout.shippingProvider,
    checkout.paymentMethod
  ])).digest('hex');
}

function successResponse(status, message, payload) {
  return Object.assign({ success: true, status, message }, payload || {});
}

function errorResponse(status, code, message) {
  return { success: false, status, code, message };
}

function publicUser(user) {
  return {
    id: user.user_id,
    fullName: user.full_name,
    email: user.email,
    phoneNumber: user.phone_number,
    homeProvince: user.home_province,
    role: user.role
  };
}

function ensureJwtSecret() {
  if (!JWT_SECRET || JWT_SECRET.length < 32 || JWT_SECRET.startsWith('replace-with-')) {
    throw new Error('Set JWT_SECRET to a unique secret of at least 32 characters.');
  }
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_SECONDS * 1000
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/'
  });
}

async function issueSession(user, res) {
  ensureJwtSecret();
  const sessionId = crypto.randomUUID();
  await query(
    "INSERT INTO auth_sessions (session_id, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '24 hours')",
    [sessionId, user.user_id]
  );
  const token = jwt.sign({ sub: String(user.user_id), jti: sessionId }, JWT_SECRET, {
    expiresIn: SESSION_SECONDS,
    algorithm: 'HS256'
  });
  setSessionCookie(res, token);
}

function isValidPassword(password) {
  return typeof password === 'string' && password.length >= 10 && Buffer.byteLength(password, 'utf8') <= 72;
}

async function findFreightRate(client, origin, destination, provider) {
  const result = await client.query(
    `SELECT amount_kina, is_estimate FROM freight_rates
      WHERE origin_province = $1 AND destination_province = $2 AND provider = $3 AND active = TRUE`,
    [origin, destination, provider]
  );
  return result.rows[0] ? { amount: Number(result.rows[0].amount_kina), isEstimate: result.rows[0].is_estimate } : null;
}

async function expirePaymentReservations(client) {
  return client.query(
    `WITH expired AS (
       SELECT pay.order_id
         FROM orders o JOIN payments pay ON pay.order_id = o.order_id
        WHERE pay.status = 'pending' AND pay.expires_at IS NOT NULL
          AND pay.expires_at <= clock_timestamp()
        FOR UPDATE OF o, pay SKIP LOCKED
     ), cancelled_orders AS (
       UPDATE orders o SET payment_status = 'expired', order_status = 'cancelled', updated_at = NOW()
        FROM expired e WHERE o.order_id = e.order_id
        RETURNING o.order_id
     ), expired_payments AS (
       UPDATE payments pay SET status = 'expired', updated_at = NOW()
        FROM expired e WHERE pay.order_id = e.order_id AND pay.status = 'pending'
        RETURNING pay.order_id
     )
     UPDATE inventory_reservations r
        SET status = 'expired', updated_at = NOW()
       FROM expired_payments e
      WHERE r.order_id = e.order_id AND r.status = 'reserved'
      RETURNING r.order_id`
  );
}

app.get('/api/payments/methods', async function (req, res, next) {
  let client;
  try {
    const configuration = getPaymentConfiguration();
    client = await pool.connect();
    await client.query('BEGIN');
    await expirePaymentReservations(client);
    await client.query('COMMIT');
    return res.status(200).json(successResponse(200, 'Payment methods enabled by server configuration.', {
      methods: configuration.methods.map(function (method) {
        return {
          id: method.id,
          name: method.name,
          description: method.description,
          instructions: method.instructions,
          manualVerification: method.mode === 'manual'
        };
      })
    }));
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    return next(error);
  } finally {
    if (client) client.release();
  }
});

app.post(['/api/auth/register', '/api/auth/signup'], async function (req, res, next) {
  try {
    ensureJwtSecret();
  } catch (error) {
    return next(error);
  }
  const body = req.body || {};
  const fullName = normalizeString(body.fullName);
  const email = normalizeString(body.email).toLowerCase();
  const phone = normalizePhoneNumber(body.phoneNumber || body.mobileNumber);
  const province = normalizeProvince(body.homeProvince || 'NCD');
  const role = normalizeRole(body.role || 'buyer');
  const password = body.password;
  const vendorBusinessName = normalizeString(body.businessName);
  const vendorProvince = normalizeProvince(body.businessProvince || province);
  const vendorPaymentMethods = Object.prototype.hasOwnProperty.call(body, 'vendorPaymentMethods')
    ? normalizeVendorPaymentMethods(body.vendorPaymentMethods)
    : [];
  if (fullName.length < 2 || fullName.length > 150 || email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      !/^\+675[78]\d{7}$/.test(phone) || !isValidPassword(password) || !province || !['buyer', 'vendor'].includes(role)) {
    return res.status(400).json(errorResponse(400, 'invalid_registration', 'Provide a valid name, email, PNG mobile number, password (10-72 characters), role, and province.'));
  }
  if ((role === 'vendor' && (vendorBusinessName.length < 2 || vendorBusinessName.length > 180 ||
      !vendorPaymentMethods || !vendorPaymentMethods.length)) ||
      !vendorProvince || vendorPaymentMethods === null) {
    return res.status(400).json(errorResponse(400, 'invalid_vendor_payment_setup', 'Vendor registration requires clear payment instructions and a valid PNG phone or WhatsApp contact for each bank-transfer or mobile-wallet method.'));
  }
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await client.query(
      `INSERT INTO users (full_name, email, phone_number, home_province, role, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING user_id, full_name, email, phone_number, home_province, role`,
      [fullName, email, phone, province, role, passwordHash]
    );
    const user = result.rows[0];
    if (role === 'vendor') {
      await client.query(
        `INSERT INTO vendors (user_id, business_name, province, payment_methods, status)
         VALUES ($1, NULLIF($2, ''), $3, $4::jsonb, 'review')`,
        [user.user_id, vendorBusinessName || null, vendorProvince, JSON.stringify(vendorPaymentMethods)]
      );
    }
    const sessionId = crypto.randomUUID();
    await client.query(
      "INSERT INTO auth_sessions (session_id, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '24 hours')",
      [sessionId, user.user_id]
    );
    await client.query('COMMIT');
    ensureJwtSecret();
    setSessionCookie(res, jwt.sign({ sub: String(user.user_id), jti: sessionId }, JWT_SECRET, { expiresIn: SESSION_SECONDS, algorithm: 'HS256' }));
    return res.status(201).json(successResponse(201, 'Account created.', { user: publicUser(user) }));
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    if (error.code === '23505') return res.status(409).json(errorResponse(409, 'account_exists', 'An account with that email or phone number already exists.'));
    return next(error);
  } finally {
    if (client) client.release();
  }
});

app.post('/api/auth/login', async function (req, res, next) {
  try {
    const emailInput = normalizeString(req.body && (req.body.email || req.body.username));
    const email = emailInput.toLowerCase();
    const password = req.body && req.body.password;
    if (!email || typeof password !== 'string') return res.status(400).json(errorResponse(400, 'missing_credentials', 'Email and password are required.'));
    const result = await query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json(errorResponse(401, 'invalid_credentials', 'Email or password is incorrect.'));
    }
    await issueSession(user, res);
    return res.status(200).json(successResponse(200, 'Signed in.', { user: publicUser(user) }));
  } catch (error) {
    return next(error);
  }
});

app.post('/api/auth/logout', authenticateToken, async function (req, res, next) {
  try {
    await query('UPDATE auth_sessions SET revoked_at = NOW() WHERE session_id = $1 AND revoked_at IS NULL', [req.authSessionId]);
    clearSessionCookie(res);
    return res.status(200).json(successResponse(200, 'Signed out.'));
  } catch (error) {
    return next(error);
  }
});

app.get('/api/auth/me', authenticateToken, function (req, res) {
  return res.status(200).json(successResponse(200, 'Current account.', { user: publicUser(req.user) }));
});

app.get('/api/auth/session', optionalAuthenticateToken, function (req, res) {
  return res.status(200).json(successResponse(200, 'Current session.', {
    user: req.user ? publicUser(req.user) : null
  }));
});

app.patch('/api/auth/me', authenticateToken, async function (req, res, next) {
  const province = normalizeProvince(req.body && req.body.homeProvince);
  if (!province) return res.status(400).json(errorResponse(400, 'invalid_province', 'Select a valid PNG province.'));
  try {
    const result = await query(
      'UPDATE users SET home_province = $1, updated_at = NOW() WHERE user_id = $2 RETURNING user_id, full_name, email, phone_number, home_province, role',
      [province, req.user.user_id]
    );
    req.user = result.rows[0];
    return res.status(200).json(successResponse(200, 'Delivery province updated.', { user: publicUser(req.user) }));
  } catch (error) {
    return next(error);
  }
});

const mailer = process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD && process.env.MAIL_FROM
  ? nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
  })
  : null;

app.post('/api/auth/forgot-password', async function (req, res, next) {
  const message = 'If the account exists and recovery email is configured, instructions will be sent.';
  const email = normalizeString(req.body && req.body.email).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json(errorResponse(400, 'invalid_email', 'Provide a valid email address.'));
  }
  if (!mailer) {
    return res.status(503).json(errorResponse(503, 'email_unavailable', 'Password reset email is unavailable because SMTP is not configured.'));
  }
  try {
    const found = await query('SELECT user_id, email FROM users WHERE email = $1', [email]);
    if (found.rows[0]) {
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const createdToken = await query(
        "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 minutes') RETURNING token_id",
        [found.rows[0].user_id, tokenHash]
      );
      const baseUrl = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
      try {
        const delivery = await mailer.sendMail({
          from: process.env.MAIL_FROM,
          to: found.rows[0].email,
          subject: 'KEDOLAKA MARKET password reset',
          text: `Use this one-time link within 30 minutes: ${baseUrl}/reset-password.html?reset=${encodeURIComponent(token)}`
        });
        if (!delivery.accepted || !delivery.accepted.length || (delivery.rejected && delivery.rejected.length)) {
          throw new Error('mail_delivery_failed');
        }
      } catch (deliveryError) {
        await query('DELETE FROM password_reset_tokens WHERE token_id = $1', [createdToken.rows[0].token_id]);
        throw deliveryError;
      }
    }
    return res.status(202).json(successResponse(202, message));
  } catch (error) {
    console.error('Password reset request failed:', error.code || error.name || 'reset_error');
    return res.status(503).json(errorResponse(503, 'email_delivery_failed', 'Password reset email could not be sent. Please try again later.'));
  }
});

app.post('/api/auth/reset-password', async function (req, res, next) {
  const token = normalizeString(req.body && req.body.token).toLowerCase();
  const password = req.body && req.body.password;
  if (!/^[a-f0-9]{64}$/.test(token) || !isValidPassword(password)) {
    return res.status(400).json(errorResponse(400, 'invalid_reset', 'A valid reset token and password of 10-72 characters are required.'));
  }
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const result = await client.query(
      'SELECT user_id FROM password_reset_tokens WHERE token_hash = $1 AND expires_at > NOW() FOR UPDATE', [tokenHash]
    );
    if (!result.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(400).json(errorResponse(400, 'invalid_reset', 'This password reset link is invalid or expired.'));
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const userId = result.rows[0].user_id;
    await client.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE user_id = $2', [passwordHash, userId]);
    await client.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [userId]);
    await client.query('UPDATE auth_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
    await client.query('COMMIT');
    clearSessionCookie(res);
    return res.status(200).json(successResponse(200, 'Password changed. Sign in with your new password.'));
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    return next(error);
  } finally {
    if (client) client.release();
  }
});

app.get('/api/products', async function (req, res, next) {
  try {
    const search = normalizeString(req.query.q || '').slice(0, 100);
    const category = normalizeCategoryFilter(req.query.category || '');
    const province = req.query.province ? normalizeProvince(req.query.province) : null;
    const minimumPrice = parsePriceFilter(req.query.minPrice);
    const maximumPrice = parsePriceFilter(req.query.maxPrice);
    const limit = parseQueryInteger(req.query.limit, 20, 1, 50);
    const offset = parseQueryInteger(req.query.offset, 0, 0, 100000);
    const sort = normalizeString(req.query.sort || 'newest');
    const ordering = {
      newest: 'p.created_at DESC, p.product_id DESC',
      price_asc: 'p.price_kina ASC, p.product_id DESC',
      price_desc: 'p.price_kina DESC, p.product_id DESC',
      name_asc: 'p.product_name ASC, p.product_id DESC'
    };
    if (req.query.province && !province) return res.status(400).json(errorResponse(400, 'invalid_province', 'Select a valid PNG province.'));
    if ((req.query.q !== undefined && typeof req.query.q !== 'string') ||
        (req.query.category !== undefined && typeof req.query.category !== 'string')) {
      return res.status(400).json(errorResponse(400, 'invalid_product_filter', 'Search and category filters must be single text values.'));
    }
    if (limit === null || offset === null) return res.status(400).json(errorResponse(400, 'invalid_pagination', 'Limit must be 1-50 and offset must be 0-100000.'));
    if (minimumPrice === undefined || maximumPrice === undefined ||
        (minimumPrice !== null && maximumPrice !== null && Number(minimumPrice) > Number(maximumPrice))) {
      return res.status(400).json(errorResponse(400, 'invalid_price_filter', 'Price filters must be valid Kina amounts, and the minimum cannot exceed the maximum.'));
    }
    if (!ordering[sort]) return res.status(400).json(errorResponse(400, 'invalid_sort', 'Select a supported product sort order.'));
    const result = await query(
      `SELECT p.product_id, p.product_name, p.category, p.province, p.delivery_type, p.item_condition, p.price_unit, p.price_kina,
              ${availableStockSql('p')} AS stock_quantity, p.image_url, p.created_at, v.vendor_id, v.business_name
         FROM products p JOIN vendors v ON v.vendor_id = p.vendor_id
        WHERE p.status = 'listed' AND ${availableStockSql('p')} > 0 AND v.status = 'active'
          AND ($1 = '' OR p.product_name ILIKE '%' || $1 || '%' OR p.description ILIKE '%' || $1 || '%')
          AND ($2 = '' OR LOWER(p.category) = LOWER($2)) AND ($3::text IS NULL OR p.province = $3)
          AND ($4::numeric IS NULL OR p.price_kina >= $4::numeric)
          AND ($5::numeric IS NULL OR p.price_kina <= $5::numeric)
        ORDER BY ${ordering[sort]} LIMIT $6 OFFSET $7`,
      [search, category, province, minimumPrice, maximumPrice, limit, offset]
    );
    const count = await query(
      `SELECT COUNT(*) AS total
         FROM products p JOIN vendors v ON v.vendor_id = p.vendor_id
        WHERE p.status = 'listed' AND ${availableStockSql('p')} > 0 AND v.status = 'active'
          AND ($1 = '' OR p.product_name ILIKE '%' || $1 || '%' OR p.description ILIKE '%' || $1 || '%')
          AND ($2 = '' OR LOWER(p.category) = LOWER($2)) AND ($3::text IS NULL OR p.province = $3)
          AND ($4::numeric IS NULL OR p.price_kina >= $4::numeric)
          AND ($5::numeric IS NULL OR p.price_kina <= $5::numeric)`,
      [search, category, province, minimumPrice, maximumPrice]
    );
    return res.status(200).json(successResponse(200, 'Products.', {
      products: result.rows, total: Number(count.rows[0].total), limit, offset, sort
    }));
  } catch (error) {
    return next(error);
  }
});

app.get('/api/products/categories', async function (req, res, next) {
  try {
    const result = await query(
      `SELECT DISTINCT p.category
         FROM products p JOIN vendors v ON v.vendor_id = p.vendor_id
        WHERE p.status = 'listed' AND ${availableStockSql('p')} > 0 AND v.status = 'active'
        ORDER BY p.category`
    );
    return res.status(200).json(successResponse(200, 'Available product categories.', {
      categories: result.rows.map(function (row) { return row.category; })
    }));
  } catch (error) {
    return next(error);
  }
});

app.get('/api/products/:productId', async function (req, res, next) {
  try {
    const id = parsePositiveId(req.params.productId);
    if (!id) return res.status(400).json(errorResponse(400, 'invalid_product', 'Product ID is invalid.'));
    const result = await query(
      `SELECT p.product_id, p.product_name, p.description, p.category, p.province, p.delivery_type, p.item_condition, p.price_unit, p.delivery_notes, p.additional_details, p.price_kina,
              ${availableStockSql('p')} AS stock_quantity, p.image_url, v.vendor_id, v.business_name
         FROM products p JOIN vendors v ON v.vendor_id = p.vendor_id
        WHERE p.product_id = $1 AND p.status = 'listed' AND ${availableStockSql('p')} > 0 AND v.status = 'active'`, [id]
    );
    if (!result.rows[0]) return res.status(404).json(errorResponse(404, 'product_not_found', 'Product was not found.'));
    return res.status(200).json(successResponse(200, 'Product.', { product: result.rows[0] }));
  } catch (error) {
    return next(error);
  }
});

app.post('/api/vendor/profile', authenticateToken, requireRole('vendor'), async function (req, res, next) {
  const businessName = normalizeString(req.body && req.body.businessName);
  const province = normalizeProvince(req.body && req.body.province);
  const hasPaymentMethods = Object.prototype.hasOwnProperty.call(req.body || {}, 'paymentMethods');
  const paymentMethods = hasPaymentMethods ? normalizeVendorPaymentMethods(req.body.paymentMethods) : [];
  if (businessName.length < 2 || businessName.length > 180 || !province) {
    return res.status(400).json(errorResponse(400, 'invalid_vendor_profile', 'Business name and valid province are required.'));
  }
  if (paymentMethods === null || !paymentMethods.length) {
    return res.status(400).json(errorResponse(400, 'invalid_vendor_payment_setup', 'Choose at least one supported method, add clear instructions, and provide a valid PNG phone or WhatsApp contact for bank transfer/mobile wallet.'));
  }
  try {
    const result = await query(
      `INSERT INTO vendors (user_id, business_name, province, payment_methods, status)
       VALUES ($1, $2, $3, $4::jsonb, 'review')
       ON CONFLICT (user_id) DO UPDATE SET business_name = EXCLUDED.business_name, province = EXCLUDED.province,
         payment_methods = CASE WHEN $5 THEN EXCLUDED.payment_methods ELSE vendors.payment_methods END,
         status = CASE WHEN vendors.status = 'active' THEN vendors.status ELSE 'review' END, updated_at = NOW()
       RETURNING vendor_id, business_name, province, payment_methods, status`,
      [req.user.user_id, businessName, province, JSON.stringify(paymentMethods || []), hasPaymentMethods]
    );
    return res.status(200).json(successResponse(200, 'Vendor application submitted for review.', { vendor: result.rows[0] }));
  } catch (error) {
    return next(error);
  }
});

app.patch('/api/vendor/payment-methods', authenticateToken, requireRole('vendor'), async function (req, res, next) {
  const paymentMethods = normalizeVendorPaymentMethods(req.body && req.body.paymentMethods);
  if (paymentMethods === null || !paymentMethods.length) {
    return res.status(400).json(errorResponse(400, 'invalid_vendor_payment_setup', 'Choose at least one supported method, add clear instructions, and provide a valid PNG phone or WhatsApp contact for bank transfer/mobile wallet.'));
  }
  try {
    const result = await query(
      `UPDATE vendors SET payment_methods = $1::jsonb, updated_at = NOW()
        WHERE user_id = $2
        RETURNING vendor_id, payment_methods, status`,
      [JSON.stringify(paymentMethods), req.user.user_id]
    );
    if (!result.rows[0]) return res.status(404).json(errorResponse(404, 'vendor_profile_missing', 'Submit a vendor application before configuring payment methods.'));
    return res.status(200).json(successResponse(200, 'Vendor payment methods updated.', { vendor: result.rows[0] }));
  } catch (error) {
    return next(error);
  }
});

async function requireActiveVendor(req, res, next) {
  try {
    const result = await query('SELECT vendor_id, province, status FROM vendors WHERE user_id = $1', [req.user.user_id]);
    if (!result.rows[0] || result.rows[0].status !== 'active') {
      return res.status(403).json(errorResponse(403, 'vendor_not_approved', 'Vendor access is pending approval.'));
    }
    req.vendor = result.rows[0];
    return next();
  } catch (error) {
    return next(error);
  }
}

app.get('/api/vendor/dashboard', authenticateToken, requireRole('vendor'), async function (req, res, next) {
  try {
    const vendorResult = await query('SELECT vendor_id, business_name, province, payment_methods, status FROM vendors WHERE user_id = $1', [req.user.user_id]);
    if (!vendorResult.rows[0]) return res.status(404).json(errorResponse(404, 'vendor_profile_missing', 'Submit a vendor application to continue.'));
    const vendor = vendorResult.rows[0];
    const [products, orders] = await Promise.all([
      query('SELECT product_id, product_name, description, category, province, delivery_type, item_condition, price_unit, delivery_notes, additional_details, delivery_contacts, price_kina, stock_quantity, image_url, status FROM products WHERE vendor_id = $1 ORDER BY created_at DESC', [vendor.vendor_id]),
      query(`SELECT f.order_id, f.status AS order_status, o.payment_status, o.payment_method,
        u.full_name AS buyer_name, o.delivery_address, o.delivery_province, o.phone_number, o.shipping_provider,
        o.shipping_payer, o.shipment_carrier, o.shipment_booking_reference, o.shipment_tracking_reference, o.shipment_tracking_url, o.shipment_notes,
        o.shipment_driver_name, o.shipment_driver_phone, o.shipment_vehicle_plate, o.shipment_vehicle_description,
            EXISTS (SELECT 1 FROM vendor_payment_verifications vpv
                     WHERE vpv.order_id = f.order_id AND vpv.vendor_id = f.vendor_id
                       AND vpv.status = 'successful') AS vendor_confirmed_receipt,
            SUM(i.unit_price_kina * i.quantity) AS vendor_subtotal_kina,
            COALESCE(json_agg(json_build_object('productName', i.product_name, 'contact', i.delivery_contact))
              FILTER (WHERE i.delivery_contact IS NOT NULL), '[]') AS delivery_contacts,
            o.created_at
           FROM vendor_order_fulfillments f
           JOIN orders o ON o.order_id = f.order_id
           JOIN users u ON u.user_id = o.buyer_id
           JOIN order_items i ON i.order_id = f.order_id AND i.vendor_id = f.vendor_id
          WHERE f.vendor_id = $1
          GROUP BY f.order_id, f.vendor_id, f.status, o.payment_status, o.payment_method, o.delivery_address,
            o.delivery_province, o.phone_number, o.shipping_provider, o.shipping_payer, o.shipment_carrier, o.shipment_booking_reference,
            o.shipment_tracking_reference, o.shipment_tracking_url, o.shipment_notes, o.shipment_driver_name,
            o.shipment_driver_phone, o.shipment_vehicle_plate, o.shipment_vehicle_description, u.full_name, o.created_at
          ORDER BY o.created_at DESC LIMIT 100`, [vendor.vendor_id])
    ]);
    return res.status(200).json(successResponse(200, 'Vendor dashboard.', { vendor, products: products.rows, orders: orders.rows }));
  } catch (error) {
    return next(error);
  }
});

app.post('/api/vendor/products', authenticateToken, requireRole('vendor'), requireActiveVendor, parseProductImageUpload, async function (req, res, next) {
  const body = req.body || {};
  const name = normalizeString(body.name);
  const category = normalizeString(body.category);
  const deliveryType = normalizeString(body.deliveryType);
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const condition = normalizeString(body.condition);
  const priceUnit = normalizeString(body.priceUnit);
  const deliveryNotes = body.deliveryNotes === undefined ? '' : body.deliveryNotes;
  const province = normalizeProvince(body.province || req.vendor.province);
  const additionalDetails = normalizeProductAdditionalDetails(body, true);
  const deliveryContacts = normalizeProductDeliveryContacts(body.deliveryContacts, true);
  const price = Number(body.priceKina);
  const stock = Number(body.stockQuantity);
  const imageFormat = req.file ? getProductImageFormat(req.file.buffer) : null;
  if (req.file && !imageFormat) {
    return res.status(400).json(errorResponse(400, 'invalid_product_image', 'Upload a valid JPEG, PNG, or WebP image.'));
  }
  const imageUrl = req.file
    ? `/uploads/products/${crypto.randomUUID()}${imageFormat.extension}`
    : (body.imageUrl === undefined ? '' : body.imageUrl);
  if (name.length < 2 || name.length > 180 || !category || category.length > 80 ||
      !PRODUCT_DELIVERY_TYPES.has(deliveryType) ||
      description.length < 20 || description.length > 5000 ||
      !additionalDetails ||
      !deliveryContacts || deliveryContacts.length > 1 ||
      deliveryContacts.some(function (contact) { return contact.province !== province; }) ||
      (deliveryType !== 'pickup' && !deliveryContacts.length) ||
      !['new', 'used', 'refurbished'].includes(condition) ||
      priceUnit.length < 1 || priceUnit.length > 40 ||
      typeof deliveryNotes !== 'string' || deliveryNotes.length > 500 ||
      !province || !Number.isFinite(price) || price <= 0 || price > 10000000 || Math.round(price * 100) / 100 !== price ||
      !Number.isInteger(stock) || stock < 0 || stock > 1000000 ||
      typeof imageUrl !== 'string' ||
      (imageUrl && !validProductImageUrl(imageUrl))) {
    return res.status(400).json(errorResponse(400, 'invalid_product', 'Provide valid product details and a local driver/skipper contact for delivery listings. Pickup-only listings do not need a local contact.'));
  }
  const imagePath = req.file ? path.join(uploadsRoot, 'products', path.basename(imageUrl)) : null;
  try {
    if (req.file) {
      await fs.mkdir(path.dirname(imagePath), { recursive: true });
      await fs.writeFile(imagePath, req.file.buffer, { flag: 'wx' });
    }
    const result = await query(
      `INSERT INTO products (vendor_id, product_name, description, category, province, delivery_type, item_condition, price_unit, delivery_notes, additional_details, delivery_contacts, price_kina, stock_quantity, image_url, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, NULLIF($14, ''), $15)
       RETURNING product_id, product_name, description, category, province, delivery_type, item_condition, price_unit, delivery_notes, additional_details, delivery_contacts, price_kina, stock_quantity, status`,
      [req.vendor.vendor_id, name, description, category, province, deliveryType, condition, priceUnit, deliveryNotes.trim(), JSON.stringify(additionalDetails), JSON.stringify(deliveryContacts), price, stock, imageUrl, stock ? 'listed' : 'out_of_stock']
    );
    return res.status(201).json(successResponse(201, 'Product created.', { product: result.rows[0] }));
  } catch (error) {
    if (imagePath) await fs.unlink(imagePath).catch(function () {});
    return next(error);
  }
});

app.patch('/api/vendor/products/:productId', authenticateToken, requireRole('vendor'), requireActiveVendor, parseProductImageUpload, async function (req, res, next) {
  const id = parsePositiveId(req.params.productId);
  if (!id) return res.status(400).json(errorResponse(400, 'invalid_product', 'Product ID is invalid.'));
  const body = req.body || {};
  const additionalDetails = normalizeProductAdditionalDetails(body, false);
  const hasDeliveryContacts = Object.prototype.hasOwnProperty.call(body, 'deliveryContacts');
  const deliveryContacts = hasDeliveryContacts ? normalizeProductDeliveryContacts(body.deliveryContacts, true) : [];
  if (!additionalDetails || (hasDeliveryContacts && (!deliveryContacts || deliveryContacts.length > 1))) {
    return res.status(400).json(errorResponse(400, 'invalid_product', 'Product specifications and delivery details must be text no longer than 500 characters.'));
  }
  const imageFormat = req.file ? getProductImageFormat(req.file.buffer) : null;
  if (req.file && !imageFormat) {
    return res.status(400).json(errorResponse(400, 'invalid_product_image', 'Upload a valid JPEG, PNG, or WebP image.'));
  }
  const imagePath = req.file
    ? `/uploads/products/${crypto.randomUUID()}${imageFormat.extension}`
    : null;
  if (imagePath) body.imageUrl = imagePath;
  const columns = { name: 'product_name', description: 'description', category: 'category', province: 'province', deliveryType: 'delivery_type', condition: 'item_condition', priceUnit: 'price_unit', deliveryNotes: 'delivery_notes', priceKina: 'price_kina', stockQuantity: 'stock_quantity', imageUrl: 'image_url', status: 'status' };
  const fields = [];
  const values = [id, req.vendor.vendor_id];
  for (const key of Object.keys(columns)) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    let value = body[key];
    if (key === 'province') value = normalizeProvince(value);
    if ((key === 'name' && (typeof value !== 'string' || value.trim().length < 2 || value.trim().length > 180)) ||
        (key === 'description' && (typeof value !== 'string' || value.trim().length < 20 || value.trim().length > 5000)) ||
        (key === 'category' && (typeof value !== 'string' || !value.trim() || value.length > 80)) ||
        (key === 'province' && !value) ||
        (key === 'deliveryType' && !PRODUCT_DELIVERY_TYPES.has(value)) ||
        (key === 'condition' && !['new', 'used', 'refurbished'].includes(value)) ||
        (key === 'priceUnit' && (typeof value !== 'string' || !value.trim() || value.trim().length > 40)) ||
        (key === 'deliveryNotes' && (typeof value !== 'string' || value.length > 500)) ||
        (key === 'priceKina' && (!Number.isFinite(Number(value)) || Number(value) <= 0 || Number(value) > 10000000 || Math.round(Number(value) * 100) / 100 !== Number(value))) ||
        (key === 'stockQuantity' && (!Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > 1000000)) ||
        (key === 'imageUrl' && value && (typeof value !== 'string' || !validProductImageUrl(value))) ||
        (key === 'status' && !['listed', 'paused', 'out_of_stock'].includes(value))) {
      return res.status(400).json(errorResponse(400, 'invalid_product', 'One or more product fields are invalid.'));
    }
    if (key === 'priceKina' || key === 'stockQuantity') value = Number(value);
    if (typeof value === 'string') value = value.trim();
    values.push(value);
    fields.push(`${columns[key]} = $${values.length}`);
  }
  if (Object.keys(additionalDetails).length) {
    values.push(JSON.stringify(additionalDetails));
    fields.push(`additional_details = additional_details || $${values.length}::jsonb`);
  }
  if (hasDeliveryContacts) {
    values.push(JSON.stringify(deliveryContacts));
    fields.push(`delivery_contacts = $${values.length}::jsonb`);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'stockQuantity') && !Object.prototype.hasOwnProperty.call(body, 'status')) {
    const stockValueIndex = values.length + 1;
    values.push(Number(body.stockQuantity));
    fields.push(`status = CASE WHEN $${stockValueIndex} = 0 THEN 'out_of_stock' WHEN status = 'out_of_stock' THEN 'listed' ELSE status END`);
  }
  if (!fields.length) return res.status(400).json(errorResponse(400, 'empty_update', 'Provide at least one field to update.'));
  fields.push('updated_at = NOW()');
  let client;
  const storedImagePath = imagePath ? path.join(uploadsRoot, 'products', path.basename(imagePath)) : null;
  try {
    if (req.file) {
      await fs.mkdir(path.dirname(storedImagePath), { recursive: true });
      await fs.writeFile(storedImagePath, req.file.buffer, { flag: 'wx' });
    }
    client = await pool.connect();
    await client.query('BEGIN');
    const current = await client.query(
      'SELECT stock_quantity, province, delivery_type, delivery_contacts FROM products WHERE product_id = $1 AND vendor_id = $2 FOR UPDATE',
      [id, req.vendor.vendor_id]
    );
    if (!current.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json(errorResponse(404, 'product_not_found', 'Product was not found for this vendor.'));
    }
    const updatedProvince = Object.prototype.hasOwnProperty.call(body, 'province')
      ? normalizeProvince(body.province)
      : current.rows[0].province;
    const updatedDeliveryType = Object.prototype.hasOwnProperty.call(body, 'deliveryType')
      ? body.deliveryType
      : current.rows[0].delivery_type;
    let updatedDeliveryContacts = hasDeliveryContacts
      ? deliveryContacts
      : current.rows[0].delivery_contacts;
    if (updatedProvince !== current.rows[0].province && !hasDeliveryContacts) {
      updatedDeliveryContacts = [];
      values.push(JSON.stringify(updatedDeliveryContacts));
      fields.push(`delivery_contacts = $${values.length}::jsonb`);
    }
    if (updatedDeliveryContacts.some(function (contact) {
      return contact.province !== updatedProvince;
    })) {
      await client.query('ROLLBACK');
      return res.status(400).json(errorResponse(400, 'invalid_product', 'A local driver/skipper contact must match the product province.'));
    }
    if (updatedDeliveryType !== 'pickup' && !updatedDeliveryContacts.length) {
      await client.query('ROLLBACK');
      return res.status(400).json(errorResponse(400, 'invalid_product', 'Delivery listings need a local driver/skipper contact for the product province.'));
    }
    const availableStock = Object.prototype.hasOwnProperty.call(body, 'stockQuantity')
      ? Number(body.stockQuantity)
      : Number(current.rows[0].stock_quantity);
    if (body.status === 'listed' && availableStock < 1) {
      await client.query('ROLLBACK');
      return res.status(400).json(errorResponse(400, 'invalid_product', 'A product needs available stock before it can be listed.'));
    }
    const reserved = await client.query(
      `SELECT COALESCE(SUM(quantity), 0) AS quantity FROM inventory_reservations
        WHERE product_id = $1 AND status = 'reserved' AND expires_at > clock_timestamp()`,
      [id]
    );
    if (availableStock < Number(reserved.rows[0].quantity)) {
      await client.query('ROLLBACK');
      return res.status(409).json(errorResponse(409, 'stock_reserved', 'Stock cannot be reduced below the quantity reserved for pending orders.'));
    }
    const result = await client.query(
      `UPDATE products SET ${fields.join(', ')} WHERE product_id = $1 AND vendor_id = $2
       RETURNING product_id, product_name, description, category, province, delivery_type, item_condition, price_unit, delivery_notes, additional_details, delivery_contacts, price_kina, stock_quantity, status`, values
    );
    await client.query('COMMIT');
    return res.status(200).json(successResponse(200, 'Product updated.', { product: result.rows[0] }));
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    if (storedImagePath) await fs.unlink(storedImagePath).catch(function () {});
    return next(error);
  } finally {
    if (client) client.release();
  }
});

function validImageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch (error) {
    return false;
  }
}

app.delete('/api/vendor/products/:productId', authenticateToken, requireRole('vendor'), requireActiveVendor, async function (req, res, next) {
  const id = parsePositiveId(req.params.productId);
  if (!id) return res.status(400).json(errorResponse(400, 'invalid_product', 'Product ID is invalid.'));
  try {
    const result = await query(
      'DELETE FROM products WHERE product_id = $1 AND vendor_id = $2 RETURNING product_id',
      [id, req.vendor.vendor_id]
    );
    if (!result.rows[0]) return res.status(404).json(errorResponse(404, 'product_not_found', 'Product was not found for this vendor.'));
    return res.status(200).json(successResponse(200, 'Product deleted.'));
  } catch (error) {
    if (error.code === '23503') return res.status(409).json(errorResponse(409, 'product_has_orders', 'This product is part of an order and cannot be deleted. Pause its listing instead.'));
    return next(error);
  }
});

app.get('/api/cart', authenticateToken, async function (req, res, next) {
  try {
    const result = await query(
      `SELECT c.product_id, c.quantity, p.product_name, p.price_kina, ${availableStockSql('p')} AS stock_quantity, p.image_url, p.province, p.delivery_type,
              EXISTS (
                SELECT 1 FROM jsonb_array_elements(p.delivery_contacts) AS contact
                 WHERE contact->>'province' = p.province
              ) AS local_delivery_available,
              v.vendor_id, v.business_name, v.payment_methods,
              p.status AS product_status, v.status AS vendor_status,
              (p.status = 'listed' AND ${availableStockSql('p')} > 0 AND v.status = 'active' AND c.quantity <= ${availableStockSql('p')}) AS available
         FROM cart_items c JOIN products p ON p.product_id = c.product_id
         JOIN vendors v ON v.vendor_id = p.vendor_id
        WHERE c.user_id = $1 ORDER BY c.created_at`, [req.user.user_id]
    );
    return res.status(200).json(successResponse(200, 'Cart.', { items: result.rows }));
  } catch (error) {
    return next(error);
  }
});

app.put('/api/cart/items/:productId', authenticateToken, async function (req, res, next) {
  const id = parsePositiveId(req.params.productId);
  const quantity = Number(req.body && req.body.quantity);
  if (!id || !Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
    return res.status(400).json(errorResponse(400, 'invalid_cart_item', 'Product ID and quantity must be valid.'));
  }
  try {
    const result = await query(
      `INSERT INTO cart_items (user_id, product_id, quantity)
       SELECT $1, p.product_id, $3 FROM products p
        JOIN vendors v ON v.vendor_id = p.vendor_id
        WHERE p.product_id = $2 AND p.status = 'listed' AND v.status = 'active' AND ${availableStockSql('p')} >= $3::integer
       ON CONFLICT (user_id, product_id) DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = NOW()
       RETURNING product_id, quantity`, [req.user.user_id, id, quantity]
    );
    if (!result.rows[0]) return res.status(409).json(errorResponse(409, 'insufficient_stock', 'Product is unavailable or the quantity exceeds stock.'));
    return res.status(200).json(successResponse(200, 'Cart updated.', { item: result.rows[0] }));
  } catch (error) {
    return next(error);
  }
});

app.post('/api/cart/items/:productId', authenticateToken, async function (req, res, next) {
  const id = parsePositiveId(req.params.productId);
  const quantity = req.body && req.body.quantity !== undefined ? Number(req.body.quantity) : 1;
  if (!id || !Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
    return res.status(400).json(errorResponse(400, 'invalid_cart_item', 'Product ID and quantity must be valid.'));
  }
  try {
    const result = await query(
      `INSERT INTO cart_items (user_id, product_id, quantity)
       SELECT $1, p.product_id, $3 FROM products p JOIN vendors v ON v.vendor_id = p.vendor_id
        WHERE p.product_id = $2 AND p.status = 'listed' AND v.status = 'active' AND ${availableStockSql('p')} >= $3::integer
       ON CONFLICT (user_id, product_id) DO UPDATE
         SET quantity = cart_items.quantity + EXCLUDED.quantity, updated_at = NOW()
       WHERE EXISTS (
         SELECT 1 FROM products p JOIN vendors v ON v.vendor_id = p.vendor_id
          WHERE p.product_id = EXCLUDED.product_id AND p.status = 'listed' AND v.status = 'active'
            AND ${availableStockSql('p')} >= (cart_items.quantity + EXCLUDED.quantity)::numeric
       )
       RETURNING product_id, quantity`, [req.user.user_id, id, quantity]
    );
    if (!result.rows[0]) return res.status(409).json(errorResponse(409, 'insufficient_stock', 'Product is unavailable or the requested quantity exceeds stock.'));
    return res.status(200).json(successResponse(200, 'Cart updated.', { item: result.rows[0] }));
  } catch (error) {
    return next(error);
  }
});

app.delete('/api/cart/items/:productId', authenticateToken, async function (req, res, next) {
  const productId = parsePositiveId(req.params.productId);
  if (!productId) return res.status(400).json(errorResponse(400, 'invalid_product', 'Product ID is invalid.'));
  try {
    await query('DELETE FROM cart_items WHERE user_id = $1 AND product_id = $2', [req.user.user_id, productId]);
    return res.status(200).json(successResponse(200, 'Cart item removed.'));
  } catch (error) {
    return next(error);
  }
});

app.post('/api/freight/estimate', async function (req, res, next) {
  const body = req.body || {};
  const origins = body.originProvinces === undefined ? [body.originProvince] : body.originProvinces;
  const normalizedOrigins = Array.isArray(origins)
    ? Array.from(new Set(origins.map(normalizeProvince).filter(Boolean)))
    : [];
  const destination = normalizeProvince(body.destinationProvince);
  const provider = normalizeString(body.provider);
  if (!normalizedOrigins.length || (Array.isArray(origins) && normalizedOrigins.length !== new Set(origins).size) ||
      !destination || !SHIPPING_PROVIDERS.has(provider)) {
    return res.status(400).json(errorResponse(400, 'invalid_freight_request', 'Choose valid origin, destination, and provider values.'));
  }
  const localRoute = normalizedOrigins.every(function (origin) { return origin === destination; });
  const interprovinceRoute = normalizedOrigins.every(function (origin) { return origin !== destination; });
  if ((!localRoute && !interprovinceRoute) ||
      normalizedOrigins.some(function (origin) { return !isShippingProviderValidForRoute(provider, origin, destination); })) {
    return res.status(409).json(errorResponse(409, 'delivery_route_unavailable',
      localRoute
        ? 'Choose PMV or pickup for delivery within the same province.'
        : interprovinceRoute
          ? 'Choose ship or air freight for delivery between provinces.'
          : 'This estimate includes both local and inter-province routes. Request separate delivery estimates.'));
  }
  try {
    const rates = [];
    for (const origin of normalizedOrigins) {
      const rate = await findFreightRate(pool, origin, destination, provider);
      if (!rate) {
        return res.status(503).json(errorResponse(503, 'freight_not_configured', `No delivery rate is configured from ${origin} to ${destination} for ${provider}.`));
      }
      rates.push({ originProvince: origin, amountKina: rate.amount, isEstimate: rate.isEstimate });
    }
    const amountKina = rates.reduce(function (sum, rate) { return sum + Math.round(rate.amountKina * 100); }, 0) / 100;
    return res.status(200).json(successResponse(200, 'Configured delivery estimate.', {
      originProvinces: normalizedOrigins, destinationProvince: destination, provider,
      rates, amountKina, isEstimate: rates.some(function (rate) { return rate.isEstimate; }), currency: 'PGK'
    }));
  } catch (error) {
    return next(error);
  }
});

app.post('/api/admin/payments/:paymentId/verify', authenticateToken, requireRole('admin'), async function (req, res, next) {
  const paymentId = parsePositiveId(req.params.paymentId);
  const body = req.body || {};
  const status = normalizeString(body.status);
  const verificationReference = normalizeString(body.verificationReference);
  const failureReason = normalizeString(body.failureReason);
  if (!paymentId || !['successful', 'failed'].includes(status) ||
      (status === 'successful' && (verificationReference.length < 1 || verificationReference.length > 120 || /[\u0000-\u001f\u007f]/.test(verificationReference))) ||
      (status === 'failed' && (failureReason.length < 3 || failureReason.length > 500))) {
    return res.status(400).json(errorResponse(400, 'invalid_payment_verification', 'Provide a valid payment ID and either a verified receipt reference or a failure reason.'));
  }
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await expirePaymentReservations(client);
    const selected = await client.query(
      `SELECT pay.payment_id, pay.order_id, pay.provider, pay.mode, pay.status, pay.expires_at, pay.amount_kina,
              pay.verified_by, (pay.expires_at IS NULL OR pay.expires_at > clock_timestamp()) AS reservation_active,
              o.payment_method, o.payment_status, o.order_status, o.total_kina
         FROM orders o JOIN payments pay ON pay.order_id = o.order_id
        WHERE pay.payment_id = $1 FOR UPDATE OF o, pay`,
      [paymentId]
    );
    const payment = selected.rows[0];
    if (!payment) {
      await client.query('ROLLBACK');
      return res.status(404).json(errorResponse(404, 'payment_not_found', 'Payment was not found.'));
    }
    if (payment.mode !== 'manual' || !MANUAL_PAYMENT_METHODS.has(payment.payment_method)) {
      await client.query('ROLLBACK');
      return res.status(409).json(errorResponse(409, 'payment_not_manually_verifiable', 'Only configured manual payment methods can be verified here.'));
    }
    if (status === 'failed' && payment.order_status === 'delivered') {
      await client.query('ROLLBACK');
      return res.status(409).json(errorResponse(409, 'delivered_order_payment_review', 'Delivered orders require a separate payment-recovery process; they cannot be marked failed here.'));
    }
    if (payment.status !== 'pending') {
      if (payment.status === status && payment.verified_by === req.user.user_id) {
        await client.query('COMMIT');
        return res.status(200).json(successResponse(200, 'This manual payment verification was already recorded.', {
          payment: { payment_id: payment.payment_id, order_id: payment.order_id, status: payment.status }
        }));
      }
      await client.query('ROLLBACK');
      return res.status(409).json(errorResponse(409, 'payment_already_final', 'This payment is no longer pending and cannot be changed.'));
    }
    if (!payment.reservation_active) {
      await expirePaymentReservations(client);
      await client.query('COMMIT');
      return res.status(409).json(errorResponse(409, 'payment_expired', 'The order reservation has expired; create a new order.'));
    }

    if (status === 'successful') {
      if (Number(payment.amount_kina) !== Number(payment.total_kina)) {
        await client.query('ROLLBACK');
        return res.status(409).json(errorResponse(409, 'payment_amount_mismatch', 'The stored payment amount does not match the order total; escalate for reconciliation.'));
      }
      const duplicateReference = await client.query(
        `SELECT payment_id FROM payments
          WHERE provider = $1 AND provider_reference = $2 AND payment_id <> $3`,
        [payment.provider, verificationReference, payment.payment_id]
      );
      if (duplicateReference.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json(errorResponse(409, 'duplicate_payment_reference', 'This receipt reference is already recorded.'));
      }
      const reservations = await client.query(
        `SELECT product_id, quantity FROM inventory_reservations
          WHERE order_id = $1 AND status = 'reserved' AND expires_at > clock_timestamp()
          ORDER BY product_id FOR UPDATE`,
        [payment.order_id]
      );
      if (!reservations.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json(errorResponse(409, 'reservation_missing', 'The order no longer has an active stock reservation.'));
      }
      for (const reservation of reservations.rows) {
        const product = await client.query(
          'SELECT stock_quantity FROM products WHERE product_id = $1 FOR UPDATE',
          [reservation.product_id]
        );
        if (!product.rows[0] || Number(product.rows[0].stock_quantity) < Number(reservation.quantity)) {
          await client.query('ROLLBACK');
          return res.status(409).json(errorResponse(409, 'reserved_stock_unavailable', 'Reserved stock is no longer available for fulfillment.'));
        }
        await client.query(
          `UPDATE products SET stock_quantity = stock_quantity - $1,
             status = CASE WHEN stock_quantity - $1 = 0 THEN 'out_of_stock' ELSE status END,
             updated_at = NOW()
           WHERE product_id = $2`,
          [reservation.quantity, reservation.product_id]
        );
      }
      await client.query(
        `UPDATE inventory_reservations SET status = 'consumed', updated_at = NOW()
          WHERE order_id = $1 AND status = 'reserved'`,
        [payment.order_id]
      );
    } else {
      await client.query(
        `UPDATE inventory_reservations SET status = 'released', updated_at = NOW()
          WHERE order_id = $1 AND status = 'reserved'`,
        [payment.order_id]
      );
    }
    const updated = await client.query(
      `UPDATE payments SET status = $1, provider_reference = $2, verified_by = $3,
              verified_at = NOW(), updated_at = NOW()
        WHERE payment_id = $4 AND status = 'pending'
       RETURNING payment_id, order_id, status`,
      [status, status === 'successful' ? verificationReference : null, req.user.user_id, payment.payment_id]
    );
    await client.query(
      `UPDATE orders SET payment_status = $1,
              order_status = CASE WHEN $2 THEN 'cancelled' ELSE order_status END,
              updated_at = NOW()
        WHERE order_id = $3`,
      [status, status === 'failed', payment.order_id]
    );
    await recordAdminAction(client, req.user.user_id, `payment.${status}`, 'payment', payment.payment_id, {
      orderId: String(payment.order_id),
      amountKina: Number(payment.total_kina),
      currency: 'PGK',
      reason: status === 'failed' ? failureReason : 'Receipt manually verified'
    });
    await client.query('COMMIT');
    return res.status(200).json(successResponse(200, `Manual payment marked ${status} by an administrator.`, {
      payment: updated.rows[0]
    }));
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    if (error.code === '23505') {
      return res.status(409).json(errorResponse(409, 'duplicate_payment_reference', 'This receipt reference is already recorded.'));
    }
    return next(error);
  } finally {
    if (client) client.release();
  }
});

app.post('/api/orders', authenticateToken, async function (req, res, next) {
  const body = req.body || {};
  const idempotencyKey = normalizeString(req.get('Idempotency-Key')).toLowerCase();
  const destination = normalizeProvince(body.deliveryProvince);
  const address = normalizeString(body.deliveryAddress);
  const phone = normalizePhoneNumber(body.phoneNumber);
  const provider = normalizeString(body.shippingProvider);
  const shippingPayer = normalizeString(body.shippingPayer || 'buyer').toLowerCase();
  const paymentMethodId = normalizeString(body.paymentMethod);
  let paymentMethod;
  try {
    paymentMethod = getPaymentConfiguration().methods.find(function (method) { return method.id === paymentMethodId; });
  } catch (error) {
    return next(error);
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(idempotencyKey) ||
      !destination || address.length < 5 || address.length > 500 || !/^\+675[78]\d{7}$/.test(phone) ||
      !SHIPPING_PROVIDERS.has(provider) || !['buyer', 'vendor'].includes(shippingPayer) || !paymentMethod) {
    return res.status(400).json(errorResponse(400, 'invalid_checkout', 'A valid idempotency key, delivery details, PNG phone number, shipping provider, and supported payment mode are required.'));
  }
  const fingerprint = checkoutFingerprint({
    deliveryProvince: destination,
    deliveryAddress: address,
    phoneNumber: phone,
    shippingProvider: provider,
    shippingPayer: shippingPayer,
    paymentMethod: paymentMethod.id
  });
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await expirePaymentReservations(client);
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`${req.user.user_id}:${idempotencyKey}`]
    );
    const previousOrder = await client.query(
      `SELECT order_id, subtotal_kina, shipping_kina, total_kina, payment_status,
              order_status, freight_is_estimate, shipping_payer, created_at, checkout_fingerprint
         FROM orders WHERE buyer_id = $1 AND idempotency_key = $2`,
      [req.user.user_id, idempotencyKey]
    );
    if (previousOrder.rows[0]) {
      if (previousOrder.rows[0].checkout_fingerprint !== fingerprint) {
        await client.query('ROLLBACK');
        return res.status(409).json(errorResponse(409, 'idempotency_key_reused', 'This checkout key was already used with different delivery or payment details. Start a new checkout attempt.'));
      }
      const order = previousOrder.rows[0];
      delete order.checkout_fingerprint;
      await client.query('COMMIT');
      return res.status(200).json(successResponse(200, 'Previously created order returned for this checkout attempt.', {
        order, paymentMode: paymentMethod.mode, paymentStatus: order.payment_status
      }));
    }

    await lockCheckoutCart(client, req.user.user_id);
    const cart = await client.query(
      `SELECT ci.product_id, ci.quantity, p.product_name, p.price_kina, p.stock_quantity, p.delivery_type, p.status AS product_status,
              ${availableStockSql('p')} AS available_stock, v.status AS vendor_status,
             p.province AS seller_province, p.vendor_id, v.payment_methods, p.delivery_contacts
         FROM cart_items ci JOIN products p ON p.product_id = ci.product_id
         JOIN vendors v ON v.vendor_id = p.vendor_id
        WHERE ci.user_id = $1
        ORDER BY ci.product_id FOR UPDATE OF ci, p, v`, [req.user.user_id]
    );
    if (!cart.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json(errorResponse(409, 'empty_cart', 'Your cart has no available products.'));
    }
    const vendorIds = new Set(cart.rows.map(function (item) { return String(item.vendor_id); }));
    if (vendorIds.size !== 1) {
      await client.query('ROLLBACK');
      return res.status(409).json(errorResponse(409, 'split_checkout_required', 'This cart contains multiple businesses. Use the vendor-specific checkout flow to create separate orders.'));
    }
    const selectedVendorMethod = (Array.isArray(cart.rows[0].payment_methods) ? cart.rows[0].payment_methods : [])
      .find(function (method) {
        return method && VENDOR_PAYMENT_METHODS[method.id] &&
          VENDOR_PAYMENT_METHODS[method.id].databaseMethod === paymentMethod.databaseMethod &&
          typeof method.instructions === 'string' && method.instructions.trim().length >= 5 &&
          method.instructions.length <= 1000 && !/[\u0000-\u001f\u007f]/.test(method.instructions);
      });
    if (paymentMethod.mode !== 'sandbox' && !selectedVendorMethod) {
      await client.query('ROLLBACK');
      return res.status(409).json(errorResponse(409, 'vendor_payment_method_unavailable', 'This business does not accept the selected payment method. Reload checkout and choose one of its configured options.'));
    }
    for (const item of cart.rows) {
      if (item.product_status !== 'listed' || item.vendor_status !== 'active' || item.available_stock < 1) {
        await client.query('ROLLBACK');
        return res.status(409).json(errorResponse(409, 'product_unavailable', `A product in your cart is no longer available. Remove it before checkout.`));
      }
      if (item.quantity > item.available_stock) {
        await client.query('ROLLBACK');
        return res.status(409).json(errorResponse(409, 'insufficient_stock', `Not enough stock for ${item.product_name}.`));
      }
      if (item.delivery_type !== 'both' &&
          (provider === 'Pickup' ? item.delivery_type !== 'pickup' : item.delivery_type !== 'delivery')) {
        await client.query('ROLLBACK');
        return res.status(409).json(errorResponse(409, 'delivery_method_unavailable', `The selected delivery method is not available for ${item.product_name}. Reload checkout and choose a supported method.`));
      }
      const isLocalRoute = item.seller_province === destination;
      if (!isShippingProviderValidForRoute(provider, item.seller_province, destination)) {
        await client.query('ROLLBACK');
        return res.status(409).json(errorResponse(409, 'delivery_route_unavailable',
          isLocalRoute
            ? `${item.product_name} is in ${destination}. Choose local PMV delivery or pickup.`
            : `${item.product_name} is coming from ${item.seller_province}. Choose ship or air freight for delivery to ${destination}.`));
      }
      item.delivery_contact = null;
      if (isLocalRoute && provider !== 'Pickup') {
        const contacts = Array.isArray(item.delivery_contacts) ? item.delivery_contacts : [];
        item.delivery_contact = contacts.find(function (contact) {
          return contact && contact.province === item.seller_province;
        }) || null;
        if (!item.delivery_contact) {
          await client.query('ROLLBACK');
          return res.status(409).json(errorResponse(409, 'delivery_contact_unavailable',
            `${item.product_name} has no local driver/skipper contact configured for ${item.seller_province}. Ask the vendor to add one or choose pickup.`));
        }
      }
    }
    let freightCents = 0;
    let allEstimates = true;
    const sellerProvinces = new Set(cart.rows.map(function (item) { return item.seller_province; }));
    for (const origin of sellerProvinces) {
      const rate = await findFreightRate(client, origin, destination, provider);
      if (!rate) {
        await client.query('ROLLBACK');
        return res.status(503).json(errorResponse(503, 'freight_not_configured', `Delivery estimate is not configured from ${origin} to ${destination}.`));
      }
      freightCents += Math.round(rate.amount * 100);
      allEstimates = allEstimates && rate.isEstimate;
    }
    const subtotalCents = cart.rows.reduce(function (sum, item) {
      return sum + Math.round(Number(item.price_kina) * 100) * item.quantity;
    }, 0);
    const subtotal = subtotalCents / 100;
    const shipping = freightCents / 100;
    const total = (subtotalCents + (shippingPayer === 'buyer' ? freightCents : 0)) / 100;
    const inserted = await client.query(
      `INSERT INTO orders (buyer_id, delivery_address, delivery_province, phone_number,
          subtotal_kina, shipping_kina, total_kina, shipping_provider, payment_method, shipping_payer,
          payment_instructions, freight_is_estimate, idempotency_key, checkout_fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING order_id, subtotal_kina, shipping_kina, total_kina, payment_status, order_status, freight_is_estimate, shipping_payer, created_at`,
      [req.user.user_id, address, destination, phone, subtotal, shipping, total, provider, paymentMethod.databaseMethod,
        shippingPayer, selectedVendorMethod ? selectedVendorMethod.instructions : null, allEstimates, idempotencyKey, fingerprint]
    );
    const order = inserted.rows[0];
    const reservationExpiry = await client.query(
      `SELECT clock_timestamp() + ($1::integer * INTERVAL '1 minute') AS expires_at`,
      [paymentMethod.reservationMinutes]
    );
    for (const item of cart.rows) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, vendor_id, product_name, seller_province, unit_price_kina, quantity, delivery_contact)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [order.order_id, item.product_id, item.vendor_id, item.product_name, item.seller_province,
          item.price_kina, item.quantity, item.delivery_contact ? JSON.stringify(item.delivery_contact) : null]
      );
      await client.query(
        `INSERT INTO inventory_reservations (order_id, product_id, quantity, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [order.order_id, item.product_id, item.quantity, reservationExpiry.rows[0].expires_at]
      );
    }
    for (const vendorId of new Set(cart.rows.map(function (item) { return String(item.vendor_id); }))) {
      await client.query(
        "INSERT INTO vendor_order_fulfillments (order_id, vendor_id, status) VALUES ($1, $2, 'pending')",
        [order.order_id, vendorId]
      );
    }
    await client.query(
      `INSERT INTO payments (order_id, provider, mode, status, transaction_reference, amount_kina, expires_at)
       VALUES ($1, $2, $3, 'pending', $4, $5, $6)`,
      [order.order_id, paymentMethod.id, paymentMethod.mode, `KM-ORDER-${crypto.randomUUID()}`, total, reservationExpiry.rows[0].expires_at]
    );
    await client.query('DELETE FROM cart_items WHERE user_id = $1', [req.user.user_id]);
    await client.query('COMMIT');
    order.expires_at = reservationExpiry.rows[0].expires_at;
    return res.status(201).json(successResponse(201, paymentMethod.mode === 'manual'
      ? 'Order reserved. Payment remains pending until an administrator verifies receipt.'
      : 'Test order reserved. No money is charged or verified.', {
      order, paymentMode: paymentMethod.mode, paymentStatus: 'pending'
    }));
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    return next(error);
  } finally {
    if (client) client.release();
  }
});

app.post('/api/orders/:orderId/cancel', authenticateToken, async function (req, res, next) {
  const orderId = parsePositiveId(req.params.orderId);
  if (!orderId) return res.status(400).json(errorResponse(400, 'invalid_order', 'Order ID is invalid.'));
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await expirePaymentReservations(client);
    const orderResult = await client.query(
      `SELECT o.order_id, o.order_status, pay.status AS payment_status
         FROM orders o JOIN payments pay ON pay.order_id = o.order_id
        WHERE o.order_id = $1 AND o.buyer_id = $2
        FOR UPDATE OF o, pay`,
      [orderId, req.user.user_id]
    );
    if (!orderResult.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json(errorResponse(404, 'order_not_found', 'Order was not found.'));
    }
    if (orderResult.rows[0].payment_status !== 'pending' || orderResult.rows[0].order_status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json(errorResponse(409, 'order_not_cancellable', 'Only unpaid pending orders can be cancelled.'));
    }
    await client.query(
      `UPDATE payments SET status = 'cancelled', updated_at = NOW()
        WHERE order_id = $1 AND status = 'pending'`,
      [orderId]
    );
    await client.query(
      `UPDATE inventory_reservations SET status = 'released', updated_at = NOW()
        WHERE order_id = $1 AND status = 'reserved'`,
      [orderId]
    );
    await client.query(
      `UPDATE orders SET payment_status = 'cancelled', order_status = 'cancelled', updated_at = NOW()
        WHERE order_id = $1`,
      [orderId]
    );
    await client.query('COMMIT');
    return res.status(200).json(successResponse(200, 'Pending order cancelled and reserved stock released.', {
      orderId, paymentStatus: 'cancelled'
    }));
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    return next(error);
  } finally {
    if (client) client.release();
  }
});

app.get('/api/orders', authenticateToken, async function (req, res, next) {
  try {
    await expirePaymentReservations(pool);
    const result = await query(
            `SELECT o.order_id, o.subtotal_kina, o.shipping_kina, o.total_kina, o.payment_status,
              o.payment_method, o.order_status, o.delivery_province, o.shipping_payer, o.created_at,
              COALESCE((SELECT SUM(r.amount_kina) FROM order_refunds r WHERE r.order_id = o.order_id), 0) AS refunded_kina,
              EXISTS (SELECT 1 FROM vendor_payment_verifications vpv
                       WHERE vpv.order_id = o.order_id AND vpv.status = 'successful') AS vendor_confirmed_receipt,
              COALESCE(json_agg(json_build_object('productId', i.product_id, 'name', i.product_name,
                'quantity', i.quantity, 'unitPriceKina', i.unit_price_kina)) FILTER (WHERE i.order_item_id IS NOT NULL), '[]') AS items
         FROM orders o LEFT JOIN order_items i ON i.order_id = o.order_id
        WHERE o.buyer_id = $1 GROUP BY o.order_id ORDER BY o.created_at DESC LIMIT 100`, [req.user.user_id]
    );
    return res.status(200).json(successResponse(200, 'Order history.', { orders: result.rows }));
  } catch (error) {
    return next(error);
  }
});

app.post('/api/checkout', authenticateToken, async function (req, res, next) {
  const body = req.body || {};
  const idempotencyKey = normalizeString(req.get('Idempotency-Key')).toLowerCase();
  const destination = normalizeProvince(body.deliveryProvince);
  const address = normalizeString(body.deliveryAddress);
  const phone = normalizePhoneNumber(body.phoneNumber);
  const provider = normalizeString(body.shippingProvider);
  const shippingPayer = normalizeString(body.shippingPayer || 'buyer').toLowerCase();
  const selections = body.vendorPaymentMethods;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(idempotencyKey) ||
      !destination || address.length < 5 || address.length > 500 || !/^\+675[78]\d{7}$/.test(phone) ||
      !SHIPPING_PROVIDERS.has(provider) || !['buyer', 'vendor'].includes(shippingPayer) ||
      !Array.isArray(selections) || !selections.length) {
    return res.status(400).json(errorResponse(400, 'invalid_checkout', 'Provide valid delivery details, a shipping provider, and one supported payment method for every vendor in your cart.'));
  }
  const selectedMethods = new Map();
  for (const selection of selections) {
    const vendorId = selection && parsePositiveId(String(selection.vendorId));
    if (!vendorId || typeof selection.methodId !== 'string' ||
        !Object.prototype.hasOwnProperty.call(VENDOR_PAYMENT_METHODS, selection.methodId) ||
        selectedMethods.has(String(vendorId))) {
      return res.status(400).json(errorResponse(400, 'invalid_vendor_payment_selection', 'Each vendor must have exactly one valid payment method selected.'));
    }
    selectedMethods.set(String(vendorId), selection.methodId);
  }
  let configuration;
  try {
    configuration = getPaymentConfiguration();
  } catch (error) {
    return next(error);
  }
  const fingerprint = checkoutFingerprint({
    deliveryProvince: destination,
    deliveryAddress: address,
    phoneNumber: phone,
    shippingProvider: provider,
    shippingPayer: shippingPayer,
    paymentMethod: Array.from(selectedMethods.entries()).sort(function (a, b) {
      return a[0].localeCompare(b[0]);
    })
  });
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await expirePaymentReservations(client);
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`${req.user.user_id}:${idempotencyKey}`]
    );
    const previous = await client.query(
      `SELECT o.order_id, o.subtotal_kina, o.shipping_kina, o.total_kina, o.payment_status,
              o.order_status, o.freight_is_estimate, o.shipping_payer, o.created_at, o.checkout_fingerprint,
              o.payment_method, o.payment_instructions, o.payment_reference_phone, o.payment_reference_whatsapp, f.vendor_id
         FROM orders o
         LEFT JOIN vendor_order_fulfillments f USING (order_id)
        WHERE o.buyer_id = $1 AND o.checkout_group_key = $2
        ORDER BY o.order_id`,
      [req.user.user_id, idempotencyKey]
    );
    if (previous.rows.length) {
      if (previous.rows.length !== selectedMethods.size ||
          previous.rows.some(function (order) {
            const expectedMethod = selectedMethods.get(String(order.vendor_id));
            const actualMethod = Object.keys(VENDOR_PAYMENT_METHODS).find(function (methodId) {
              return VENDOR_PAYMENT_METHODS[methodId].databaseMethod === order.payment_method;
            });
            return order.checkout_fingerprint !== fingerprint || !expectedMethod || expectedMethod !== actualMethod;
          })) {
        await client.query('ROLLBACK');
        return res.status(409).json(errorResponse(409, 'idempotency_key_reused', 'This checkout key was already used with different cart or payment details. Start a new checkout attempt.'));
      }
      const existingCart = await client.query(
        `SELECT ci.product_id, ci.quantity, p.vendor_id, p.price_kina
           FROM cart_items ci JOIN products p ON p.product_id = ci.product_id
          WHERE ci.user_id = $1 ORDER BY p.vendor_id, ci.product_id`,
        [req.user.user_id]
      );
      if (existingCart.rows.length) {
        const orderItems = await client.query(
          `SELECT i.product_id, i.quantity, i.vendor_id, i.unit_price_kina AS price_kina
             FROM order_items i WHERE i.order_id = ANY($1::bigint[])
            ORDER BY i.vendor_id, i.product_id`,
          [previous.rows.map(function (order) { return order.order_id; })]
        );
        const cartSignature = function (items) {
          return JSON.stringify(items.map(function (item) {
            return [String(item.vendor_id), String(item.product_id), Number(item.quantity), Number(item.price_kina)];
          }));
        };
        if (cartSignature(existingCart.rows) !== cartSignature(orderItems.rows)) {
          await client.query('ROLLBACK');
          return res.status(409).json(errorResponse(409, 'idempotency_key_reused', 'This checkout key belongs to a different cart. Start a new checkout attempt.'));
        }
      }
      const orders = previous.rows.map(function (order) {
        delete order.checkout_fingerprint;
        return order;
      });
      await client.query('COMMIT');
      const paymentStatuses = new Set(orders.map(function (order) { return order.payment_status; }));
      return res.status(200).json(successResponse(200, 'Previously created vendor orders returned for this checkout attempt.', {
        orders, paymentMode: 'manual',
        paymentStatus: paymentStatuses.size === 1 ? Array.from(paymentStatuses)[0] : 'mixed'
      }));
    }
    const legacyCheckout = await client.query(
      `SELECT 1 FROM orders
        WHERE buyer_id = $1 AND idempotency_key = $2 AND checkout_group_key IS NULL`,
      [req.user.user_id, idempotencyKey]
    );
    if (legacyCheckout.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json(errorResponse(409, 'idempotency_key_reused', 'This checkout key belongs to an older checkout request. Start a new checkout attempt.'));
    }

    await lockCheckoutCart(client, req.user.user_id);
    const cart = await client.query(
      `SELECT ci.product_id, ci.quantity, p.product_name, p.price_kina, p.stock_quantity, p.delivery_type,
              p.status AS product_status, ${availableStockSql('p')} AS available_stock,
              v.status AS vendor_status, v.vendor_id, v.business_name, v.payment_methods,
              p.province AS seller_province, p.delivery_contacts
         FROM cart_items ci
         JOIN products p ON p.product_id = ci.product_id
         JOIN vendors v ON v.vendor_id = p.vendor_id
        WHERE ci.user_id = $1
        ORDER BY v.vendor_id, p.product_id
        FOR UPDATE OF ci, p, v`,
      [req.user.user_id]
    );
    if (!cart.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json(errorResponse(409, 'empty_cart', 'Your cart has no available products.'));
    }
    const vendorIds = new Set(cart.rows.map(function (item) { return String(item.vendor_id); }));
    if (vendorIds.size !== selectedMethods.size ||
        Array.from(vendorIds).some(function (vendorId) { return !selectedMethods.has(vendorId); })) {
      await client.query('ROLLBACK');
      return res.status(409).json(errorResponse(409, 'vendor_cart_changed', 'The vendors in your cart changed. Reload checkout and select a payment method for each vendor.'));
    }

    const groups = new Map();
    for (const item of cart.rows) {
      const vendorId = String(item.vendor_id);
      if (item.product_status !== 'listed' || item.vendor_status !== 'active' || Number(item.available_stock) < 1) {
        await client.query('ROLLBACK');
        return res.status(409).json(errorResponse(409, 'product_unavailable', 'A product in your cart is no longer available. Remove it before checkout.'));
      }
      if (item.quantity > Number(item.available_stock)) {
        await client.query('ROLLBACK');
        return res.status(409).json(errorResponse(409, 'insufficient_stock', `Not enough stock for ${item.product_name}.`));
      }
      if (item.delivery_type !== 'both' &&
          (provider === 'Pickup' ? item.delivery_type !== 'pickup' : item.delivery_type !== 'delivery')) {
        await client.query('ROLLBACK');
        return res.status(409).json(errorResponse(409, 'delivery_method_unavailable', `The selected delivery method is not available for ${item.product_name}. Reload checkout and choose a supported method.`));
      }
      const isLocalRoute = item.seller_province === destination;
      if (!isShippingProviderValidForRoute(provider, item.seller_province, destination)) {
        await client.query('ROLLBACK');
        return res.status(409).json(errorResponse(409, 'delivery_route_unavailable',
          isLocalRoute
            ? `${item.product_name} is in ${destination}. Choose local PMV delivery or pickup.`
            : `${item.product_name} is coming from ${item.seller_province}. Choose ship or air freight for delivery to ${destination}.`));
      }
      item.delivery_contact = null;
      if (isLocalRoute && provider !== 'Pickup') {
        const contacts = Array.isArray(item.delivery_contacts) ? item.delivery_contacts : [];
        item.delivery_contact = contacts.find(function (contact) {
          return contact && contact.province === item.seller_province;
        }) || null;
        if (!item.delivery_contact) {
          await client.query('ROLLBACK');
          return res.status(409).json(errorResponse(409, 'delivery_contact_unavailable',
            `${item.product_name} has no local driver/skipper contact configured for ${item.seller_province}. Ask the vendor to add one or choose pickup.`));
        }
      }
      const methodId = selectedMethods.get(vendorId);
      const methods = Array.isArray(item.payment_methods) ? item.payment_methods : [];
      const paymentDetails = methods.find(function (method) { return method && method.id === methodId; });
        if (!paymentDetails || typeof paymentDetails.instructions !== 'string' ||
          paymentDetails.instructions.trim().length < 5 || paymentDetails.instructions.length > 1000 ||
          /[\u0000-\u0009\u000b-\u001f\u007f]/.test(paymentDetails.instructions)) {
        await client.query('ROLLBACK');
        return res.status(409).json(errorResponse(409, 'vendor_payment_method_unavailable', `${item.business_name || 'A vendor'} no longer accepts the selected payment method. Reload checkout.`));
      }
      const referencePhone = normalizePhoneNumber(paymentDetails.referencePhone);
      const referenceWhatsapp = normalizePhoneNumber(paymentDetails.referenceWhatsapp);
      const requiresReferenceContact = ['bank_transfer', 'mobile_wallet'].includes(methodId);
      const validPngContact = function (value) { return /^\+675[78]\d{7}$/.test(value); };
      if ((requiresReferenceContact && !referencePhone && !referenceWhatsapp) ||
          (referencePhone && !validPngContact(referencePhone)) ||
          (referenceWhatsapp && !validPngContact(referenceWhatsapp))) {
        await client.query('ROLLBACK');
        return res.status(409).json(errorResponse(409, 'vendor_reference_contact_unavailable', `${item.business_name || 'A vendor'} has not configured a valid PNG phone or WhatsApp number for payment references.`));
      }
      if (!groups.has(vendorId)) {
        groups.set(vendorId, {
          vendorId,
          vendorName: item.business_name,
          methodId,
          paymentInstructions: paymentDetails.instructions,
          paymentReferencePhone: referencePhone,
          paymentReferenceWhatsapp: referenceWhatsapp,
          items: []
        });
      }
      groups.get(vendorId).items.push(item);
    }

    const createdOrders = [];
    const manualMinutes = configuration.methods.find(function (method) { return method.mode === 'manual'; })?.reservationMinutes ||
      Number(process.env.PAYMENT_MANUAL_RESERVATION_MINUTES || 1440);
    for (const group of groups.values()) {
      let freightCents = 0;
      let allEstimates = true;
      const sellerProvinces = new Set(group.items.map(function (item) { return item.seller_province; }));
      for (const origin of sellerProvinces) {
        const rate = await findFreightRate(client, origin, destination, provider);
        if (!rate) {
          await client.query('ROLLBACK');
          return res.status(503).json(errorResponse(503, 'freight_not_configured', `Delivery estimate is not configured from ${origin} to ${destination}.`));
        }
        freightCents += Math.round(rate.amount * 100);
        allEstimates = allEstimates && rate.isEstimate;
      }
      const subtotalCents = group.items.reduce(function (sum, item) {
        return sum + Math.round(Number(item.price_kina) * 100) * item.quantity;
      }, 0);
      const method = VENDOR_PAYMENT_METHODS[group.methodId];
      const orderIdempotencyKey = groups.size === 1 ? idempotencyKey : vendorCheckoutUuid(idempotencyKey, group.vendorId);
      const totalCents = subtotalCents + (shippingPayer === 'buyer' ? freightCents : 0);
      const inserted = await client.query(
        `INSERT INTO orders (buyer_id, delivery_address, delivery_province, phone_number,
            subtotal_kina, shipping_kina, total_kina, shipping_provider, payment_method,
          shipping_payer, payment_instructions, payment_reference_phone, payment_reference_whatsapp,
          freight_is_estimate, idempotency_key, checkout_fingerprint, checkout_group_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         RETURNING order_id, subtotal_kina, shipping_kina, total_kina, payment_status,
                   order_status, freight_is_estimate, shipping_payer, created_at`,
        [req.user.user_id, address, destination, phone, subtotalCents / 100, freightCents / 100,
          totalCents / 100, provider, method.databaseMethod, shippingPayer, group.paymentInstructions,
          group.paymentReferencePhone || null, group.paymentReferenceWhatsapp || null, allEstimates,
          orderIdempotencyKey, fingerprint, idempotencyKey]
      );
      const order = inserted.rows[0];
      const expiry = await client.query(
        `SELECT clock_timestamp() + ($1::integer * INTERVAL '1 minute') AS expires_at`,
        [manualMinutes]
      );
      for (const item of group.items) {
        await client.query(
          `INSERT INTO order_items (order_id, product_id, vendor_id, product_name, seller_province, unit_price_kina, quantity, delivery_contact)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
          [order.order_id, item.product_id, item.vendor_id, item.product_name, item.seller_province,
            item.price_kina, item.quantity, item.delivery_contact ? JSON.stringify(item.delivery_contact) : null]
        );
        await client.query(
          `INSERT INTO inventory_reservations (order_id, product_id, quantity, expires_at)
           VALUES ($1, $2, $3, $4)`,
          [order.order_id, item.product_id, item.quantity, expiry.rows[0].expires_at]
        );
      }
      await client.query(
        "INSERT INTO vendor_order_fulfillments (order_id, vendor_id, status) VALUES ($1, $2, 'pending')",
        [order.order_id, group.vendorId]
      );
      await client.query(
        `INSERT INTO payments (order_id, provider, mode, status, transaction_reference, amount_kina, expires_at)
         VALUES ($1, $2, 'manual', 'pending', $3, $4, $5)`,
        [order.order_id, group.methodId, `KM-ORDER-${crypto.randomUUID()}`,
          totalCents / 100, expiry.rows[0].expires_at]
      );
      order.expires_at = expiry.rows[0].expires_at;
      order.vendor_id = group.vendorId;
      order.vendor_name = group.vendorName;
      order.payment_method = method.databaseMethod;
      order.payment_instructions = group.paymentInstructions;
      order.payment_reference_phone = group.paymentReferencePhone || null;
      order.payment_reference_whatsapp = group.paymentReferenceWhatsapp || null;
      createdOrders.push(order);
    }
    await client.query('DELETE FROM cart_items WHERE user_id = $1', [req.user.user_id]);
    await client.query('COMMIT');
    return res.status(201).json(successResponse(201, 'Checkout split into separate vendor orders. Payments remain pending until each vendor confirms receipt.', {
      orders: createdOrders, paymentMode: 'manual', paymentStatus: 'pending'
    }));
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    return next(error);
  } finally {
    if (client) client.release();
  }
});

app.get('/api/orders/:orderId', authenticateToken, async function (req, res, next) {
  const id = parsePositiveId(req.params.orderId);
  if (!id) return res.status(400).json(errorResponse(400, 'invalid_order', 'Order ID is invalid.'));
  try {
    await expirePaymentReservations(pool);
    const result = await query(
            `SELECT o.order_id, o.delivery_address, o.delivery_province, o.phone_number,
              o.subtotal_kina, o.shipping_kina, o.total_kina, o.shipping_provider,
              o.shipping_payer,
              o.payment_method, o.payment_instructions, o.payment_reference_phone, o.payment_reference_whatsapp,
              o.payment_status, o.order_status, o.freight_is_estimate, o.created_at,
              o.shipment_carrier, o.shipment_booking_reference, o.shipment_tracking_reference,
              o.shipment_tracking_url, o.shipment_notes, o.shipment_driver_name, o.shipment_driver_phone,
              o.shipment_vehicle_plate, o.shipment_vehicle_description, o.shipment_updated_at,
              COALESCE((SELECT SUM(r.amount_kina) FROM order_refunds r WHERE r.order_id = o.order_id), 0) AS refunded_kina,
              EXISTS (SELECT 1 FROM vendor_payment_verifications vpv
                       WHERE vpv.order_id = o.order_id AND vpv.status = 'successful') AS vendor_confirmed_receipt,
              COALESCE(json_agg(json_build_object('productId', i.product_id, 'name', i.product_name,
                'quantity', i.quantity, 'unitPriceKina', i.unit_price_kina, 'vendorId', i.vendor_id,
                'deliveryContact', i.delivery_contact))
                FILTER (WHERE i.order_item_id IS NOT NULL), '[]') AS items
         FROM orders o LEFT JOIN order_items i ON i.order_id = o.order_id
        WHERE o.order_id = $1 AND o.buyer_id = $2
        GROUP BY o.order_id`,
      [id, req.user.user_id]
    );
    if (!result.rows[0]) return res.status(404).json(errorResponse(404, 'order_not_found', 'Order was not found.'));
    return res.status(200).json(successResponse(200, 'Order details.', { order: result.rows[0] }));
  } catch (error) {
    return next(error);
  }
});

app.post('/api/vendor/orders/:orderId/payment-confirmation', authenticateToken, requireRole('vendor'), requireActiveVendor, async function (req, res, next) {
  const orderId = parsePositiveId(req.params.orderId);
  const verificationReference = normalizeString(req.body && req.body.verificationReference);
  if (!orderId || verificationReference.length > 120 || /[\u0000-\u001f\u007f]/.test(verificationReference)) {
    return res.status(400).json(errorResponse(400, 'invalid_payment_confirmation', 'Provide a valid order ID and optional receipt reference.'));
  }
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await expirePaymentReservations(client);
    const selected = await client.query(
      `SELECT o.order_id, o.payment_status, o.order_status, o.payment_method, o.total_kina,
              pay.payment_id, pay.status AS payment_record_status, pay.mode, pay.amount_kina,
              pay.verified_by, (pay.expires_at IS NULL OR pay.expires_at > clock_timestamp()) AS reservation_active,
              (SELECT COUNT(DISTINCT i.vendor_id)::integer
                 FROM order_items i WHERE i.order_id = o.order_id) AS vendor_count,
              (SELECT MIN(i.vendor_id) FROM order_items i WHERE i.order_id = o.order_id) AS item_vendor_id
         FROM orders o
         JOIN payments pay ON pay.order_id = o.order_id
         JOIN vendor_order_fulfillments f ON f.order_id = o.order_id AND f.vendor_id = $2
        WHERE o.order_id = $1
        FOR UPDATE OF o, pay`,
      [orderId, req.vendor.vendor_id]
    );
    const order = selected.rows[0];
    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json(errorResponse(404, 'order_not_found', 'Order was not found for this vendor.'));
    }
    if (order.payment_record_status === 'successful' && String(order.verified_by) === String(req.user.user_id)) {
      await client.query('COMMIT');
      return res.status(200).json(successResponse(200, 'This vendor receipt confirmation was already recorded.', {
        orderId, paymentStatus: 'successful'
      }));
    }
    const codPayment = order.payment_method === 'cash_on_delivery';
    const validConfirmationStage = codPayment ? order.order_status === 'delivered' : order.order_status === 'pending';
    if (order.vendor_count !== 1 || String(order.item_vendor_id) !== String(req.vendor.vendor_id) || order.mode !== 'manual' ||
        !MANUAL_PAYMENT_METHODS.has(order.payment_method) ||
        order.payment_record_status !== 'pending' || order.payment_status !== 'pending' ||
        !validConfirmationStage) {
      await client.query('ROLLBACK');
      return res.status(409).json(errorResponse(409, 'payment_not_vendor_confirmable', codPayment
        ? 'Cash-on-delivery payment can be confirmed only after the order is delivered and cash has actually been collected.'
        : 'Only this vendor’s own pending manual-payment order can be confirmed.'));
    }
    if (!order.reservation_active) {
      await client.query('COMMIT');
      return res.status(409).json(errorResponse(409, 'payment_expired', 'The payment reservation expired. The customer must place a new order.'));
    }
    if (Number(order.amount_kina) !== Number(order.total_kina)) {
      await client.query('ROLLBACK');
      return res.status(409).json(errorResponse(409, 'payment_amount_mismatch', 'The stored payment amount does not match the order total; contact marketplace support.'));
    }
    const reservations = await client.query(
      `SELECT product_id, quantity, status, expires_at > clock_timestamp() AS active
         FROM inventory_reservations
        WHERE order_id = $1 ORDER BY product_id FOR UPDATE`,
      [orderId]
    );
    if (codPayment && order.order_status === 'delivered') {
      const consumed = reservations.rows.filter(function (reservation) { return reservation.status === 'consumed'; });
      if (!consumed.length || consumed.length !== reservations.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json(errorResponse(409, 'reservation_missing', 'Delivered cash-on-delivery orders must already have consumed their stock reservation.'));
      }
    } else {
      const reserved = reservations.rows.filter(function (reservation) {
        return reservation.status === 'reserved';
      });
      if (!reserved.length || reserved.length !== reservations.rows.length ||
          reservations.rows.some(function (reservation) { return !reservation.active; })) {
        await client.query('ROLLBACK');
        return res.status(409).json(errorResponse(409, 'reservation_missing', 'The order no longer has an active stock reservation.'));
      }
      for (const reservation of reserved) {
        const product = await client.query(
          'SELECT stock_quantity FROM products WHERE product_id = $1 FOR UPDATE',
          [reservation.product_id]
        );
        if (!product.rows[0] || Number(product.rows[0].stock_quantity) < Number(reservation.quantity)) {
          await client.query('ROLLBACK');
          return res.status(409).json(errorResponse(409, 'reserved_stock_unavailable', 'Reserved stock is no longer available for fulfillment.'));
        }
        await client.query(
          `UPDATE products SET stock_quantity = stock_quantity - $1,
             status = CASE WHEN stock_quantity - $1 = 0 THEN 'out_of_stock' ELSE status END,
             updated_at = NOW()
           WHERE product_id = $2`,
          [reservation.quantity, reservation.product_id]
        );
      }
      await client.query(
        `UPDATE inventory_reservations SET status = 'consumed', updated_at = NOW()
          WHERE order_id = $1 AND status = 'reserved'`,
        [orderId]
      );
    }
    await client.query(
      `UPDATE payments SET status = 'successful', verified_by = $1, verified_at = NOW(), updated_at = NOW()
        WHERE payment_id = $2 AND status = 'pending'`,
      [req.user.user_id, order.payment_id]
    );
    await client.query(
      `UPDATE orders SET payment_status = 'successful', updated_at = NOW()
        WHERE order_id = $1 AND payment_status = 'pending'`,
      [orderId]
    );
    await client.query(
      `INSERT INTO vendor_payment_verifications (order_id, vendor_id, verified_by, status, receipt_reference)
       VALUES ($1, $2, $3, 'successful', NULLIF($4, ''))`,
      [orderId, req.vendor.vendor_id, req.user.user_id, verificationReference]
    );
    await client.query('COMMIT');
    return res.status(200).json(successResponse(200, 'Vendor confirmation recorded. The vendor attests that payment was received; no payment provider independently verified it.', {
      orderId, paymentStatus: 'successful', confirmationType: 'vendor_attestation'
    }));
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    return next(error);
  } finally {
    if (client) client.release();
  }
});

app.patch('/api/vendor/orders/:orderId/status', authenticateToken, requireRole('vendor'), requireActiveVendor, async function (req, res, next) {
  const id = parsePositiveId(req.params.orderId);
  const status = normalizeString(req.body && req.body.status);
  const transitions = { pending: 'confirmed', confirmed: 'packed', packed: 'shipped', shipped: 'delivered' };
  if (!id || !Object.values(transitions).includes(status)) {
    return res.status(400).json(errorResponse(400, 'invalid_order_status', 'Order ID or requested status is invalid.'));
  }
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await expirePaymentReservations(client);
    const previousStatus = Object.keys(transitions).find(function (previous) { return transitions[previous] === status; });
    const orderPayment = await client.query(
      `SELECT o.payment_status, o.payment_method, o.shipping_provider,
              o.shipment_driver_name, o.shipment_driver_phone,
              o.shipment_vehicle_plate, o.shipment_vehicle_description
         FROM orders o JOIN vendor_order_fulfillments f ON f.order_id = o.order_id
        WHERE o.order_id = $1 AND f.vendor_id = $2
        FOR UPDATE OF o`,
      [id, req.vendor.vendor_id]
    );
    if (!orderPayment.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json(errorResponse(404, 'order_not_found', 'Order was not found for this vendor.'));
    }
    const cashOnDeliveryPending = orderPayment.rows[0].payment_method === 'cash_on_delivery' &&
      orderPayment.rows[0].payment_status === 'pending';
    if (orderPayment.rows[0].payment_status !== 'successful' && !cashOnDeliveryPending) {
      await client.query('ROLLBACK');
      return res.status(409).json(errorResponse(409, 'payment_not_confirmed', 'Payment must be verified before this order can be fulfilled.'));
    }
    if (status === 'shipped' && orderPayment.rows[0].shipping_provider === 'PMV' &&
        (!orderPayment.rows[0].shipment_driver_name || !orderPayment.rows[0].shipment_driver_phone ||
          !orderPayment.rows[0].shipment_vehicle_plate || !orderPayment.rows[0].shipment_vehicle_description)) {
      await client.query('ROLLBACK');
      return res.status(409).json(errorResponse(409, 'pmv_driver_details_required',
        'Save the PMV driver name, phone number, vehicle plate, and vehicle description before dispatch.'));
    }
    if (cashOnDeliveryPending && previousStatus === 'packed' && status === 'shipped') {
      const reservations = await client.query(
        `SELECT product_id, quantity FROM inventory_reservations
          WHERE order_id = $1 AND status = 'reserved' AND expires_at > clock_timestamp()
          ORDER BY product_id FOR UPDATE`,
        [id]
      );
      if (!reservations.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json(errorResponse(409, 'reservation_expired', 'This cash-on-delivery reservation expired before dispatch. The customer must place a new order.'));
      }
      for (const reservation of reservations.rows) {
        const product = await client.query(
          'SELECT stock_quantity FROM products WHERE product_id = $1 FOR UPDATE',
          [reservation.product_id]
        );
        if (!product.rows[0] || Number(product.rows[0].stock_quantity) < Number(reservation.quantity)) {
          await client.query('ROLLBACK');
          return res.status(409).json(errorResponse(409, 'reserved_stock_unavailable', 'Reserved stock is no longer available for dispatch.'));
        }
        await client.query(
          `UPDATE products SET stock_quantity = stock_quantity - $1,
             status = CASE WHEN stock_quantity - $1 = 0 THEN 'out_of_stock' ELSE status END,
             updated_at = NOW()
           WHERE product_id = $2`,
          [reservation.quantity, reservation.product_id]
        );
      }
      await client.query(
        `UPDATE inventory_reservations SET status = 'consumed', updated_at = NOW()
          WHERE order_id = $1 AND status = 'reserved'`,
        [id]
      );
      await client.query(
        `UPDATE payments SET expires_at = NULL, updated_at = NOW()
          WHERE order_id = $1 AND status = 'pending'`,
        [id]
      );
    }
    const result = await client.query(
      `UPDATE vendor_order_fulfillments SET status = $1, updated_at = NOW()
        WHERE order_id = $2 AND vendor_id = $3 AND status = $4
       RETURNING order_id, status AS order_status`,
      [status, id, req.vendor.vendor_id, previousStatus]
    );
    if (!result.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json(errorResponse(404, 'order_not_found', 'Order was not found for this vendor or cannot transition to that status.'));
    }
    await client.query(
      `UPDATE orders o SET order_status = CASE
         WHEN NOT EXISTS (SELECT 1 FROM vendor_order_fulfillments f WHERE f.order_id = o.order_id AND f.status <> 'delivered') THEN 'delivered'
         WHEN EXISTS (SELECT 1 FROM vendor_order_fulfillments f WHERE f.order_id = o.order_id AND f.status = 'shipped') THEN 'shipped'
         WHEN EXISTS (SELECT 1 FROM vendor_order_fulfillments f WHERE f.order_id = o.order_id AND f.status = 'packed') THEN 'packed'
         WHEN EXISTS (SELECT 1 FROM vendor_order_fulfillments f WHERE f.order_id = o.order_id AND f.status = 'confirmed') THEN 'confirmed'
         ELSE 'pending' END, updated_at = NOW()
       WHERE o.order_id = $1`, [id]
    );
    await client.query('COMMIT');
    return res.status(200).json(successResponse(200, 'Order status updated.', { order: result.rows[0] }));
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    return next(error);
  } finally {
    if (client) client.release();
  }
});

app.patch('/api/vendor/orders/:orderId/shipment', authenticateToken, requireRole('vendor'), requireActiveVendor, async function (req, res, next) {
  const id = parsePositiveId(req.params.orderId);
  const body = req.body || {};
  const carrier = normalizeString(body.carrier);
  const bookingReference = normalizeString(body.bookingReference);
  const trackingReference = normalizeString(body.trackingReference);
  const trackingUrl = normalizeString(body.trackingUrl);
  const notes = normalizeString(body.notes);
  const driverName = normalizeString(body.driverName);
  const driverPhone = normalizePhoneNumber(body.driverPhone);
  const vehiclePlate = normalizeString(body.vehiclePlate).toUpperCase();
  const vehicleDescription = normalizeString(body.vehicleDescription);
  let parsedTrackingUrl;
  try { parsedTrackingUrl = trackingUrl ? new URL(trackingUrl) : null; } catch (error) { parsedTrackingUrl = null; }
  if (!id || carrier.length > 80 || bookingReference.length > 120 || trackingReference.length > 120 ||
      notes.length > 500 || driverName.length > 120 || driverPhone.length > 30 ||
      vehiclePlate.length > 20 || vehicleDescription.length > 120 ||
      /[\u0000-\u001f\u007f]/.test(carrier + bookingReference + trackingReference + notes + driverName + vehiclePlate + vehicleDescription) ||
      (driverPhone && !/^\+675[78]\d{7}$/.test(driverPhone)) ||
      (trackingUrl && (!parsedTrackingUrl || parsedTrackingUrl.protocol !== 'https:' || parsedTrackingUrl.username || parsedTrackingUrl.password))) {
    return res.status(400).json(errorResponse(400, 'invalid_shipment', 'Provide valid shipment details and an optional HTTPS tracking link.'));
  }
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const current = await client.query(
      `SELECT o.order_id, o.order_status, o.payment_status, o.payment_method, o.shipping_provider
         FROM orders o JOIN vendor_order_fulfillments f ON f.order_id = o.order_id
        WHERE o.order_id = $1 AND f.vendor_id = $2
        FOR UPDATE OF o`,
      [id, req.vendor.vendor_id]
    );
    const order = current.rows[0];
    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json(errorResponse(404, 'order_not_found', 'Order was not found for this vendor.'));
    }
    const codPending = order.payment_method === 'cash_on_delivery' && order.payment_status === 'pending';
    if (!['packed', 'shipped'].includes(order.order_status) ||
        (order.payment_status !== 'successful' && !codPending)) {
      await client.query('ROLLBACK');
      return res.status(409).json(errorResponse(409, 'shipment_not_ready', 'Shipment details can be recorded after the order is packed and payment is confirmed (or for cash on delivery).'));
    }
    if (order.shipping_provider === 'PMV' &&
        (driverName.length < 2 || !/^\+675[78]\d{7}$/.test(driverPhone) ||
          vehiclePlate.length < 2 || vehicleDescription.length < 2)) {
      await client.query('ROLLBACK');
      return res.status(400).json(errorResponse(400, 'invalid_pmv_driver_details',
        'For PMV delivery, provide the driver name, valid PNG phone number, vehicle plate number, and vehicle description.'));
    }
    const result = await client.query(
      `UPDATE orders SET shipment_carrier = NULLIF($1, ''), shipment_booking_reference = NULLIF($2, ''),
              shipment_tracking_reference = NULLIF($3, ''), shipment_tracking_url = NULLIF($4, ''),
              shipment_notes = NULLIF($5, ''), shipment_driver_name = NULLIF($6, ''),
              shipment_driver_phone = NULLIF($7, ''), shipment_vehicle_plate = NULLIF($8, ''),
              shipment_vehicle_description = NULLIF($9, ''), shipment_updated_by = $10,
              shipment_updated_at = NOW(), updated_at = NOW()
        WHERE order_id = $11
        RETURNING order_id, shipment_carrier, shipment_booking_reference, shipment_tracking_reference,
                  shipment_tracking_url, shipment_notes, shipment_driver_name, shipment_driver_phone,
                  shipment_vehicle_plate, shipment_vehicle_description, shipment_updated_at`,
      [carrier || order.shipping_provider, bookingReference, trackingReference, trackingUrl, notes,
        driverName, driverPhone, vehiclePlate, vehicleDescription, req.user.user_id, id]
    );
    await client.query('COMMIT');
    return res.status(200).json(successResponse(200, 'Manual shipment details saved. Carrier booking and tracking are not connected to a provider.', { shipment: result.rows[0] }));
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    return next(error);
  } finally {
    if (client) client.release();
  }
});

app.patch('/api/admin/orders/:orderId', authenticateToken, requireRole('admin'), async function (req, res, next) {
  const id = parsePositiveId(req.params.orderId);
  const body = req.body || {};
  const address = body.deliveryAddress === undefined ? undefined : normalizeString(body.deliveryAddress);
  const province = body.deliveryProvince === undefined ? undefined : normalizeProvince(body.deliveryProvince);
  const phone = body.phoneNumber === undefined ? undefined : normalizePhoneNumber(body.phoneNumber);
  const provider = body.shippingProvider === undefined ? undefined : normalizeString(body.shippingProvider);
  if (!id || (address !== undefined && (address.length < 5 || address.length > 500)) ||
      (body.deliveryProvince !== undefined && !province) ||
      (phone !== undefined && !/^\+675[78]\d{7}$/.test(phone)) ||
      (provider !== undefined && !SHIPPING_PROVIDERS.has(provider) && !LEGACY_SHIPPING_PROVIDERS.has(provider)) ||
      [address, phone, provider].some(function (value) { return value !== undefined && /[\u0000-\u001f\u007f]/.test(value); })) {
    return res.status(400).json(errorResponse(400, 'invalid_order_update', 'Provide valid delivery address, province, PNG phone number, or shipping provider. Order totals and payment state cannot be edited.'));
  }
  const valuesByField = { delivery_address: address, delivery_province: province, phone_number: phone, shipping_provider: provider };
  const changes = Object.entries(valuesByField).filter(function (entry) { return entry[1] !== undefined; });
  if (!changes.length) return res.status(400).json(errorResponse(400, 'empty_update', 'Provide at least one editable order field.'));
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const currentResult = await client.query(
      `SELECT order_id, order_status, payment_status, delivery_province, shipping_provider, shipping_payer,
              subtotal_kina, shipping_kina, total_kina, freight_is_estimate
         FROM orders WHERE order_id = $1 FOR UPDATE`,
      [id]
    );
    const current = currentResult.rows[0];
    if (!current) {
      await client.query('ROLLBACK');
      return res.status(404).json(errorResponse(404, 'order_not_found', 'Order was not found.'));
    }
    const destination = province === undefined ? current.delivery_province : province;
    const targetProvider = provider === undefined ? current.shipping_provider : provider;
    const routeChanged = destination !== current.delivery_province || targetProvider !== current.shipping_provider;
    let updatedFreight = null;
    if (routeChanged) {
      if (!['pending', 'confirmed'].includes(current.order_status) || current.payment_status !== 'pending') {
        await client.query('ROLLBACK');
        return res.status(409).json(errorResponse(409, 'order_route_locked',
          'The shipping province or provider cannot be changed after payment or fulfillment has started.'));
      }
      if (!SHIPPING_PROVIDERS.has(targetProvider)) {
        await client.query('ROLLBACK');
        return res.status(400).json(errorResponse(400, 'invalid_shipping_provider',
          'Legacy PostPNG orders may be edited, but cannot be changed to or from PostPNG.'));
      }
      const originResult = await client.query(
        'SELECT DISTINCT seller_province FROM order_items WHERE order_id = $1 ORDER BY seller_province',
        [id]
      );
      if (!originResult.rows.length ||
          originResult.rows.some(function (row) {
            return !isShippingProviderValidForRoute(targetProvider, row.seller_province, destination);
          })) {
        await client.query('ROLLBACK');
        return res.status(409).json(errorResponse(409, 'delivery_route_unavailable',
          'The selected shipping method does not match this order’s origin and destination provinces.'));
      }
      let shippingCents = 0;
      let isEstimate = true;
      for (const row of originResult.rows) {
        const rate = await findFreightRate(client, row.seller_province, destination, targetProvider);
        if (!rate) {
          await client.query('ROLLBACK');
          return res.status(503).json(errorResponse(503, 'freight_not_configured',
            `No active rate is configured from ${row.seller_province} to ${destination} for ${targetProvider}.`));
        }
        shippingCents += Math.round(rate.amount * 100);
        isEstimate = isEstimate && rate.isEstimate;
      }
      const totalCents = Math.round(Number(current.subtotal_kina) * 100) +
        (current.shipping_payer === 'vendor' ? 0 : shippingCents);
      updatedFreight = {
        shippingKina: shippingCents / 100,
        totalKina: totalCents / 100,
        isEstimate
      };
      const pendingPayment = await client.query(
        `SELECT payment_id FROM payments
          WHERE order_id = $1 AND status = 'pending'
            AND (expires_at IS NULL OR expires_at > clock_timestamp())
          FOR UPDATE`,
        [id]
      );
      if (!pendingPayment.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json(errorResponse(409, 'payment_not_pending',
          'The pending payment has expired or is unavailable; the shipping route cannot be repriced.'));
      }
    }
    const fields = [];
    const values = [id];
    const updateValuesByField = Object.assign({}, valuesByField);
    if (updatedFreight) {
      updateValuesByField.shipping_kina = updatedFreight.shippingKina;
      updateValuesByField.total_kina = updatedFreight.totalKina;
      updateValuesByField.freight_is_estimate = updatedFreight.isEstimate;
    }
    const updateChanges = Object.entries(updateValuesByField).filter(function (entry) { return entry[1] !== undefined; });
    for (const [column, value] of updateChanges) {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    }
    fields.push('updated_at = NOW()');
    const result = await client.query(
      `UPDATE orders SET ${fields.join(', ')} WHERE order_id = $1
       RETURNING order_id, delivery_address, delivery_province, phone_number, shipping_provider,
                 shipping_payer, subtotal_kina, shipping_kina, total_kina, payment_status, order_status`,
      values
    );
    if (!result.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json(errorResponse(404, 'order_not_found', 'Order was not found.'));
    }
    if (updatedFreight) {
      await client.query(
        `UPDATE payments SET amount_kina = $1 WHERE order_id = $2 AND status = 'pending'`,
        [updatedFreight.totalKina, id]
      );
    }
    await recordAdminAction(client, req.user.user_id, 'order.delivery_details_updated', 'order', id, {
      changedFields: updateChanges.map(function (entry) { return entry[0]; }),
      freightRecalculated: Boolean(updatedFreight)
    });
    await client.query('COMMIT');
    return res.status(200).json(successResponse(200, 'Order delivery details updated. Financial totals were not changed.', { order: result.rows[0] }));
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    return next(error);
  } finally {
    if (client) client.release();
  }
});

app.post('/api/admin/orders/:orderId/refunds', authenticateToken, requireRole('admin'), async function (req, res, next) {
  const id = parsePositiveId(req.params.orderId);
  const body = req.body || {};
  const amount = Number(body.amountKina);
  const method = normalizeString(body.refundMethod);
  const reference = normalizeString(body.reference);
  const reason = normalizeString(body.reason);
  if (!id || !Number.isFinite(amount) || amount <= 0 || amount > 10000000 || Math.round(amount * 100) / 100 !== amount ||
      !['bank_transfer', 'mobile_wallet', 'cash', 'other'].includes(method) || reference.length > 120 ||
      reason.length < 3 || reason.length > 500 || /[\u0000-\u001f\u007f]/.test(reference + reason)) {
    return res.status(400).json(errorResponse(400, 'invalid_refund', 'Provide a valid refund amount, method, optional reference, and reason.'));
  }
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const selected = await client.query(
      `SELECT o.order_id, o.payment_status, o.total_kina, p.payment_id, p.status AS payment_record_status, p.mode, p.amount_kina
         FROM orders o JOIN payments p ON p.order_id = o.order_id
        WHERE o.order_id = $1 FOR UPDATE OF o, p`,
      [id]
    );
    const payment = selected.rows[0];
    if (!payment) {
      await client.query('ROLLBACK');
      return res.status(404).json(errorResponse(404, 'order_not_found', 'Order or payment record was not found.'));
    }
    if (payment.mode !== 'manual' || !['successful', 'refunded'].includes(payment.payment_record_status) ||
        payment.payment_status !== payment.payment_record_status) {
      await client.query('ROLLBACK');
      return res.status(409).json(errorResponse(409, 'payment_not_refundable', 'Only a successfully recorded manual payment can be refunded.'));
    }
    const previousRefunds = await client.query(
      'SELECT COALESCE(SUM(amount_kina), 0) AS refunded_kina FROM order_refunds WHERE order_id = $1', [id]
    );
    const alreadyRefunded = Number(previousRefunds.rows[0].refunded_kina);
    const paidAmount = Number(payment.amount_kina);
    if (alreadyRefunded + amount > paidAmount + 0.001) {
      await client.query('ROLLBACK');
      return res.status(409).json(errorResponse(409, 'refund_exceeds_payment', 'The refund amount exceeds the remaining recorded payment balance.'));
    }
    const refund = await client.query(
      `INSERT INTO order_refunds (order_id, payment_id, admin_user_id, amount_kina, refund_method, reference, reason)
       VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''), $7)
       RETURNING refund_id, order_id, amount_kina, refund_method, reference, reason, created_at`,
      [id, payment.payment_id, req.user.user_id, amount, method, reference, reason]
    );
    const fullyRefunded = alreadyRefunded + amount >= paidAmount - 0.001;
    if (fullyRefunded) {
      await client.query("UPDATE payments SET status = 'refunded', updated_at = NOW() WHERE payment_id = $1", [payment.payment_id]);
      await client.query("UPDATE orders SET payment_status = 'refunded', updated_at = NOW() WHERE order_id = $1", [id]);
    }
    await recordAdminAction(client, req.user.user_id, fullyRefunded ? 'order.refunded' : 'order.partially_refunded', 'order', id, {
      refundId: String(refund.rows[0].refund_id), amountKina: amount, method, reference: reference || null, reason,
      totalRefundedKina: alreadyRefunded + amount, fullRefund: fullyRefunded
    });
    await client.query('COMMIT');
    return res.status(201).json(successResponse(201, fullyRefunded
      ? 'Full manual refund recorded. Transfer the amount using the selected offline method.'
      : 'Partial manual refund recorded. Transfer the amount using the selected offline method.', {
      refund: refund.rows[0], totalRefundedKina: alreadyRefunded + amount, paymentStatus: fullyRefunded ? 'refunded' : 'successful'
    }));
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    return next(error);
  } finally {
    if (client) client.release();
  }
});

app.patch('/api/admin/vendors/:vendorId/status', authenticateToken, requireRole('admin'), async function (req, res, next) {
  const vendorId = parsePositiveId(req.params.vendorId);
  const status = normalizeString(req.body && req.body.status);
  if (!vendorId || !['review', 'active', 'suspended', 'rejected'].includes(status)) {
    return res.status(400).json(errorResponse(400, 'invalid_vendor_status', 'Vendor ID or review status is invalid.'));
  }
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const result = await client.query(
      'UPDATE vendors SET status = $1, updated_at = NOW() WHERE vendor_id = $2 RETURNING vendor_id, business_name, province, status',
      [status, vendorId]
    );
    if (!result.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json(errorResponse(404, 'vendor_not_found', 'Vendor application was not found.'));
    }
    await recordAdminAction(client, req.user.user_id, `vendor.${status}`, 'vendor', vendorId, { status });
    await client.query('COMMIT');
    return res.status(200).json(successResponse(200, 'Vendor status updated.', { vendor: result.rows[0] }));
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    return next(error);
  } finally {
    if (client) client.release();
  }
});

async function recordAdminAction(client, adminUserId, action, resourceType, resourceId, details) {
  await client.query(
    `INSERT INTO admin_audit_logs (admin_user_id, action, resource_type, resource_id, details)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [adminUserId, action, resourceType, resourceId, JSON.stringify(details)]
  );
}

app.get('/api/admin/dashboard', authenticateToken, requireRole('admin'), async function (req, res, next) {
  try {
    await expirePaymentReservations(pool);
    const [vendors, products, orders, payments, rates, activity, analytics] = await Promise.all([
      query(
        `SELECT v.vendor_id, v.business_name, v.province, v.status, v.created_at,
                u.full_name, u.email
           FROM vendors v JOIN users u ON u.user_id = v.user_id
          ORDER BY CASE v.status WHEN 'review' THEN 0 ELSE 1 END, v.created_at DESC LIMIT 100`
      ),
      query(
        `SELECT p.product_id, p.product_name, p.category, p.province, p.price_kina,
                p.stock_quantity, p.status, v.business_name
           FROM products p JOIN vendors v ON v.vendor_id = p.vendor_id
          ORDER BY p.created_at DESC LIMIT 100`
      ),
       query(
         `SELECT o.order_id, o.buyer_id, u.full_name AS buyer_name, u.email AS buyer_email,
           o.delivery_address, o.delivery_province, o.phone_number, o.shipping_provider, o.shipping_payer,
           o.subtotal_kina, o.shipping_kina, o.total_kina, o.payment_status, o.order_status,
           o.shipment_carrier, o.shipment_booking_reference, o.shipment_tracking_reference,
           o.shipment_tracking_url, o.shipment_notes, o.shipment_driver_name, o.shipment_driver_phone,
           o.shipment_vehicle_plate, o.shipment_vehicle_description, o.created_at,
           COALESCE((SELECT SUM(r.amount_kina) FROM order_refunds r WHERE r.order_id = o.order_id), 0) AS refunded_kina
         FROM orders o JOIN users u ON u.user_id = o.buyer_id
        ORDER BY o.created_at DESC LIMIT 100`
      ),
      query(
        `SELECT pay.payment_id, pay.order_id, pay.provider, pay.status, pay.expires_at,
                o.payment_method, o.total_kina, o.delivery_province
           FROM payments pay JOIN orders o ON o.order_id = pay.order_id
          WHERE pay.mode = 'manual' AND pay.status = 'pending'
          ORDER BY pay.created_at LIMIT 100`
      ),
      query(
        `SELECT origin_province, destination_province, provider, amount_kina, is_estimate, active, updated_at
           FROM freight_rates ORDER BY origin_province, destination_province, provider`
      ),
      query(
        `SELECT a.audit_log_id, a.action, a.resource_type, a.resource_id, a.details, a.created_at, u.email AS admin_email
           FROM admin_audit_logs a JOIN users u ON u.user_id = a.admin_user_id
          ORDER BY a.created_at DESC LIMIT 50`
      ),
      query(
        `SELECT
           (SELECT COUNT(*)::integer FROM orders WHERE created_at >= CURRENT_DATE) AS orders_today,
           (SELECT COUNT(*)::integer FROM orders WHERE created_at >= NOW() - INTERVAL '30 days') AS orders_last_30_days,
           (SELECT COUNT(*)::integer FROM orders WHERE order_status IN ('pending', 'confirmed', 'packed', 'shipped')) AS active_orders,
           (SELECT COUNT(*)::integer FROM vendors WHERE status = 'review') AS pending_vendors,
           (SELECT COUNT(*)::integer FROM products WHERE status = 'listed') AS listed_products,
           (SELECT COALESCE(SUM(pay.amount_kina - COALESCE(refunds.amount_kina, 0)), 0)
              FROM payments pay
              LEFT JOIN (SELECT payment_id, SUM(amount_kina) AS amount_kina FROM order_refunds GROUP BY payment_id) refunds
                ON refunds.payment_id = pay.payment_id
             WHERE pay.status IN ('successful', 'refunded')) AS net_recorded_revenue_kina`
      )
    ]);
    return res.status(200).json(successResponse(200, 'Administration dashboard.', {
      vendors: vendors.rows,
      products: products.rows,
      orders: orders.rows,
      payments: payments.rows,
      freightRates: rates.rows,
      activity: activity.rows,
      analytics: analytics.rows[0]
    }));
  } catch (error) {
    return next(error);
  }
});

app.patch('/api/admin/products/:productId/status', authenticateToken, requireRole('admin'), async function (req, res, next) {
  const productId = parsePositiveId(req.params.productId);
  const status = normalizeString(req.body && req.body.status);
  if (!productId || !['listed', 'paused', 'out_of_stock'].includes(status)) {
    return res.status(400).json(errorResponse(400, 'invalid_product_status', 'Product ID or publication status is invalid.'));
  }
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const current = await client.query(
      'SELECT stock_quantity FROM products WHERE product_id = $1 FOR UPDATE',
      [productId]
    );
    if (!current.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json(errorResponse(404, 'product_not_found', 'Product was not found.'));
    }
    if (status === 'listed' && Number(current.rows[0].stock_quantity) < 1) {
      await client.query('ROLLBACK');
      return res.status(400).json(errorResponse(400, 'invalid_product_status', 'A product needs available stock before it can be listed.'));
    }
    const result = await client.query(
      `UPDATE products SET status = $1, updated_at = NOW()
        WHERE product_id = $2
       RETURNING product_id, product_name, status`,
      [status, productId]
    );
    await recordAdminAction(client, req.user.user_id, `product.${status}`, 'product', productId, { status });
    await client.query('COMMIT');
    return res.status(200).json(successResponse(200, 'Product publication status updated.', { product: result.rows[0] }));
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    return next(error);
  } finally {
    if (client) client.release();
  }
});

app.post('/api/admin/freight-rates', authenticateToken, requireRole('admin'), async function (req, res, next) {
  const origin = normalizeProvince(req.body && req.body.originProvince);
  const destination = normalizeProvince(req.body && req.body.destinationProvince);
  const provider = normalizeString(req.body && req.body.provider);
  const amount = req.body && typeof req.body.amountKina === 'number' ? req.body.amountKina : NaN;
  const isEstimate = !(req.body && req.body.isEstimate === false);
  const active = !(req.body && req.body.active === false);
  if ((req.body && req.body.isEstimate !== undefined && typeof req.body.isEstimate !== 'boolean') ||
      (req.body && req.body.active !== undefined && typeof req.body.active !== 'boolean') ||
      !origin || !destination || !SHIPPING_PROVIDERS.has(provider) || !Number.isFinite(amount) ||
      !isShippingProviderValidForRoute(provider, origin, destination) ||
      amount < 0 || amount > 100000 || Math.round(amount * 100) / 100 !== amount) {
    return res.status(400).json(errorResponse(400, 'invalid_freight_rate', 'Provide valid route, provider, and non-negative Kina amount.'));
  }
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO freight_rates (origin_province, destination_province, provider, amount_kina, is_estimate, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (origin_province, destination_province, provider) DO UPDATE
         SET amount_kina = EXCLUDED.amount_kina, is_estimate = EXCLUDED.is_estimate, active = $6, updated_at = NOW()
       RETURNING origin_province, destination_province, provider, amount_kina, is_estimate, active`,
      [origin, destination, provider, amount, isEstimate, active]
    );
    const rate = result.rows[0];
    await recordAdminAction(
      client, req.user.user_id, 'freight_rate.upsert', 'freight_rate', null,
      { originProvince: origin, destinationProvince: destination, provider, amountKina: amount, isEstimate, active }
    );
    await client.query('COMMIT');
    return res.status(200).json(successResponse(200, 'Freight rate configured.', { rate }));
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    return next(error);
  } finally {
    if (client) client.release();
  }
});

app.get('/health', async function (req, res) {
  const database = await checkDatabase();
  const schema = database.ok ? await checkSchema() : { ok: false, missing: [] };
  const healthy = database.ok && schema.ok;
  const status = healthy ? 200 : 503;
  return res.status(status).json({
    success: healthy,
    status,
    service: 'kundu-market-api',
    database: database.ok ? 'available' : 'unavailable',
    schema: database.ok ? (schema.ok ? 'ready' : 'incomplete') : 'unavailable'
  });
});

const publicPages = new Map([
  ['index.html', 'index.html'],
  ['products.html', 'products.html'],
  ['login.html', 'login.html'],
  ['register.html', 'register.html'],
  ['forgot-password.html', 'forgot-password.html'],
  ['reset-password.html', 'reset-password.html'],
  ['auth.html', 'auth-flow.html'],
  ['auth-flow.html', 'auth-flow.html'],
  ['cart.html', 'cart.html'],
  ['checkout.html', 'checkout.html'],
  ['product-detail.html', 'product-detail.html'],
  ['account.html', 'account.html'],
  ['orders.html', 'orders.html'],
  ['my-orders.html', 'orders.html'],
  ['order-confirmation.html', 'order-confirmation.html'],
  ['payment-status.html', 'payment-status.html'],
  ['vendor-application.html', 'vendor-application.html'],
  ['vendor-products.html', 'vendor-products.html'],
  ['vendor-product-form.html', 'vendor-product-form.html'],
  ['vendor-orders.html', 'vendor-orders.html'],
  ['vendor-dashboard.html', 'vendor-dashboard.html'],
  ['vendor-workspace.html', 'vendor-dashboard.html'],
  ['admin-dashboard.html', 'admin-dashboard.html'],
  ['admin-vendors.html', 'admin-vendors.html'],
  ['admin-products.html', 'admin-products.html'],
  ['admin-freight.html', 'admin-freight.html'],
  ['admin-audit.html', 'admin-audit.html'],
  ['admin-orders.html', 'admin-orders.html'],
  ['admin-payments.html', 'admin-payments.html'],
  ['order-detail.html', 'order-detail.html'],
  ['admin.html', 'admin-dashboard.html'],
  ['admin-workspace.html', 'admin-dashboard.html'],
  ['help.html', 'help.html'],
  ['offline.html', 'offline.html'],
  ['403.html', '403.html'],
  ['not-found.html', 'not-found.html']
]);
const authenticatedPages = new Set([
  'cart.html', 'checkout.html', 'account.html', 'orders.html', 'my-orders.html',
  'order-detail.html', 'order-confirmation.html', 'payment-status.html',
  'vendor-application.html', 'vendor-dashboard.html', 'vendor-workspace.html',
  'vendor-products.html', 'vendor-product-form.html', 'vendor-orders.html',
  'admin-dashboard.html', 'admin.html', 'admin-workspace.html', 'admin-vendors.html',
  'admin-products.html', 'admin-freight.html', 'admin-audit.html', 'admin-payments.html',
  'admin-orders.html'
]);
const vendorPages = new Set([
  'vendor-application.html', 'vendor-dashboard.html', 'vendor-workspace.html',
  'vendor-products.html', 'vendor-product-form.html', 'vendor-orders.html'
]);
const approvedVendorPages = new Set(['vendor-products.html', 'vendor-product-form.html', 'vendor-orders.html']);
const adminPages = new Set([
  'admin-dashboard.html', 'admin.html', 'admin-workspace.html', 'admin-vendors.html',
  'admin-products.html', 'admin-freight.html', 'admin-audit.html', 'admin-payments.html',
  'admin-orders.html'
]);
app.get('/site.webmanifest', function (req, res) { return res.sendFile(path.join(root, 'site.webmanifest')); });
app.get('/sw.js', function (req, res) {
  res.set('Service-Worker-Allowed', '/');
  res.set('Cache-Control', 'no-cache');
  return res.sendFile(path.join(root, 'sw.js'));
});
app.get(['/about', '/about.html', '/about/'], function (req, res) {
  return res.redirect(302, '/products');
});
app.get(['/categories', '/categories.html', '/category-browse.html'], function (req, res) {
  const query = req.originalUrl.indexOf('?') >= 0 ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  return res.redirect(302, '/products' + query);
});
app.get(['/search', '/search.html', '/search-results', '/search-results.html'], function (req, res) {
  const query = req.originalUrl.indexOf('?') >= 0 ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  return res.redirect(302, '/products' + query);
});
app.get(['/contact', '/contact.html'], function (req, res) { return res.redirect(302, '/help.html'); });
app.get('/products', function (req, res) { return res.sendFile(path.join(root, 'products.html')); });
app.get('/', function (req, res) { return res.sendFile(path.join(root, 'index.html')); });
app.get('/:page', function (req, res, next) {
  if (!publicPages.has(req.params.page)) return next();
  const pageName = req.params.page;
  if (pageName === 'auth.html' && req.query.reset) {
    return res.redirect(302, '/reset-password.html?reset=' + encodeURIComponent(req.query.reset));
  }
  if (!authenticatedPages.has(pageName)) return res.sendFile(path.join(root, publicPages.get(pageName)));
  return optionalAuthenticateToken(req, res, async function (error) {
    if (error) return next(error);
    if (!req.user) {
      return res.redirect(302, '/login.html?returnTo=' + encodeURIComponent(req.originalUrl));
    }
    if (vendorPages.has(pageName) && req.user.role !== 'vendor') {
      return res.status(403).sendFile(path.join(root, '403.html'));
    }
    if (adminPages.has(pageName) && req.user.role !== 'admin') {
      return res.status(403).sendFile(path.join(root, '403.html'));
    }
    if (approvedVendorPages.has(pageName)) {
      try {
        const result = await query('SELECT status FROM vendors WHERE user_id = $1', [req.user.user_id]);
        if (!result.rows[0] || result.rows[0].status !== 'active') {
          return res.status(403).sendFile(path.join(root, '403.html'));
        }
      } catch (databaseError) {
        return next(databaseError);
      }
    }
    return res.sendFile(path.join(root, publicPages.get(pageName)));
  });
});
app.use('/css', express.static(path.join(root, 'css'), { fallthrough: false }));
app.use('/js', express.static(path.join(root, 'js'), { fallthrough: false }));
app.use('/assets', express.static(path.join(root, 'assets'), { fallthrough: false }));
app.use('/uploads', express.static(uploadsRoot, { fallthrough: false }));

app.use(function (req, res) {
  if (!req.path.startsWith('/api/') && req.accepts('html')) {
    return res.status(404).sendFile(path.join(root, 'not-found.html'));
  }
  return res.status(404).json(errorResponse(404, 'not_found', 'The requested resource was not found.'));
});
app.use(function (error, req, res, next) {
  if (res.headersSent) return next(error);
  const status = error.status && error.status < 500 ? error.status : 500;
  if (status >= 500) console.error('Request failed:', error.code || error.name || 'unknown_error');
  return res.status(status).json(errorResponse(status, status === 500 ? 'server_error' : 'request_error', status === 500 ? 'The request could not be completed.' : error.message));
});

async function start() {
  if (!JWT_SECRET || JWT_SECRET.length < 32 || JWT_SECRET.startsWith('replace-with-')) {
    throw new Error('Set JWT_SECRET to a unique secret of at least 32 characters.');
  }
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL before starting the application.');
  validatePaymentConfiguration();
  const database = await checkDatabase();
  if (!database.ok) throw new Error('Could not connect to PostgreSQL. Check DATABASE_URL and database availability.');
  const schema = await checkSchema();
  if (!schema.ok) {
    console.error(`PostgreSQL schema is incomplete or incompatible. Page routes will be served, but database-backed features may fail until reviewed migrations are applied. Missing objects: ${schema.missing.join(', ')}.`);
  }
  await fs.mkdir(path.join(uploadsRoot, 'products'), { recursive: true });
  const server = app.listen(PORT, function () {
    console.log(`KEDOLAKA MARKET is available at http://localhost:${PORT}`);
  });
  let reservationSweep = null;
  if (schema.ok) {
    reservationSweep = setInterval(async function () {
      let client;
      try {
        client = await pool.connect();
        await client.query('BEGIN');
        await expirePaymentReservations(client);
        await client.query('COMMIT');
      } catch (error) {
        if (client) await client.query('ROLLBACK');
        console.error('Payment reservation expiry failed:', error.code || error.name || 'unknown_error');
      } finally {
        if (client) client.release();
      }
    }, 60000);
    reservationSweep.unref();
  }
  const shutdown = function () {
    server.close(async function () {
      clearInterval(reservationSweep);
      await pool.end();
      process.exit(0);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return server;
}

module.exports = { app, start, normalizeProvince, normalizeCategoryFilter };
if (require.main === module) {
  start().catch(function (error) {
    console.error(error.message);
    process.exitCode = 1;
  });
}

function getProductImageFormat(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { extension: '.png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: '.jpg' };
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return { extension: '.webp' };
  }
  return null;
}

function validProductImageUrl(value) {
  return validImageUrl(value) || /^\/uploads\/products\/[0-9a-f-]{36}\.(?:png|jpg|webp)$/i.test(value);
}