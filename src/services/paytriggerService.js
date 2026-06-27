const axios = require('axios');
const crypto = require('crypto');
const config = require('../config/paytrigger');

function generateSign(params, apiKey) {
  const keys = Object.keys(params).filter(k => params[k] !== null && params[k] !== undefined && params[k] !== '');
  keys.sort();
  const content = keys.map(k => `${k}=${params[k]}`).join('&');
  const hmac = crypto.createHmac('sha256', apiKey || config.API_KEY);
  hmac.update(content, 'utf8');
  const hash = hmac.digest('hex').toUpperCase();
  return Buffer.from(hash).toString('base64');
}

async function callAPI(endpoint, body) {
  if (!config.ENABLED) return null;
  
  // Clean body to remove null, undefined, and empty strings so it exactly matches the signature
  const cleanBody = {};
  for (const [k, v] of Object.entries(body)) {
    if (v !== null && v !== undefined && v !== '') {
      cleanBody[k] = v;
    }
  }

  const sign = generateSign(cleanBody, config.API_KEY);
  const response = await axios.post(`${config.API_BASE_URL}${endpoint}`, cleanBody, {
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'sign': sign,
    },
    timeout: 15000,
  });
  return response.data;
}

async function preEnrollImei(imei, orderNum, model, expiration, opts = {}) {
  const body = {
    apiKey: config.API_KEY,
    preLockFlag: opts.preLockFlag !== undefined ? opts.preLockFlag : false,
    imeiInfo: JSON.stringify([{
      imei,
      orderNum,
      expiration: Math.floor(expiration.getTime() / 1000),
      cycleType: opts.cycleType || 3000,
      ruleNum: opts.ruleNum || 0,
      ram: opts.ram || '',
      rom: opts.rom || '',
      deeplink: opts.deeplink || '',
      deeplinkPkg: opts.deeplinkPkg || '',
      nfcFlag: opts.nfcFlag || false,
      planGaid: opts.planGaid || '',
      nextRepaymentTimeSwitch: true,
    }]),
  };
  return callAPI('/api/partner/lock/v1/imei/input', body);
}

async function updateRepayInfo({ imei, deviceTag, orderNum, phoneNum, repayedAmt, totalAmt, nextRepayTime, nextRepayAmt, currentTerm, totalTerm, currencyType = 'PKR', description = '' }) {
  const body = {
    apiKey: config.API_KEY,
    imei: imei || '',
    deviceTag: deviceTag || '',
    orderNum,
    phoneNum,
    repayedAmt,
    totalAmt,
    nextRepayTime: Math.floor(nextRepayTime.getTime() / 1000),
    nextRepayAmt,
    currentTerm,
    totalTerm,
    currencyType,
    description,
    relatedMerchant: config.API_KEY,
  };
  return callAPI('/api/partner/lock/v1/updateRepayInfo', body);
}

async function removeLock({ deviceTag, imei }) {
  const body = {
    apiKey: config.API_KEY,
    deviceTag: deviceTag || '',
    imei: imei || '',
  };
  return callAPI('/api/partner/lock/v1/removeLock', body);
}

async function queryLockState({ deviceTag, imei, orderNum }) {
  const body = {
    apiKey: config.API_KEY,
    deviceTag: deviceTag || '',
    imei: imei || '',
    orderNum: orderNum || '',
  };
  return callAPI('/api/partner/lock/v1/findLockState', body);
}

async function batchQueryLockState({ imeis, deviceTags, orderNums }) {
  const body = {
    apiKey: config.API_KEY,
    imei: (imeis || []).join(','),
    deviceTag: (deviceTags || []).join(','),
    orderNum: (orderNums || []).join(','),
  };
  return callAPI('/api/partner/lock/v1/batchFindLockState', body);
}

async function tempUnlock({ deviceTag, imei, tempLockTime, timeUnit }) {
  const body = {
    apiKey: config.API_KEY,
    deviceTag: deviceTag || '',
    imei: imei || '',
    tempLockTime: tempLockTime || 24,
    timeUnit: timeUnit || 'HOURS'
  };
  return callAPI('/api/partner/unlock/v1/tempUnlock', body);
}

async function unenroll(imei) {
  const body = {
    apiKey: config.API_KEY,
    imeiInfo: imei,
  };
  return callAPI('/api/partner/lock/v1/imei/cancel', body);
}

async function setLockRule({ deviceTag, imei, ruleNum = 1, deviceTips = '', deeplink = '', deeplinkPkg = '', deviceTitle = '' }) {
  const body = {
    apiKey: config.API_KEY,
    deviceTag: deviceTag || '',
    imei: imei || '',
    ruleNum,
    deviceTips,
    deeplink,
    deeplinkPkg,
    deviceTitle,
  };
  return callAPI('/api/partner/lockRule/v1/setLockRule', body);
}

async function getDeviceTag(imei) {
  const body = {
    apiKey: config.API_KEY,
    imei,
  };
  return callAPI('/api/partner/lock/v1/getDevice', body);
}

async function pushMessage({ deviceTag, imei, title, content, pushType = 2, h5link = '', deeplink = '', deeplinkPkg = '' }) {
  const body = {
    apiKey: config.API_KEY,
    deviceTag: deviceTag || '',
    imei: imei || '',
    title,
    content,
    pushType,
    h5link,
    deeplink,
    deeplinkPkg,
  };
  return callAPI('/api/partner/push/v1/sendPushInfo', body);
}

async function checkLicense() {
  const body = { apiKey: config.API_KEY };
  return callAPI('/api/partner/company/v1/checkLicense', body);
}

async function getOfflinePin(imei, deviceTag, captcha) {
  const body = {
    apiKey: config.API_KEY,
    imei: imei || '',
    deviceTag: deviceTag || '',
    captcha: captcha || '',
  };
  return callAPI('/api/partner/unlock/v1/verifyCode', body);
}

async function queryCompanyConfig() {
  const body = { apiKey: config.API_KEY };
  return callAPI('/api/partner/company/v1/queryCompanyConfigInfo', body);
}

async function updateCompanyLockRule(ruleData) {
  const body = {
    apiKey: config.API_KEY,
    ruleNum: ruleData.ruleNum || 0,
    ...ruleData
  };
  return callAPI('/api/partner/company/v1/lock-rule/update', body);
}

async function submitFindPhone({ imei, deviceTag, contactInformation }) {
  const body = {
    apiKey: config.API_KEY,
    imei: imei || '',
    deviceTag: deviceTag || '',
    contactInformation: contactInformation || '',
  };
  return callAPI('/api/partner/anti-theft/v1/submit', body);
}

async function closeFindPhone({ imei, deviceTag }) {
  const body = {
    apiKey: config.API_KEY,
    imei: imei || '',
    deviceTag: deviceTag || '',
  };
  return callAPI('/api/partner/anti-theft/v1/close', body);
}

async function statusFindPhone({ imei, deviceTag }) {
  const body = {
    apiKey: config.API_KEY,
    imei: imei || '',
    deviceTag: deviceTag || '',
  };
  return callAPI('/api/partner/anti-theft/v1/status', body);
}

async function resetSimLock({ imei, deviceTag }) {
  const body = {
    apiKey: config.API_KEY,
    imei: imei || '',
    deviceTag: deviceTag || '',
  };
  return callAPI('/api/partner/sim-lock/v1/reset', body);
}

function normalizeText(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function levenshteinDistance(a, b, maxDistance = Infinity) {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > maxDistance) return maxDistance + 1;
  const dp = Array.from({ length: n + 1 }, (_, i) => i);

  for (let i = 1; i <= m; i += 1) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const temp = dp[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = temp;
    }
  }

  return dp[n];
}

function fuzzyBrandMatch(productName, brand) {
  const normalized = normalizeText(productName);
  const normalizedBrand = normalizeText(brand);
  if (!normalized || !normalizedBrand) return false;
  if (normalized.includes(normalizedBrand)) return true;

  const words = normalized.split(/\s+/).filter(Boolean);
  const maxDistance = normalizedBrand.length <= 4 ? 1 : 2;

  for (const word of words) {
    if (levensteinMatch(word, normalizedBrand, maxDistance)) return true;
  }

  for (let i = 0; i + normalizedBrand.length <= normalized.length; i += 1) {
    const snippet = normalized.slice(i, i + normalizedBrand.length);
    if (levensteinMatch(snippet, normalizedBrand, 1)) return true;
  }

  return false;
}

function levensteinMatch(a, b, maxDistance) {
  return levenshteinDistance(a, b, maxDistance) <= maxDistance;
}

function detectBrand(productName) {
  if (!productName) return null;
  for (const [brand, pattern] of Object.entries(config.BRAND_PATTERNS)) {
    if (pattern.test(productName)) return brand;
  }

  for (const brand of Object.keys(config.BRAND_PATTERNS)) {
    if (fuzzyBrandMatch(productName, brand)) return brand;
  }

  return null;
}

function isEligible(productName, category) {
  if (!productName) return false;
  const cat = (category || '').toLowerCase().trim();
  const isMobileCat = config.SUPPORTED_CATEGORIES.some(c => cat.includes(c));
  const brand = detectBrand(productName);
  return isMobileCat && brand !== null;
}

module.exports = {
  generateSign,
  preEnrollImei,
  updateRepayInfo,
  removeLock,
  queryLockState,
  batchQueryLockState,
  tempUnlock,
  unenroll,
  setLockRule,
  getDeviceTag,
  pushMessage,
  checkLicense,
  getOfflinePin,
  queryCompanyConfig,
  updateCompanyLockRule,
  submitFindPhone,
  closeFindPhone,
  statusFindPhone,
  resetSimLock,
  detectBrand,
  isEligible,
  ENABLED: () => config.ENABLED,
};
