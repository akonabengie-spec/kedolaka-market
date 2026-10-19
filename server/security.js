const jwt = require('jsonwebtoken');
const { query } = require('./db');
const COOKIE_NAME = 'kundu_session';

function unauthorized(res) {
  return res.status(401).json({ success: false, status: 401, code: 'unauthorized', message: 'Authentication is required.' });
}

function optionalAuthenticateToken(req, res, next) {
  const authorization = req.headers.authorization || '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const token = (req.cookies && req.cookies[COOKIE_NAME]) || bearer;
  const secret = process.env.JWT_SECRET;
  if (!token || !secret) return next();

  jwt.verify(token, secret, { algorithms: ['HS256'] }, async function (error, payload) {
    if (error || !payload || !payload.sub || !payload.jti) return next();
    try {
      const result = await query(
        `SELECT u.user_id, u.full_name, u.email, u.phone_number, u.home_province, u.role
           FROM users u JOIN auth_sessions s ON s.user_id = u.user_id
          WHERE u.user_id = $1 AND s.session_id = $2 AND s.revoked_at IS NULL AND s.expires_at > NOW()`,
        [payload.sub, payload.jti]
      );
      if (!result.rows[0]) return next();
      req.user = result.rows[0];
      req.authSessionId = payload.jti;
      return next();
    } catch (databaseError) {
      return next(databaseError);
    }
  });
}

function authenticateToken(req, res, next) {
  return optionalAuthenticateToken(req, res, function (error) {
    if (error) return next(error);
    if (!req.user) return unauthorized(res);
    return next();
  });
}

function requireRole(role) {
  const roles = Array.isArray(role) ? role : [role];
  return function (req, res, next) {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, status: 403, code: 'forbidden', message: 'You do not have permission to access this resource.' });
    }
    return next();
  };
}

module.exports = { authenticateToken, optionalAuthenticateToken, requireRole };