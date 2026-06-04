const prisma = require('../../lib/prisma');
const jwt = require('jsonwebtoken');
const puppeteer = require('puppeteer');
const { saveOTP, verifyOTP } = require('../utils/otpUtils');
const { sendOTP, sendInstallmentPaymentReceipt, sendPartialInstallmentPaymentReceipt, sendNextInstallmentReminder } = require('../services/watiService');
const { updateCashRegister } = require('../utils/cashRegisterUtils');
const { getNormalizedLedger, normalizeLedger } = require('../utils/ledgerUtils');
const { logAction } = require('../utils/auditLogger');
const logoDataURI = '';

const LEDGER_TOKEN_SECRET = process.env.LEDGER_TOKEN_SECRET;

// Helper for current timestamp
const now = () => new Date();

// ─── Helpers ────────────────────────────────────────────────────────────────

const formatPKR = (amount) =>
  `PKR ${Number(amount || 0).toLocaleString('en-PK')}`;

const formatDate = (d) => {
  if (!d) return 'N/A';
  const date = new Date(d);
  return date.toLocaleDateString('en-PK', { day: '2-digit', month: 'short', year: 'numeric' });
};

const statusBadge = (status) => {
  const colors = { 
    paid: '#22c55e', 
    partial: '#3b82f6', 
    pending: '#f59e0b', 
    overdue: '#ef4444' 
  };
  const color = colors[status?.toLowerCase()] || '#6b7280';
  return `<span style="background:${color};color:#fff;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600;text-transform:capitalize;display:inline-block;">${status}</span>`;
};

// ─── Shared: fetch ledger data from DB ──────────────────────────────────────

async function fetchLedger(where) {
  return prisma.installmentLedger.findUnique({
    where,
    include: {
      order: {
        include: {
          verification: { include: { purchaser: true } },
          cash_in_hand: {
            take: 1,
            orderBy: { created_at: 'desc' },
            include: {
              officer: {
                select: { full_name: true, phone: true }
              }
            }
          },
        },
      },
      delivery: {
        select: {
          product_imei: true,
          selected_plan: true,
          end_time: true,
        },
      },
    },
  });
}

// ─── Shared: build HTML from ledger record (RESPONSIVE VERSION) ───────────────────────────────────

function buildLedgerHtml(ledger, { showPrintBtn = false } = {}, stockItem = null) {
  const order = ledger.order;
  const delivery = ledger.delivery;
  const purchaser = order.verification?.purchaser;
  const customerName = purchaser?.name || 'Customer';
  const cnic = purchaser?.cnic_number || 'N/A';
  const phone = purchaser?.telephone_number || 'N/A';
  const address = purchaser?.present_address || 'N/A';

  const cashRecord = order.cash_in_hand?.[0];
  const collectorName = cashRecord?.officer?.full_name || null;

  let plan = null;
  if (delivery?.selected_plan) {
    try {
      plan = typeof delivery.selected_plan === 'string'
        ? JSON.parse(delivery.selected_plan)
        : delivery.selected_plan;
    } catch (e) { plan = null; }
  }

  const productName = cashRecord?.product_name
    || stockItem?.product_name
    || plan?.productName
    || plan?.product_name
    || order.product_name
    || 'N/A';

  const imei = cashRecord?.imei_serial || delivery?.product_imei || 'N/A';

  const colorVariant = (() => {
    if (cashRecord?.color_variant) {
      const parts = cashRecord.color_variant.split('|').map(s => s.trim()).filter(Boolean);
      return parts.length ? parts.join(' / ') : cashRecord.color_variant;
    }
    if (stockItem?.color_variant) {
      return stockItem.color_variant;
    }
    const color = plan?.color || plan?.productColor || plan?.color_variant || plan?.product_color;
    const variant = plan?.variant || plan?.productVariant || plan?.product_variant;
    return color ? `${color}${variant ? ' / ' + variant : ''}` : 'N/A';
  })();

  const deliveryDate = formatDate(delivery?.end_time || ledger.created_at);

  // ── Use normalized ledger for consistent financial calculations ──
  const normalized = getNormalizedLedger(ledger.ledger_rows);
  const { advance_payment: advancePayment, installment_ledger: installmentRows, summary, rows: allRows } = normalized;

  const advanceAmount = advancePayment.amount;
  const totalAmount = summary.grandTotalDue;
  const totalPaidAmount = summary.grandTotalPaid;
  const remainingAmount = summary.grandTotalRemaining;
  const paidInstallmentCount = summary.paidInstallments;

  const printBtnHtml = showPrintBtn
    ? `<button class="print-btn no-print" onclick="window.print()">🖨️ PDF Save / Print Karen</button>`
    : '';

  return `<!DOCTYPE html>
<html lang="ur" dir="ltr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>Installment Ledger — ${order.order_ref}</title>
  <style>
    /* RESET & FULLY RESPONSIVE STYLES */
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: system-ui, 'Segoe UI', 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: #f1f5f9;
      color: #0f172a;
      font-size: 14px;
      line-height: 1.4;
      padding: 16px;
    }

    @media (min-width: 768px) {
      body {
        padding: 24px;
      }
    }

    /* Main container */
    .ledger-wrapper {
      max-width: 1280px;
      margin: 0 auto;
      width: 100%;
    }

    /* Cards & containers */
    .card-bg {
      background: #ffffff;
      border-radius: 24px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05), 0 10px 20px -5px rgba(0,0,0,0.02);
    }

    /* Header - Fully responsive */
    .ledger-header {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 20px;
      margin-bottom: 24px;
      background: white;
      padding: 20px;
      border-radius: 28px;
    }

    @media (min-width: 640px) {
      .ledger-header {
        padding: 20px 28px;
      }
    }

    .brand-area {
      display: flex;
      align-items: center;
      gap: 14px;
      flex-wrap: wrap;
    }

    .logo-img {
      height: 40px;
      width: auto;
      display: block;
    }

    @media (min-width: 768px) {
      .logo-img {
        height: 44px;
      }
    }

    .title-tag h1 {
      font-size: 1.3rem;
      font-weight: 800;
      color: #0f172a;
    }

    @media (min-width: 640px) {
      .title-tag h1 {
        font-size: 1.6rem;
      }
    }

    .title-tag p {
      font-size: 0.7rem;
      color: #475569;
      margin-top: 2px;
    }

    .ref-badge-area {
      background: #f8fafc;
      padding: 10px 16px;
      border-radius: 36px;
      width: 100%;
    }

    @media (min-width: 640px) {
      .ref-badge-area {
        width: auto;
        text-align: right;
      }
    }

    .ref-badge-area .ref {
      font-size: 0.75rem;
      font-weight: 500;
      color: #334155;
    }

    .ref-badge-area .ref strong {
      color: #dc2626;
    }

    .delivery-badge {
      display: inline-block;
      background: #dcfce7;
      color: #15803d;
      font-size: 0.7rem;
      font-weight: 700;
      padding: 4px 12px;
      border-radius: 30px;
      margin-top: 6px;
    }

    /* Stats Grid - Responsive */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 14px;
      margin-bottom: 28px;
    }

    .stat-item {
      background: white;
      border-radius: 20px;
      padding: 1rem;
      text-align: center;
      border: 1px solid #eef2ff;
    }

    @media (min-width: 768px) {
      .stat-item {
        padding: 1.25rem;
      }
    }

    .stat-value {
      font-size: 1.3rem;
      font-weight: 800;
      color: #0f172a;
      word-break: break-word;
    }

    @media (min-width: 640px) {
      .stat-value {
        font-size: 1.6rem;
      }
    }

    @media (min-width: 1024px) {
      .stat-value {
        font-size: 1.8rem;
      }
    }

    .stat-label {
      font-size: 0.65rem;
      text-transform: uppercase;
      font-weight: 600;
      letter-spacing: 0.5px;
      color: #5b6e8c;
      margin-top: 6px;
    }

    /* Action Bar */
    .action-bar {
      margin-bottom: 24px;
      display: flex;
      justify-content: flex-end;
    }

    .print-btn {
      background: #dc2626;
      color: white;
      border: none;
      padding: 12px 24px;
      border-radius: 60px;
      font-weight: 700;
      font-size: 0.9rem;
      cursor: pointer;
      width: 100%;
    }

    @media (min-width: 480px) {
      .print-btn {
        width: auto;
      }
    }

    /* Info Panels - 2 column responsive */
    .info-panels {
      display: grid;
      grid-template-columns: 1fr;
      gap: 20px;
      margin-bottom: 28px;
    }

    @media (min-width: 768px) {
      .info-panels {
        grid-template-columns: repeat(2, 1fr);
      }
    }

    .info-card {
      background: white;
      border-radius: 24px;
      padding: 1.2rem;
    }

    @media (min-width: 640px) {
      .info-card {
        padding: 1.2rem 1.5rem;
      }
    }

    .section-title {
      font-size: 0.7rem;
      font-weight: 800;
      letter-spacing: 0.8px;
      text-transform: uppercase;
      color: #dc2626;
      margin-bottom: 16px;
      border-bottom: 1.5px solid #f1f5f9;
      padding-bottom: 10px;
    }

    .info-grid-2col {
      display: grid;
      grid-template-columns: 1fr;
      gap: 12px;
    }

    @media (min-width: 480px) {
      .info-grid-2col {
        grid-template-columns: repeat(2, 1fr);
      }
    }

    .info-row {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .info-label {
      font-size: 0.65rem;
      font-weight: 600;
      color: #6c86a3;
      text-transform: uppercase;
    }

    .info-val {
      font-size: 0.85rem;
      font-weight: 600;
      color: #1e293b;
      word-break: break-word;
    }

    /* Table - Horizontal Scroll on Mobile */
    .table-wrapper {
      overflow-x: auto;
      border-radius: 24px;
      background: white;
      margin-bottom: 24px;
      -webkit-overflow-scrolling: touch;
    }

    .ledger-table {
      width: 100%;
      border-collapse: collapse;
      min-width: 560px;
      font-size: 0.8rem;
    }

    @media (min-width: 768px) {
      .ledger-table {
        min-width: auto;
        font-size: 0.85rem;
      }
    }

    .ledger-table thead tr {
      background: #dc2626;
    }

    .ledger-table th {
      padding: 12px 10px;
      text-align: left;
      color: white;
      font-weight: 700;
      font-size: 0.7rem;
      text-transform: uppercase;
    }

    @media (min-width: 640px) {
      .ledger-table th {
        padding: 14px 12px;
        font-size: 0.75rem;
      }
    }

    .ledger-table td {
      padding: 10px 10px;
      border-bottom: 1px solid #f0f2f5;
    }

    @media (min-width: 640px) {
      .ledger-table td {
        padding: 12px 12px;
      }
    }

    .ledger-table tbody tr:nth-child(even) {
      background-color: #fefcfc;
    }

    .ledger-table tbody tr.current-month {
      background: #fff5f0;
    }

    .ledger-table tbody tr.advance-row {
      background: #fffbeb;
      border-left: 3px solid #f59e0b;
    }

    .ledger-table tbody tr.advance-row td {
      color: #92400e;
      font-weight: 600;
    }

    tfoot tr {
      background: #f9fafb;
      font-weight: 800;
      border-top: 2px solid #e2e8f0;
    }

    tfoot td {
      padding: 12px 10px;
    }

    /* Footer */
    .footer-note {
      text-align: center;
      background: white;
      padding: 18px;
      border-radius: 24px;
      font-size: 0.7rem;
      color: #5b6e8c;
    }

    .footer-note strong {
      color: #dc2626;
    }

    /* Print Styles */
    @media print {
      body {
        background: white;
        padding: 0;
        margin: 0;
      }
      .ledger-wrapper {
        max-width: 100%;
        padding: 0.2in;
      }
      .action-bar,
      .print-btn,
      .no-print {
        display: none !important;
      }
      .ledger-header, .info-card, .stat-item, .table-wrapper, .footer-note {
        box-shadow: none;
        border: 1px solid #ddd;
        break-inside: avoid;
      }
      .ledger-table th {
        background: #333 !important;
        color: white !important;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
    }
  </style>
</head>
<body>
<div class="ledger-wrapper">

  <div class="ledger-header card-bg">
    <div class="brand-area">
      <img class="logo-img" src="${logoDataURI}" alt="QistMarket" />
      <div class="title-tag">
        <h1>Installment Ledger</h1>
        <p>Official Payment Record</p>
      </div>
    </div>
    <div class="ref-badge-area">
      <div class="ref">Order Ref: <strong>${order.order_ref}</strong></div>
      <div class="ref">Delivery Date: <strong>${deliveryDate}</strong></div>
      <div class="delivery-badge">✓ Delivered</div>
    </div>
  </div>

  <div class="action-bar no-print">
    ${printBtnHtml}
  </div>

  <div class="stats-grid">
    <div class="stat-item">
      <div class="stat-value">${formatPKR(totalAmount)}</div>
      <div class="stat-label">Grand Total</div>
    </div>
    <div class="stat-item">
      <div class="stat-value">${formatPKR(advanceAmount)}</div>
      <div class="stat-label">Advance Paid</div>
    </div>
    <div class="stat-item">
      <div class="stat-value">${formatPKR(totalPaidAmount)}</div>
      <div class="stat-label">Total Paid</div>
    </div>
    <div class="stat-item">
      <div class="stat-value">${formatPKR(remainingAmount)}</div>
      <div class="stat-label">Remaining</div>
    </div>
  </div>

  <div class="info-panels">
    <div class="info-card">
      <div class="section-title">👤 Customer Details</div>
      <div class="info-grid-2col">
        <div class="info-row"><span class="info-label">Customer Name</span><span class="info-val">${customerName}</span></div>
        <div class="info-row"><span class="info-label">CNIC</span><span class="info-val">${cnic}</span></div>
        <div class="info-row"><span class="info-label">Phone</span><span class="info-val">${phone}</span></div>
        <div class="info-row"><span class="info-label">Address</span><span class="info-val">${address}</span></div>
      </div>
    </div>
    <div class="info-card">
      <div class="section-title">📦 Product Details</div>
      <div class="info-grid-2col">
        <div class="info-row"><span class="info-label">Product</span><span class="info-val">${productName}</span></div>
        <div class="info-row"><span class="info-label">IMEI / Serial</span><span class="info-val">${imei}</span></div>
        <div class="info-row"><span class="info-label">Color / Variant</span><span class="info-val">${colorVariant}</span></div>
        <div class="info-row"><span class="info-label">Advance Paid</span><span class="info-val">${formatPKR(advanceAmount)}</span></div>
        <div class="info-row"><span class="info-label">Installments</span><span class="info-val">${paidInstallmentCount} / ${installmentRows.length} Paid</span></div>
        ${collectorName ? `<div class="info-row"><span class="info-label">Collected By</span><span class="info-val">${collectorName}</span></div>` : ''}
      </div>
    </div>
  </div>

  <div class="table-wrapper">
    <table class="ledger-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Mahina</th>
          <th>Due Date</th>
          <th>Amount Due</th>
          <th>Paid / Remaining</th>
          <th>Status</th>
          <th>Paid On</th>
        </tr>
      </thead>
      <tbody>
        ${allRows.map((row) => {
    const isAdvance = row.month === 0;
    const rowLabel = row.label || (isAdvance ? 'Advance Payment' : `Month ${row.month}`);
    const rowNum = isAdvance ? '✦' : row.month;
    
    // "Next" applies only to regular installment rows
    const priorInstallments = installmentRows.filter(r => r.month < row.month);
    const isNext = !isAdvance && row.status === 'pending' && priorInstallments.every(r => r.status === 'paid');
    
    const paidText = row.paidAmount > 0 ? formatPKR(row.paidAmount) : '—';
    const remainingText = row.remainingAmount > 0 ? formatPKR(row.remainingAmount) : '—';

    return `<tr class="${isAdvance ? 'advance-row' : ''} ${isNext ? 'current-month' : ''}">
            <td>${rowNum}</td>
            <td>
              <div style="font-weight:700;">${rowLabel}${isNext ? ' <span style="color:#3b82f6; font-size: 0.6rem; vertical-align: middle;">⬅ Next</span>' : ''}</div>
              ${row.arrears ? `<div style="color: #ef4444; font-size: 0.65rem; font-weight: 500;">Arrears: ${formatPKR(row.arrears)}</div>` : ''}
             </div>
            </td>
            <td>${formatDate(row.due_date)}</div>
            <td style="font-weight: 700;">${formatPKR(row.dueAmount)}</div>
            <td>
              <div style="color: #16a34a; font-size: 0.75rem;">Paid: ${paidText}</div>
              <div style="color: #ef4444; font-size: 0.75rem;">Rem: ${remainingText}</div>
             </div>
            <td>${statusBadge(row.status)}</div>
            <td style="font-size: 0.75rem; color: #64748b;">${row.paid_at ? formatDate(row.paid_at) : '—'}</div>
            </tr>`;
  }).join('')}
      </tbody>
      <tfoot>
        <tr>
          <td colspan="3"><strong>Grand Total (Advance + Installments)</strong></div>
          <td><strong>${formatPKR(totalAmount)}</strong></div>
          <td colspan="2"><strong>Remaining: ${formatPKR(remainingAmount)}</strong></div>
        </tr>
      </tfoot>
    </table>
  </div>

  <div class="footer-note">
    <p>Yeh document <strong>Qist Market</strong> ki taraf se generate kiya gaya hai.</p>
    <p style="margin-top:6px;">Kisi bhi inquiry ke liye QistMarket support se rabta karen.</p>
    <p style="margin-top:6px;">Generated: ${new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })}</p>
  </div>
</div>
</body>
</html>`;
}

// ─── GET /api/ledger/:token  (legacy — HTML view with token) ─────────────────

const viewLedger = async (req, res) => {
  const { token } = req.params;

  try {
    let decoded;
    try {
      decoded = jwt.verify(token, LEDGER_TOKEN_SECRET);
    } catch (err) {
      return res.status(401).send(renderErrorPage('Link invalid ya expire ho gaya hai.'));
    }

    const ledger = await fetchLedger({ order_id: parseInt(decoded.order_id) });
    if (!ledger) {
      return res.status(404).send(renderErrorPage('Ledger nahi mila. Meherbani karke support se rabta karen.'));
    }

    const stockItem = ledger.delivery?.product_imei
      ? await prisma.outletInventory.findFirst({ where: { imei_serial: ledger.delivery.product_imei } })
      : null;
    const html = buildLedgerHtml(ledger, { showPrintBtn: true }, stockItem);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (error) {
    console.error('[LedgerController] viewLedger error:', error);
    return res.status(500).send(renderErrorPage('Server error. Meherbani karke baad mein try karen.'));
  }
};

// ─── GET /api/ledger/pdf/:shortId  (new — direct PDF download) ───────────────

const downloadLedgerPdf = async (req, res) => {
  const { shortId } = req.params;

  try {
    const ledger = await fetchLedger({ short_id: shortId });
    if (!ledger) {
      return res.status(404).send(renderErrorPage('Ledger nahi mila. Meherbani karke support se rabta karen.'));
    }

    const stockItem = ledger.delivery?.product_imei
      ? await prisma.outletInventory.findFirst({ where: { imei_serial: ledger.delivery.product_imei } })
      : null;
    const html = buildLedgerHtml(ledger, { showPrintBtn: false }, stockItem);

    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '16px', bottom: '16px', left: '16px', right: '16px' },
    });
    await browser.close();

    const orderRef = ledger.order?.order_ref || shortId;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="QistMarket-Ledger-${orderRef}.pdf"`);
    return res.send(pdf);
  } catch (error) {
    console.error('[LedgerController] downloadLedgerPdf error:', error);
    return res.status(500).send(renderErrorPage('PDF generate karne mein masla. Baad mein try karen.'));
  }
};

// ─── Error Page (responsive) ─────────────────────────────────────────────────

function renderErrorPage(message) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Error — QistMarket</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f8fafc;margin:0;padding:16px;}
    .box{text-align:center;padding:32px 24px;background:#fff;border-radius:24px;box-shadow:0 10px 25px -5px rgba(0,0,0,0.05);max-width:90%;width:400px;}
    h1{color:#ef4444;font-size:22px;margin-bottom:12px;}p{color:#64748b;font-size:15px;line-height:1.5;}
    @media (max-width:480px){.box{padding:24px 20px;} h1{font-size:20px;}}
  </style></head>
  <body><div class="box"><h1>❌ Khed hai!</h1><p>${message}</p>
  <p style="margin-top:16px;font-size:13px;color:#94a3b8;">QistMarket Support</p></div></body></html>`;
}

const generateInstallmentPaymentOtp = async (req, res) => {
  const { order_id } = req.body;

  try {
    const order = await prisma.order.findUnique({
      where: { id: parseInt(order_id) },
      include: {
        verification: { include: { purchaser: true } }
      }
    });

    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const phone = order.verification?.purchaser?.telephone_number || order.whatsapp_number;
    if (!phone) return res.status(400).json({ success: false, message: 'Customer phone number not found' });

    const otp = await saveOTP(phone, 'installment_payment');
    await sendOTP(phone, otp);

    return res.json({ success: true, message: 'OTP sent to customer' });
  } catch (error) {
    console.error('generateInstallmentPaymentOtp error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const verifyInstallmentPaymentOtp = async (req, res) => {
  const { order_id, month_number, otp, feedback, payment_method = 'Cash', amount } = req.body;
  const outlet_id = req.user.outlet_id;

  if (!outlet_id) return res.status(403).json({ success: false, message: 'Not an outlet user' });

  try {
    const order = await prisma.order.findUnique({
      where: { id: parseInt(order_id) },
      include: {
        verification: { include: { purchaser: true } },
        installment_ledger: true
      }
    });

    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const phone = order.verification?.purchaser?.telephone_number || order.whatsapp_number;
    const verification = await verifyOTP(phone, otp, 'installment_payment');

    if (!verification.valid) {
      return res.status(400).json({ success: false, message: verification.message });
    }

    const ledger = order.installment_ledger;
    if (!ledger) return res.status(404).json({ success: false, message: 'Ledger not found' });

    let rows = normalizeLedger(Array.isArray(ledger.ledger_rows) ? ledger.ledger_rows : []);
    const rowIndex = rows.findIndex(r => (r.month == month_number || r.monthNumber == month_number));

    if (rowIndex === -1) return res.status(404).json({ success: false, message: 'Installment month not found in ledger' });
    if (rows[rowIndex].status === 'paid') return res.status(400).json({ success: false, message: 'Installment already paid' });

    const dueAmount = parseFloat(rows[rowIndex].amount || rows[rowIndex].dueAmount || 0);
    const existingPaid = parseFloat(rows[rowIndex].paid_amount || 0);
    const payingNow = amount !== undefined ? parseFloat(amount) : (dueAmount - existingPaid);
    const totalPaid = existingPaid + payingNow;

    if (totalPaid > dueAmount + 1) {
      return res.status(400).json({ success: false, message: `Payment exceeds due amount. Remaining is ${dueAmount - existingPaid}` });
    }

    // Update current row
    rows[rowIndex].paid_amount = totalPaid;
    rows[rowIndex].paid_at = now();
    rows[rowIndex].payment_method = payment_method;
    rows[rowIndex].feedback = feedback;

    if (totalPaid >= dueAmount) {
      rows[rowIndex].status = 'paid';
    } else if (totalPaid > 0) {
      rows[rowIndex].status = 'partial';
    } else {
      rows[rowIndex].status = 'pending';
    }

    // Save Ledger with explicit updated_at
    await prisma.installmentLedger.update({
      where: { id: ledger.id },
      data: {
        ledger_rows: rows,
        updated_at: now()   // ✅ explicit updated_at
      }
    });

    // Create OrderPayment record with explicit timestamps
    await prisma.orderPayment.create({
      data: {
        order_id: order.id,
        paymentType: 'installment',
        monthNumber: parseInt(month_number),
        amount: parseFloat(payingNow),
        paymentMethod: payment_method,
        collectedBy_id: req.user.id,
        created_at: now(),   // ✅ explicit created_at
        paidAt: now()        // ✅ explicit paidAt
      }
    });

    // Update Cash Register
    await updateCashRegister(null, outlet_id, 'installments_received', payingNow, 'add');

    const customerName = order.verification?.purchaser?.name || order.customer_name;
    if (totalPaid >= dueAmount) {
      sendInstallmentPaymentReceipt(phone, {
        customerName,
        amount: payingNow,
        productName: order.product_name,
        orderRef: order.order_ref,
        date: new Date().toLocaleDateString('en-PK')
      }).catch(err => console.error('Wati Receipt Error:', err));
    } else {
      sendPartialInstallmentPaymentReceipt(phone, {
        customerName,
        paidAmount: payingNow,
        remainingAmount: Math.max(0, dueAmount - totalPaid),
        productName: order.product_name,
        orderRef: order.order_ref,
        dueDate: new Date(rows[rowIndex].due_date || rows[rowIndex].dueDate).toLocaleDateString('en-PK')
      }).catch(err => console.error('Wati Partial Receipt Error:', err));
    }

    // Send Next Month Reminder if exists
    const nextRow = rows[rowIndex + 1];
    if (nextRow) {
      sendNextInstallmentReminder(phone, {
        customerName,
        productName: order.product_name,
        monthlyAmount: nextRow.amount || nextRow.dueAmount,
        dueDate: new Date(nextRow.due_date || nextRow.dueDate).toLocaleDateString('en-PK'),
        ledgerUrl: ledger.token ? `${ledger.token}` : null
      });
    }

    await logAction(
      req,
      'INSTALLMENT_COLLECTION',
      `Collected PKR ${payingNow} from ${customerName} for order ${order.order_ref} at outlet. (Month: ${month_number})`,
      order.id,
      'Order'
    );

    return res.json({ success: true, message: 'Payment processed successfully' });
  } catch (error) {
    console.error('verifyInstallmentPaymentOtp error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

module.exports = {
  viewLedger,
  downloadLedgerPdf,
  generateInstallmentPaymentOtp,
  verifyInstallmentPaymentOtp
};