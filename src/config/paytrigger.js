const rawEnabled = (process.env.PAYTRIGGER_ENABLED || '').trim().toLowerCase();
const API_BASE_URL = process.env.PAYTRIGGER_API_URL;
const API_KEY = process.env.PAYTRIGGER_API_KEY;
const hasRequiredConfig = Boolean(API_BASE_URL && API_KEY);

module.exports = {
  SUPPORTED_BRANDS: ['tecno', 'infinix', 'itel'],
  SUPPORTED_CATEGORIES: ['mobiles', 'smartphones', 'phone'],
  BRAND_PATTERNS: {
    tecno: /tecno/i,
    infinix: /infinix/i,
    itel: /itel/i,
  },
  API_BASE_URL,
  API_KEY,
  ENABLED: rawEnabled === 'true'
    ? true
    : rawEnabled === 'false'
      ? false
      : hasRequiredConfig,
};
