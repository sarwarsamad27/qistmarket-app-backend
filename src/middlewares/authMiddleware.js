const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/jwtConfig');
const prisma = require('../../lib/prisma');

const sessionCache = new Map(); // userId -> { sessionToken, expiresAt }
const CACHE_TTL_MS = 60 * 1000; // 1 minute

const clearUserSessionCache = (userId) => {
  sessionCache.delete(userId);
};

const authenticateJWT = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: { code: 401, message: 'Authorization header missing or invalid' } });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, jwtSecret);
    req.user = decoded;

    // Session token validation if sid is present in payload
    if (decoded.sid) {
      const userId = decoded.id;
      const now = Date.now();
      const cached = sessionCache.get(userId);

      let activeSessionToken;
      if (cached && cached.expiresAt > now) {
        activeSessionToken = cached.sessionToken;
      } else {
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { session_token: true }
        });
        if (!user) {
          return res.status(401).json({ success: false, error: { code: 401, message: 'User not found' } });
        }
        activeSessionToken = user.session_token;
        sessionCache.set(userId, {
          sessionToken: activeSessionToken,
          expiresAt: now + CACHE_TTL_MS
        });
      }

      if (!activeSessionToken || activeSessionToken !== decoded.sid) {
        return res.status(401).json({ success: false, error: { code: 401, message: 'Session expired or logged in from another device.' } });
      }
    }

    next();
  } catch (error) {
    return res.status(403).json({ success: false, error: { code: 403, message: 'Invalid or expired token' } });
  }
};

const requireSuperAdmin = async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: { role: true },
    });

    if (!user || user.role.name !== 'Super Admin') {
      return res.status(403).json({
        success: false,
        error: { code: 403, message: 'Access denied. Only Super Admin (Head Office) can perform this action.' },
      });
    }

    next();
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

module.exports = { authenticateJWT, requireSuperAdmin, clearUserSessionCache };