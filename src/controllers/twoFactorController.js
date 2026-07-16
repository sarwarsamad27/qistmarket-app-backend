const prisma = require('../../lib/prisma');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');

/**
 * generate2FASecret
 * Starts enrollment: generates a TOTP secret + QR code but does NOT enable
 * 2FA yet — is_2fa_enabled only flips to true once verify2FASetup confirms
 * the user actually has the code in their authenticator app.
 */
const generate2FASecret = async (req, res) => {
    try {
        const user = await prisma.user.findUnique({ where: { id: req.user.id } });
        if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

        const secret = speakeasy.generateSecret({ length: 20, name: `Qist Market Admin (${user.username})` });
        const qrDataUrl = await qrcode.toDataURL(secret.otpauth_url);

        await prisma.user.update({ where: { id: user.id }, data: { totp_secret: secret.base32 } });

        res.json({ success: true, data: { secret: secret.base32, qrDataUrl } });
    } catch (error) {
        console.error('generate2FASecret error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const verify2FASetup = async (req, res) => {
    const { totp_code } = req.body;
    if (!totp_code) return res.status(400).json({ success: false, message: 'totp_code is required.' });

    try {
        const user = await prisma.user.findUnique({ where: { id: req.user.id } });
        if (!user || !user.totp_secret) {
            return res.status(400).json({ success: false, message: 'No pending 2FA setup found. Generate a secret first.' });
        }

        const isValid = speakeasy.totp.verify({ secret: user.totp_secret, encoding: 'base32', token: totp_code, window: 1 });
        if (!isValid) return res.status(401).json({ success: false, message: 'Invalid code. Please try again.' });

        await prisma.user.update({ where: { id: user.id }, data: { is_2fa_enabled: true } });
        res.json({ success: true, message: '2FA enabled successfully.' });
    } catch (error) {
        console.error('verify2FASetup error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const disable2FA = async (req, res) => {
    try {
        await prisma.user.update({ where: { id: req.user.id }, data: { is_2fa_enabled: false, totp_secret: null } });
        res.json({ success: true, message: '2FA disabled.' });
    } catch (error) {
        console.error('disable2FA error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const get2FAStatus = async (req, res) => {
    try {
        const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { is_2fa_enabled: true } });
        res.json({ success: true, data: { is_2fa_enabled: !!user?.is_2fa_enabled } });
    } catch (error) {
        console.error('get2FAStatus error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

module.exports = { generate2FASecret, verify2FASetup, disable2FA, get2FAStatus };
