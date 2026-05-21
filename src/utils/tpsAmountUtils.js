/**
 * TPS / 1Bill Amount Utility Functions
 *
 * Implements the strict amount formatting rules specified by the 1LINK/TPS API spec.
 */

/**
 * parseTpsAmount
 * Converts a raw TPS amount string to a standard Decimal number.
 *
 * Input format cases handling:
 *   - "000000012000" (12 chars, no sign) -> 120.00
 *   - "+0000000120000" (14 chars, positive sign) -> 1200.00
 *   - "-0000000012000" (14 chars, negative sign) -> -120.00
 *
 * The last 2 digits of the numeric portion represent Paisas (cents).
 *
 * @param {string} raw - The raw string from TPS payload
 * @returns {number} - The parsed floating point decimal
 */
function parseTpsAmount(raw) {
    if (!raw || typeof raw !== 'string') return 0.00;

    let sign = 1;
    let digitsStr = raw;

    // Handle + or - prefixes (14 character format)
    if (raw.startsWith('+')) {
        digitsStr = raw.substring(1);
    } else if (raw.startsWith('-')) {
        sign = -1;
        digitsStr = raw.substring(1);
    }

    // Remove leading zeros and parse to integer
    const cleanDigits = digitsStr.replace(/^0+/, '') || '0';
    const totalPaisas = parseInt(cleanDigits, 10);

    // Divide by 100 because last 2 digits are paisas
    const amount = (totalPaisas / 100) * sign;
    return amount;
}

/**
 * formatTpsAmount
 * Converts a decimal number to a signed 14-character TPS string.
 *
 * Output Format:
 *   - Length: exactly 14 characters
 *   - Sign: First character must be '+' or '-'
 *   - Padded: left padded with zeros
 *   - Paisas: The last 2 digits represent paisas (no decimal point)
 *
 * Example:
 *   1200.00 -> "+0000000120000"
 *   -120.00 -> "-0000000012000"
 *
 * @param {number|string} decimalValue - The amount to format
 * @returns {string} - Strict 14 char TPS formatted amount string
 */
function formatTpsAmount(decimalValue) {
    const num = parseFloat(decimalValue) || 0;
    const isNegative = num < 0;
    const signChar = isNegative ? '-' : '+';

    // Convert to absolute paisas (e.g., 1200.00 -> 120000)
    const paisas = Math.abs(Math.round(num * 100));

    // Convert paisas to string, then pad to 13 digits (1 sign + 13 digits = 14 total chars)
    const paddedDigits = paisas.toString().padStart(13, '0');

    return signChar + paddedDigits;
}

/**
 * formatTpsAmountPaid
 * Converts a decimal number to an unsigned 12-character TPS string.
 *
 * Output Format:
 *   - Length: exactly 12 characters
 *   - Sign: NO sign character
 *   - Padded: left padded with zeros
 *   - Paisas: The last 2 digits represent paisas
 *
 * Example:
 *   120.00 -> "000000012000"
 *
 * @param {number|string} decimalValue - The amount to format
 * @returns {string} - Strict 12 char unsigned TPS formatted amount string
 */
function formatTpsAmountPaid(decimalValue) {
    const num = parseFloat(decimalValue) || 0;

    // Convert to absolute paisas
    const paisas = Math.abs(Math.round(num * 100));

    // Convert to string and pad to exactly 12 digits
    return paisas.toString().padStart(12, '0');
}

module.exports = {
    parseTpsAmount,
    formatTpsAmount,
    formatTpsAmountPaid
};
