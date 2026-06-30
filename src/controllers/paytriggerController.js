const prisma = require('../../lib/prisma');
const pt = require('../services/paytriggerService');
const { logAction } = require('../utils/auditLogger');
const { getNormalizedLedger } = require('../utils/ledgerUtils');

const now = () => new Date();

async function enrollDevice(req, res) {
  try {
    const { order_id } = req.body;
    if (!order_id) return res.status(400).json({ success: false, message: 'order_id required' });

    const order = await prisma.order.findUnique({
      where: { id: parseInt(order_id) },
      include: { delivery: true, installment_ledger: true },
    });

    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (!order.delivery?.product_imei) return res.status(400).json({ success: false, message: 'No IMEI on delivery' });

    const imei = order.delivery.product_imei;
    const productName = order.product_name;
    const inventory = await prisma.outletInventory.findFirst({ where: { imei_serial: imei }, select: { category: true } });
    const category = inventory?.category || '';

    if (!pt.isEligible(productName, category)) {
      return res.json({ success: false, message: 'Device brand not supported by PayTrigger', skipped: true });
    }

    const ledgerRows = order.installment_ledger?.ledger_rows;
    let firstDueDate = new Date();
    firstDueDate.setMonth(firstDueDate.getMonth() + 1);
    if (Array.isArray(ledgerRows) && ledgerRows.length > 0) {
      const firstInstallment = ledgerRows.find(r => r.month === 1);
      if (firstInstallment?.due_date) firstDueDate = new Date(firstInstallment.due_date);
      else if (ledgerRows[0]?.due_date) firstDueDate = new Date(ledgerRows[0].due_date);
    }

    const result = await pt.preEnrollImei(imei, order.order_ref, productName, firstDueDate);
    if (!result) return res.json({ success: false, message: 'PayTrigger disabled', skipped: true });

    if (result.code === 200) {
      await prisma.payTriggerDevice.create({
        data: {
          imei,
          order_id: order.id,
          order_ref: order.order_ref,
          delivery_id: order.delivery?.id || null,
          product_model: productName,
          enrollment_status: 'pre_enrolled',
          server_state: 500,
          expiration: firstDueDate,
          last_sync_at: now(),
          raw_state: result,
        },
      });
      await logAction(req, 'PAYTRIGGER_ENROLL', `Device ${imei} pre-enrolled in PayTrigger for order ${order.order_ref}`, order.id, 'Order');
      return res.json({ success: true, message: 'Device pre-enrolled successfully', data: result });
    }

    return res.status(400).json({ success: false, message: 'PayTrigger enrollment failed', data: result });
  } catch (error) {
    console.error('[PayTrigger] enrollDevice error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function getDeviceStatus(req, res) {
  try {
    const { imei } = req.params;
    if (!imei) return res.status(400).json({ success: false, message: 'IMEI required' });

    const local = await prisma.payTriggerDevice.findUnique({ where: { imei } });
    let remote = null;
    if (pt.ENABLED()) {
      try {
        remote = await pt.queryLockState({ imei, deviceTag: local?.device_tag || '' });
      } catch (e) { console.warn('[PayTrigger] queryLockState failed:', e.message); }
    }

    return res.json({ success: true, data: { local, remote } });
  } catch (error) {
    console.error('[PayTrigger] getDeviceStatus error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function syncDeviceStatus(req, res) {
  try {
    const { imei } = req.params;
    if (!imei) return res.status(400).json({ success: false, message: 'IMEI required' });

    const device = await prisma.payTriggerDevice.findUnique({ where: { imei } });
    if (!device) return res.status(404).json({ success: false, message: 'Device not found' });

    if (!pt.ENABLED()) return res.json({ success: false, message: 'PayTrigger disabled', skipped: true });

    const result = await pt.queryLockState({ imei, deviceTag: device.device_tag || '' });
    if (result?.code === 200 && result?.data) {
      const d = result.data;
      await prisma.payTriggerDevice.update({
        where: { imei },
        data: {
          server_state: d.serverState,
          lock_status: d.mobileStatus === 1000 ? 'locked' : (d.mobileStatus === 2000 ? 'unlocked' : 'unknown'),
          mobile_status: d.mobileStatus,
          device_tag: d.deviceTag || device.device_tag,
          active_time: d.activeTime ? new Date(d.activeTime * 1000) : undefined,
          last_connect_time: d.lastConnectTime ? new Date(d.lastConnectTime * 1000) : undefined,
          expiration: d.expiration ? new Date(d.expiration * 1000) : undefined,
          enrollment_status: d.serverState === 500 ? 'pre_enrolled' : d.serverState === 1000 ? 'registered' : d.serverState === 2000 ? 'ready_to_activate' : d.serverState === 3000 ? 'active' : d.serverState === 4000 ? 'locked' : d.serverState === 5000 ? 'removable' : device.enrollment_status,
          last_sync_at: now(),
          raw_state: result,
        },
      });
    }

    return res.json({ success: true, data: result });
  } catch (error) {
    console.error('[PayTrigger] syncDeviceStatus error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function manualLock(req, res) {
  try {
    const { imei } = req.params;
    const device = await prisma.payTriggerDevice.findUnique({ where: { imei } });
    if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
    if (!pt.ENABLED()) return res.json({ success: false, message: 'PayTrigger disabled', skipped: true });

    // PayTrigger doesn't have a direct "lock" API - lock happens via expiration.
    // We call updateRepayInfo with overdue status or set a past expiration.
    // For manual lock, we set the expiration to now to trigger immediate lock.
    const pastDate = new Date(Date.now() - 86400000);
    const result = await pt.updateRepayInfo({
      imei,
      deviceTag: device.device_tag || '',
      orderNum: device.order_ref || '',
      phoneNum: '',
      repayedAmt: 0,
      totalAmt: 0,
      nextRepayTime: pastDate,
      nextRepayAmt: 0,
      currentTerm: 1,
      totalTerm: 1,
      description: 'Manual lock from dashboard',
    });

    if (result?.code === 200) {
      await prisma.payTriggerDevice.update({
        where: { imei },
        data: { lock_status: 'locked', last_sync_at: now(), raw_state: result },
      });
      await logAction(req, 'PAYTRIGGER_LOCK', `Device ${imei} manually locked`, device.order_id, 'Order');
    }

    return res.json({ success: true, data: result });
  } catch (error) {
    console.error('[PayTrigger] manualLock error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function manualUnlock(req, res) {
  try {
    const { imei } = req.params;
    const device = await prisma.payTriggerDevice.findUnique({ where: { imei } });
    if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
    if (!pt.ENABLED()) return res.json({ success: false, message: 'PayTrigger disabled', skipped: true });

    const result = await pt.removeLock({ imei, deviceTag: device.device_tag || '' });

    if (result?.code === 200) {
      await prisma.payTriggerDevice.update({
        where: { imei },
        data: {
          lock_status: 'unlocked',
          server_state: 5000,
          enrollment_status: 'removable',
          last_sync_at: now(),
          raw_state: result,
        },
      });
      await logAction(req, 'PAYTRIGGER_UNLOCK', `Device ${imei} manually unlocked`, device.order_id, 'Order');
    }

    return res.json({ success: true, data: result });
  } catch (error) {
    console.error('[PayTrigger] manualUnlock error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function promiseToPay(req, res) {
  try {
    const { imei } = req.params;
    const { promised_date } = req.body;
    if (!promised_date) return res.status(400).json({ success: false, message: 'promised_date required' });

    const device = await prisma.payTriggerDevice.findUnique({ where: { imei } });
    if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
    if (!pt.ENABLED()) return res.json({ success: false, message: 'PayTrigger disabled', skipped: true });

    const promisedAt = new Date(promised_date);
    if (promisedAt <= now()) return res.status(400).json({ success: false, message: 'Promised date must be in future' });

    // 1. Temp unlock
    const unlockResult = await pt.tempUnlock({ imei, deviceTag: device.device_tag || '' });
    if (!unlockResult || unlockResult.code !== 200) {
      return res.status(400).json({ success: false, message: 'Temp unlock failed', data: unlockResult });
    }

    // 2. Extend expiration to promised date
    const updateResult = await pt.updateRepayInfo({
      imei,
      deviceTag: device.device_tag || '',
      orderNum: device.order_ref || '',
      phoneNum: '',
      repayedAmt: 0,
      totalAmt: 0,
      nextRepayTime: promisedAt,
      nextRepayAmt: 0,
      currentTerm: 1,
      totalTerm: 1,
      description: 'Promise to Pay - temp unlock',
    });

    // 3. Save PTP record
    const ptpEntry = {
      date: now().toISOString(),
      promised_date: promisedAt.toISOString(),
      previous_expiration: device.expiration?.toISOString(),
      status: 'active',
    };
    const history = Array.isArray(device.ptp_history) ? [...device.ptp_history, ptpEntry] : [ptpEntry];

    await prisma.payTriggerDevice.update({
      where: { imei },
      data: {
        ptp_status: 'active',
        promised_date: promisedAt,
        expiration: promisedAt,
        lock_status: 'unlocked',
        ptp_history: history,
        last_sync_at: now(),
        raw_state: updateResult || unlockResult,
      },
    });

    await logAction(req, 'PAYTRIGGER_PTP', `PTP activated for device ${imei}, promised date: ${promised_date}`, device.order_id, 'Order');

    return res.json({ success: true, message: 'PTP activated, device temporarily unlocked' });
  } catch (error) {
    console.error('[PayTrigger] promiseToPay error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function handleCallback(req, res) {
  try {
    const payload = req.body;
    console.log('[PayTrigger] Callback received:', JSON.stringify(payload));

    const { deviceTag, imei, state, notifyType, expiration, activeTime, mobileStatus, serverState, orderNum } = payload;

    let device = null;
    if (deviceTag) device = await prisma.payTriggerDevice.findFirst({ where: { device_tag: deviceTag } });
    if (!device && imei) device = await prisma.payTriggerDevice.findUnique({ where: { imei } });

    if (!device) {
      console.warn('[PayTrigger] Callback for unknown device:', deviceTag, imei);
      return res.json({ code: 200, message: 'Success' });
    }

    const updateData = {};
    if (deviceTag) updateData.device_tag = deviceTag;
    if (state !== undefined) {
      updateData.server_state = state;
      updateData.enrollment_status = state === 500 ? 'pre_enrolled' : state === 1000 ? 'registered' : state === 2000 ? 'ready_to_activate' : state === 3000 ? 'active' : state === 4000 ? 'locked' : state === 5000 ? 'removable' : device.enrollment_status;
    }
    if (expiration) updateData.expiration = new Date(expiration * 1000);
    if (activeTime) updateData.active_time = new Date(activeTime * 1000);
    if (mobileStatus) updateData.mobile_status = mobileStatus;
    if (mobileStatus !== undefined) {
      updateData.lock_status = mobileStatus === 1000 ? 'locked' : mobileStatus === 2000 ? 'unlocked' : device.lock_status;
    }
    if (serverState !== undefined) updateData.server_state = serverState;
    updateData.last_sync_at = now();
    updateData.raw_state = payload;

    await prisma.payTriggerDevice.update({ where: { id: device.id }, data: updateData });

    if (notifyType === 1000) {
      // Activation callback - device is now active
      console.log(`[PayTrigger] Device ${imei || deviceTag} activated`);
    } else if (notifyType === 2000) {
      // Removal callback - device removed/uninstalled
      console.log(`[PayTrigger] Device ${imei || deviceTag} removed`);
    } else if (notifyType === 4000) {
      // Strong limit warning
      console.warn(`[PayTrigger] Strong limit warning for device ${imei || deviceTag}: ${payload.tip}`);
    }

    return res.json({ code: 200, message: 'Success' });
  } catch (error) {
    console.error('[PayTrigger] handleCallback error:', error);
    return res.json({ code: 200, message: 'Success' });
  }
}

async function listDevices(req, res) {
  try {
    const { page = 1, limit = 20, search = '', status = '', lock_status = '' } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const where = {};
    if (search) {
      where.OR = [
        { imei: { contains: search } },
        { order_ref: { contains: search } },
        { product_model: { contains: search } },
      ];
    }
    if (status) where.enrollment_status = status;
    if (lock_status) where.lock_status = lock_status;

    const [devices, total] = await Promise.all([
      prisma.payTriggerDevice.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { created_at: 'desc' },
        include: {
          order: {
            select: { customer_name: true, order_ref: true, status: true, installment_ledger: { select: { ledger_rows: true } } },
          },
          delivery: {
            select: { product_imei: true, end_time: true },
          },
        },
      }),
      prisma.payTriggerDevice.count({ where }),
    ]);

    return res.json({
      success: true,
      data: devices,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error('[PayTrigger] listDevices error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function syncAllDevices(req, res) {
  try {
    if (!pt.ENABLED()) return res.json({ success: false, message: 'PayTrigger disabled', skipped: true });

    const devices = await prisma.payTriggerDevice.findMany({
      where: { enrollment_status: { not: 'removable' } },
      take: 100,
    });

    if (devices.length === 0) return res.json({ success: true, message: 'No devices to sync', count: 0 });

    const imeis = devices.map(d => d.imei);
    const batchResult = await pt.batchQueryLockState({ imeis });

    let syncedCount = 0;
    if (batchResult?.code === 200 && Array.isArray(batchResult.data)) {
      for (const state of batchResult.data) {
        if (!state.imei) continue;
        const device = devices.find(d => d.imei === state.imei);
        if (!device) continue;

        await prisma.payTriggerDevice.update({
          where: { id: device.id },
          data: {
            server_state: state.serverState,
            lock_status: state.mobileStatus === 1000 ? 'locked' : state.mobileStatus === 2000 ? 'unlocked' : device.lock_status,
            mobile_status: state.mobileStatus,
            device_tag: state.deviceTag || device.device_tag,
            active_time: state.activeTime ? new Date(state.activeTime * 1000) : undefined,
            last_connect_time: state.lastConnectTime ? new Date(state.lastConnectTime * 1000) : undefined,
            expiration: state.expiration ? new Date(state.expiration * 1000) : undefined,
            last_sync_at: now(),
          },
        });
        syncedCount++;
      }
    }

    return res.json({ success: true, message: `Synced ${syncedCount}/${devices.length} devices` });
  } catch (error) {
    console.error('[PayTrigger] syncAllDevices error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function checkOverdueDevices(io = null) {
  try {
    if (!pt.ENABLED()) return { checked: 0, locked: 0 };

    const devices = await prisma.payTriggerDevice.findMany({
      where: {
        enrollment_status: { in: ['active', 'locked'] },
        expiration: { lt: now() },
        lock_status: 'unlocked',
      },
    });

    let lockedCount = 0;
    for (const device of devices) {
      try {
        const result = await pt.updateRepayInfo({
          imei: device.imei,
          deviceTag: device.device_tag || '',
          orderNum: device.order_ref || '',
          phoneNum: '',
          repayedAmt: 0,
          totalAmt: 0,
          nextRepayTime: new Date(Date.now() - 86400000),
          nextRepayAmt: 0,
          currentTerm: 1,
          totalTerm: 1,
          description: 'Auto-lock due to overdue',
        });

        if (result?.code === 200) {
          await prisma.payTriggerDevice.update({
            where: { id: device.id },
            data: { lock_status: 'locked', last_sync_at: now() },
          });
          lockedCount++;
          console.log(`[PayTrigger] Auto-locked device ${device.imei} (overdue)`);
        }
      } catch (e) {
        console.error(`[PayTrigger] Auto-lock failed for ${device.imei}:`, e.message);
      }
    }

    // Check PTP expired promises
    const ptpDevices = await prisma.payTriggerDevice.findMany({
      where: {
        ptp_status: 'active',
        promised_date: { lt: now() },
      },
    });

    for (const device of ptpDevices) {
      // Check if payment was made since PTP
      const recentPayment = await prisma.orderPayment.findFirst({
        where: { order_id: device.order_id, created_at: { gte: device.updated_at } },
      });

      if (!recentPayment) {
        // No payment, mark PTP as broken
        await prisma.payTriggerDevice.update({
          where: { id: device.id },
          data: { ptp_status: 'broken' },
        });
        console.log(`[PayTrigger] PTP broken for device ${device.imei}`);
      } else {
        await prisma.payTriggerDevice.update({
          where: { id: device.id },
          data: { ptp_status: 'fulfilled' },
        });
      }
    }

    return { checked: devices.length, locked: lockedCount };
  } catch (error) {
    console.error('[PayTrigger] checkOverdueDevices error:', error);
    return { checked: 0, locked: 0 };
  }
}

async function unenrollDevice(req, res) {
  try {
    const { imei } = req.params;
    if (!pt.ENABLED()) return res.json({ success: false, message: 'PayTrigger disabled', skipped: true });
    const result = await pt.unenroll(imei);
    if (result?.code === 200) {
      await prisma.payTriggerDevice.updateMany({
        where: { imei },
        data: { enrollment_status: 'unenrolled', lock_status: 'unlocked', last_sync_at: now() }
      });
    }
    return res.json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function tempUnlockDevice(req, res) {
  try {
    const { imei } = req.params;
    const { tempLockTime, timeUnit } = req.body;
    const device = await prisma.payTriggerDevice.findUnique({ where: { imei } });
    if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
    if (!pt.ENABLED()) return res.json({ success: false, message: 'PayTrigger disabled', skipped: true });
    const result = await pt.tempUnlock({ imei, deviceTag: device.device_tag, tempLockTime, timeUnit });
    return res.json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function setDeviceRule(req, res) {
  try {
    const { imei } = req.params;
    const { ruleNum, deviceTips, deeplink, deeplinkPkg, deviceTitle } = req.body;
    const device = await prisma.payTriggerDevice.findUnique({ where: { imei } });
    if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
    if (!pt.ENABLED()) return res.json({ success: false, message: 'PayTrigger disabled', skipped: true });
    const result = await pt.setLockRule({ imei, deviceTag: device.device_tag, ruleNum, deviceTips, deeplink, deeplinkPkg, deviceTitle });
    return res.json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function sendDevicePush(req, res) {
  try {
    const { imei } = req.params;
    const { title, content, pushType, h5link, deeplink, deeplinkPkg } = req.body;
    const device = await prisma.payTriggerDevice.findUnique({ where: { imei } });
    if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
    if (!pt.ENABLED()) return res.json({ success: false, message: 'PayTrigger disabled', skipped: true });
    const result = await pt.pushMessage({ imei, deviceTag: device.device_tag, title, content, pushType, h5link, deeplink, deeplinkPkg });
    return res.json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function getDeviceOfflinePin(req, res) {
  try {
    const { imei } = req.params;
    const { captcha } = req.body;
    const device = await prisma.payTriggerDevice.findUnique({ where: { imei } });
    if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
    if (!pt.ENABLED()) return res.json({ success: false, message: 'PayTrigger disabled', skipped: true });
    const result = await pt.getOfflinePin(imei, device.device_tag, captcha);
    return res.json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function updateDeviceRepayInfo(req, res) {
  try {
    const { imei } = req.params;
    const { repayedAmt, totalAmt, nextRepayTime, nextRepayAmt, currentTerm, totalTerm, currencyType, description } = req.body;
    const device = await prisma.payTriggerDevice.findUnique({ where: { imei } });
    if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
    if (!pt.ENABLED()) return res.json({ success: false, message: 'PayTrigger disabled', skipped: true });
    const result = await pt.updateRepayInfo({ 
      imei, 
      deviceTag: device.device_tag, 
      orderNum: device.order_ref, 
      phoneNum: '', 
      repayedAmt, totalAmt, nextRepayTime: new Date(nextRepayTime), nextRepayAmt, currentTerm, totalTerm, currencyType, description 
    });
    return res.json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function findPhoneSubmit(req, res) {
  try {
    const { imei } = req.params;
    const { contactInformation } = req.body;
    const device = await prisma.payTriggerDevice.findUnique({ where: { imei } });
    if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
    if (!pt.ENABLED()) return res.json({ success: false, message: 'PayTrigger disabled', skipped: true });
    const result = await pt.submitFindPhone({ imei, deviceTag: device.device_tag, contactInformation });
    return res.json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function findPhoneClose(req, res) {
  try {
    const { imei } = req.params;
    const device = await prisma.payTriggerDevice.findUnique({ where: { imei } });
    if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
    if (!pt.ENABLED()) return res.json({ success: false, message: 'PayTrigger disabled', skipped: true });
    const result = await pt.closeFindPhone({ imei, deviceTag: device.device_tag });
    return res.json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function findPhoneStatus(req, res) {
  try {
    const { imei } = req.params;
    const device = await prisma.payTriggerDevice.findUnique({ where: { imei } });
    if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
    if (!pt.ENABLED()) return res.json({ success: false, message: 'PayTrigger disabled', skipped: true });
    const result = await pt.statusFindPhone({ imei, deviceTag: device.device_tag });
    return res.json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function resetDeviceSimLock(req, res) {
  try {
    const { imei } = req.params;
    const device = await prisma.payTriggerDevice.findUnique({ where: { imei } });
    if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
    if (!pt.ENABLED()) return res.json({ success: false, message: 'PayTrigger disabled', skipped: true });
    const result = await pt.resetSimLock({ imei, deviceTag: device.device_tag });
    return res.json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function getCompanyConfig(req, res) {
  try {
    if (!pt.ENABLED()) return res.json({ success: false, message: 'PayTrigger disabled', skipped: true });
    const result = await pt.queryCompanyConfig();
    return res.json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function updateCompanyRule(req, res) {
  try {
    if (!pt.ENABLED()) return res.json({ success: false, message: 'PayTrigger disabled', skipped: true });
    const result = await pt.updateCompanyLockRule(req.body);
    return res.json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function checkCompanyLicense(req, res) {
  try {
    if (!pt.ENABLED()) return res.json({ success: false, message: 'PayTrigger disabled', skipped: true });
    const result = await pt.checkLicense();
    return res.json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function getDeviceTagRemote(req, res) {
  try {
    const { imei } = req.params;
    if (!imei) return res.status(400).json({ success: false, message: 'IMEI required' });
    
    if (!pt.ENABLED()) return res.json({ success: false, message: 'PayTrigger disabled', skipped: true });

    const result = await pt.getDeviceTag(imei);
    
    if (result?.code === 200 && result?.data?.deviceTag) {
      await prisma.payTriggerDevice.updateMany({
        where: { imei },
        data: { device_tag: result.data.deviceTag, last_sync_at: now() }
      });
    }

    return res.json({ success: true, data: result });
  } catch (error) {
    console.error('[PayTrigger] getDeviceTagRemote error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
}

module.exports = {
  enrollDevice,
  getDeviceStatus,
  syncDeviceStatus,
  manualLock,
  manualUnlock,
  promiseToPay,
  handleCallback,
  listDevices,
  syncAllDevices,
  checkOverdueDevices,
  getDeviceTagRemote,
  unenrollDevice,
  tempUnlockDevice,
  setDeviceRule,
  sendDevicePush,
  getDeviceOfflinePin,
  updateDeviceRepayInfo,
  findPhoneSubmit,
  findPhoneClose,
  findPhoneStatus,
  resetDeviceSimLock,
  getCompanyConfig,
  updateCompanyRule,
  checkCompanyLicense,
};
