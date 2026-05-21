/**
 * TPS Auth Middleware
 * 
 * Applies HTTP Basic Auth validation against environment variables.
 * Used exclusively for /api/1.0/Payments/BillInquiry and /api/1.0/Payments/BillPayment
 */
module.exports = function tpsAuth(req, res, next) {
    const authHeader = req.headers['authorization'] || '';

    if (!authHeader.startsWith('Basic ')) {
        return res.status(401).json({
            error: 'Missing or Invalid Basic Auth header'
        });
    }

    let decoded;
    try {
        decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
    } catch (e) {
        return res.status(401).json({ error: 'Malformed Authorization header' });
    }

    const [username, password] = decoded.split(':');

    const expectedUser = process.env.TLINK_API_USERNAME;
    const expectedPass = process.env.TLINK_API_PASSWORD;

    if (!expectedUser || !expectedPass) {
        return res.status(500).json({
            error: 'TPS credentials are not set on the server'
        });
    }

    if (username !== expectedUser || password !== expectedPass) {
        console.warn(`[TPS Auth] Invalid credentials attempt by user: "${username}"`);
        return res.status(401).json({ error: 'Unauthorized credentials' });
    }

    next();
};
