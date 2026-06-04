const crypto = require('crypto');
const prisma = require('../../lib/prisma');

// Helper for current timestamp
const now = () => new Date();

// Generate 5-digit OTP
const generateOTP = () => {
  return crypto.randomInt(10000, 99999).toString();
};

// Save OTP to database with 10 minutes expiration
const saveOTP = async (identifier, purpose = 'login') => {
  try {
    // Delete old unused OTPs for this identifier
    await prisma.otp.deleteMany({
      where: {
        phone: identifier,
        isUsed: false,
        expiresAt: { lt: now() }
      }
    });

    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes expiry

    await prisma.otp.create({
      data: {
        phone: identifier, // storing email in phone field (we'll rename later)
        otp,
        purpose,
        expiresAt,
        createdAt: now(),   // ✅ explicit
        updatedAt: now()    // ✅ explicit
      }
    });

    return otp;
  } catch (error) {
    console.error('Error saving OTP:', error);
    throw new Error('Failed to generate OTP');
  }
};

// Verify OTP
const verifyOTP = async (identifier, otp, purpose = 'login') => {
  try {
    const otpRecord = await prisma.otp.findFirst({
      where: {
        phone: identifier,
        otp,
        purpose,
        isUsed: false,
        expiresAt: { gt: now() }
      }
    });

    if (!otpRecord) {
      return { valid: false, message: 'Invalid or expired OTP' };
    }

    // Mark OTP as used
    await prisma.otp.update({
      where: { id: otpRecord.id },
      data: {
        isUsed: true,
        updatedAt: now()   // ✅ explicit
      }
    });

    return { valid: true, message: 'OTP verified successfully' };
  } catch (error) {
    console.error('Error verifying OTP:', error);
    return { valid: false, message: 'Error verifying OTP' };
  }
};

// Clean up expired OTPs
const cleanupExpiredOTPs = async () => {
  try {
    const result = await prisma.otp.deleteMany({
      where: {
        expiresAt: { lt: now() }
      }
    });
    console.log(`Cleaned up ${result.count} expired OTPs`);
  } catch (error) {
    console.error('Error cleaning up OTPs:', error);
  }
};

module.exports = { generateOTP, saveOTP, verifyOTP, cleanupExpiredOTPs };