/**
 * TPS Auth Middleware
 * 
 * Applies HTTP Basic Auth validation against environment variables.
 * Used exclusively for /api/1.0/Payments/BillInquiry and /api/1.0/Payments/BillPayment
 */
module.exports = function tpsAuth(req, res, next) {
    const authHeader = req.headers['authorization'] || '';
    const headerUsername = req.headers['username'];
    const headerPassword = req.headers['password'];

    let username, password;

    if (authHeader.startsWith('Basic ')) {
        try {
            const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
            [username, password] = decoded.split(':');
        } catch (e) {
            return res.status(401).json({ error: 'Malformed Authorization header' });
        }
    } else if (headerUsername && headerPassword) {
        // Fallback if client sends custom username and password headers
        username = headerUsername;
        password = headerPassword;
    } else {
        return res.status(401).json({
            error: 'Missing or Invalid Auth header. Please provide Basic Auth or username/password headers.'
        });
    }

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
