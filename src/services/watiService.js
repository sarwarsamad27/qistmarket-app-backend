const axios = require('axios');
require('dotenv').config();

const WATI_ACCESS_TOKEN = process.env.WATI_ACCESS_TOKEN;
const WATI_BASE_URL = process.env.WATI_BASE_URL;

// ─── Helpers ───────────────────────────────────────────────────────────────

const normalizePhone = (phone) => {
  if (!phone) return null;
  const p = phone.replace(/\s+/g, '').replace(/-/g, '');
  if (p.startsWith('03') && p.length === 11) return '+92' + p.slice(1);
  if (!p.startsWith('+')) return '+' + p;
  return p;
};

const sendTemplate = async (phone, templateName, broadcastName, parameters) => {
  try {
    const whatsappNumber = normalizePhone(phone);
    if (!whatsappNumber) return { success: false, error: 'Invalid phone number' };

    const url = `${WATI_BASE_URL}/api/v2/sendTemplateMessage`;
    const payload = {
      template_name: templateName,
      broadcast_name: broadcastName,
      parameters,
    };

    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WATI_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      params: { whatsappNumber },
      timeout: 10000,
    });

    return { success: true, data: response.data };
  } catch (error) {
    console.error(`[WATI] Template "${templateName}" error:`, error.response?.data || error.message);
    return { success: false, error: error.response?.data?.info || error.message };
  }
};

// ─── OTP ───────────────────────────────────────────────────────────────────

const WATI_TEMPLATE_NAME = process.env.WATI_TEMPLATE_NAME || 'verifications_otp';
const WATI_BROADCAST_NAME = process.env.WATI_BROADCAST_NAME || 'verifications_otp';

const sendOTPWhatsApp = async (phone, otp) => {
  return sendTemplate(phone, WATI_TEMPLATE_NAME, WATI_BROADCAST_NAME, [
    { name: '1', value: otp },
  ]);
};

const sendOTP = async (phone, otp) => sendOTPWhatsApp(phone, otp);

// ─── Template 1: Delivery Confirmation ─────────────────────────────────────
// Params: customer_name, product_name, imei, color_variant, advance_amount,
//         delivery_date, order_ref, order_status

const WATI_DELIVERY_TEMPLATE = process.env.WATI_DELIVERY_CONFIRMATION_TEMPLATE || 'delivery_confirmation';
const WATI_DELIVERY_BROADCAST = process.env.WATI_DELIVERY_CONFIRMATION_TEMPLATE || 'delivery_confirmation';

const sendDeliveryConfirmation = async (phone, {
  customerName,
  productName,
  imei,
  colorVariant,
  advanceAmount,
  deliveryDate,
  orderRef,
  orderStatus,
}) => {
  const parameters = [
    { name: '1', value: customerName || 'Customer' },
    { name: '2', value: productName || 'N/A' },
    { name: '3', value: imei || 'N/A' },
    { name: '4', value: colorVariant || 'N/A' },
    { name: '5', value: String(advanceAmount || 0) },
    { name: '6', value: deliveryDate || new Date().toDateString() },
    { name: '7', value: orderRef || 'N/A' },
    { name: '8', value: orderStatus || 'Delivered' },
  ];
  return sendTemplate(phone, WATI_DELIVERY_TEMPLATE, WATI_DELIVERY_BROADCAST, parameters);
};

// ─── Template 2: Installment Ledger ────────────────────────────────────────
// Params: customer_name, product_name, order_ref, next_month_label,
//         monthly_amount, due_date, total_remaining, ledger_url

const WATI_LEDGER_TEMPLATE = process.env.WATI_INSTALLMENT_LEDGER_TEMPLATE || 'installment_ledger';
const WATI_LEDGER_BROADCAST = process.env.WATI_INSTALLMENT_LEDGER_TEMPLATE || 'installment_ledger';

const sendInstallmentLedger = async (phone, {
  customerName,
  productName,
  orderRef,
  nextMonthLabel,
  monthlyAmount,
  dueDate,
  totalRemaining,
  ledgerUrl,
}) => {
  const parameters = [
    { name: '1', value: customerName || 'Customer' },
    { name: '2', value: productName || 'N/A' },
    { name: '3', value: orderRef || 'N/A' },
    { name: '4', value: nextMonthLabel || 'Mahina 1' },
    { name: '5', value: String(monthlyAmount || 0) },
    { name: '6', value: dueDate || 'N/A' },
    { name: '7', value: String(totalRemaining || 0) },
    { name: '8', value: ledgerUrl || 'N/A' },
  ];
  return sendTemplate(phone, WATI_LEDGER_TEMPLATE, WATI_LEDGER_BROADCAST, parameters);
};

const WATI_PAYMENT_RECEIVED_TEMPLATE = process.env.WATI_PAYMENT_RECEIVED_TEMPLATE || 'installment_payment_received';
const WATI_PAYMENT_RECEIVED_BROADCAST = process.env.WATI_PAYMENT_RECEIVED_TEMPLATE || 'installment_payment_received';

const sendInstallmentPaymentReceipt = async (phone, {
  customerName,
  amount,
  productName,
  orderRef,
  date,
}) => {
  const parameters = [
    { name: '1', value: customerName || 'Customer' },
    { name: '2', value: String(amount || 0) },
    { name: '3', value: productName || 'N/A' },
    { name: '4', value: orderRef || 'N/A' },
    { name: '5', value: date || new Date().toDateString() },
  ];
  return sendTemplate(phone, WATI_PAYMENT_RECEIVED_TEMPLATE, WATI_PAYMENT_RECEIVED_BROADCAST, parameters);
};

// ─── Template 3.1: Partial Installment Received ─────────────────────────────
const WATI_PARTIAL_PAYMENT_TEMPLATE = process.env.WATI_PARTIAL_PAYMENT_TEMPLATE || 'installment_partial_received';
const WATI_PARTIAL_PAYMENT_BROADCAST = process.env.WATI_PARTIAL_PAYMENT_TEMPLATE || 'installment_partial_received';

const sendPartialInstallmentPaymentReceipt = async (phone, {
  customerName,
  paidAmount,
  remainingAmount,
  productName,
  orderRef,
  dueDate,
}) => {
  const parameters = [
    { name: '1', value: customerName || 'Customer' },
    { name: '2', value: String(paidAmount || 0) },
    { name: '3', value: String(remainingAmount || 0) },
    { name: '4', value: productName || 'N/A' },
    { name: '5', value: orderRef || 'N/A' },
    { name: '6', value: dueDate || 'N/A' },
  ];
  return sendTemplate(phone, WATI_PARTIAL_PAYMENT_TEMPLATE, WATI_PARTIAL_PAYMENT_BROADCAST, parameters);
};

// ─── Template 4: Next Month Reminder ──────────────────────────────────────
// Params: customer_name, product_name, monthly_amount, due_date, ledger_url
const WATI_REMINDER_TEMPLATE = process.env.WATI_INSTALLMENT_REMINDER_TEMPLATE || 'installment_reminder';
const WATI_REMINDER_BROADCAST = process.env.WATI_INSTALLMENT_REMINDER_TEMPLATE || 'installment_reminder';

const sendNextInstallmentReminder = async (phone, {
  customerName,
  productName,
  monthlyAmount,
  dueDate,
  ledgerUrl,
}) => {
  const parameters = [
    { name: '1', value: customerName || 'Customer' },
    { name: '2', value: productName || 'N/A' },
    { name: '3', value: String(monthlyAmount || 0) },
    { name: '4', value: dueDate || 'N/A' },
    { name: '5', value: ledgerUrl || 'N/A' },
  ];
  return sendTemplate(phone, WATI_REMINDER_TEMPLATE, WATI_REMINDER_BROADCAST, parameters);
};

// ─── Template 5: Complaint Received ───────────────────────────────────────
const WATI_COMPLAINT_RECEIVED_TEMPLATE = process.env.WATI_COMPLAINT_RECEIVED_TEMPLATE || 'complaint_received';
const WATI_COMPLAINT_RECEIVED_BROADCAST = process.env.WATI_COMPLAINT_RECEIVED_TEMPLATE || 'complaint_received';

const sendComplaintReceived = async (phone, { customerName, complaintId }) => {
  const parameters = [
    { name: '1', value: customerName || 'Customer' },
    { name: '2', value: complaintId || 'N/A' },
  ];
  return sendTemplate(phone, WATI_COMPLAINT_RECEIVED_TEMPLATE, WATI_COMPLAINT_RECEIVED_BROADCAST, parameters);
};

// ─── Template 6: Complaint Resolved ───────────────────────────────────────
const WATI_COMPLAINT_RESOLVED_TEMPLATE = process.env.WATI_COMPLAINT_RESOLVED_TEMPLATE || 'complaint_resolved';
const WATI_COMPLAINT_RESOLVED_BROADCAST = process.env.WATI_COMPLAINT_RESOLVED_TEMPLATE || 'complaint_resolved';

const sendComplaintResolved = async (phone, { customerName, complaintId, note }) => {
  const parameters = [
    { name: '1', value: customerName || 'Customer' },
    { name: '2', value: complaintId || 'N/A' },
    { name: '3', value: note || 'Resolved gracefully' },
  ];
  return sendTemplate(phone, WATI_COMPLAINT_RESOLVED_TEMPLATE, WATI_COMPLAINT_RESOLVED_BROADCAST, parameters);
};

// ─── Template 7: Generic Order Status Update ─────────────────────────────
const WATI_ORDER_STATUS_TEMPLATE = process.env.WATI_ORDER_STATUS_TEMPLATE || 'order_status_update';
const WATI_ORDER_STATUS_BROADCAST = process.env.WATI_ORDER_STATUS_TEMPLATE || 'order_status_update';

const sendOrderStatusNotification = async (phone, { customerName, message }) => {
  const parameters = [
    { name: '1', value: customerName || 'Customer' },
    { name: '2', value: message || 'Your order status has been updated.' },
  ];
  return sendTemplate(phone, WATI_ORDER_STATUS_TEMPLATE, WATI_ORDER_STATUS_BROADCAST, parameters);
};


module.exports = {
  sendOTP,
  sendDeliveryConfirmation,
  sendInstallmentLedger,
  sendInstallmentPaymentReceipt,
  sendPartialInstallmentPaymentReceipt,
  sendNextInstallmentReminder,
  sendComplaintReceived,
  sendComplaintResolved,
  sendOrderStatusNotification,
};