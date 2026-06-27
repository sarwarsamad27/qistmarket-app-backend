process.env.TZ = 'Asia/Karachi';
const prisma = require('./lib/prisma');
console.log('Date test:', new Date());
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');

// ────────────────────────────────────────────────
// Route Imports
// ────────────────────────────────────────────────
const paytriggerRoutes = require('./src/routes/paytriggerRoutes');
const hrRoutes = require('./src/routes/hrRoutes');
const employeePortalRoutes = require('./src/routes/employeePortalRoutes');
const smartPayWebhookRoutes = require('./src/routes/smartPayWebhookRoutes');
const ledgerRoutes = require('./src/routes/ledgerRoutes');
const appVersionRoutes = require('./src/routes/appVersionRoutes');
const authRoutes = require('./src/routes/authRoutes');
const orderRoutes = require('./src/routes/orderRoutes');
const { expireOrders } = require('./src/controllers/ordersController');
const verificationRoutes = require('./src/routes/verificationRoutes');
const appVerificationOtpRoutes = require('./src/routes/appVerificationOtpRoutes');
const deliveryRoutes = require('./src/routes/deliveryRoutes');
const deliveryManagement = require('./src/routes/deliveryManagement');
const officerRoutes = require('./src/routes/officerRoutes');      // ← new officer realtime routes
const notificationRoutes = require('./src/routes/notificationRoutes');
const assignmentRoutes = require('./src/routes/assignmentRoutes');
const addressRoutes = require('./src/routes/addressRoutes');
const reportRoutes = require('./src/routes/reportRoutes');
const productRoutes = require('./src/routes/productRoutes');
const recoveryRoutes = require('./src/routes/recoveryRoutes');
const customerRoutes = require('./src/routes/customerRoutes');
const outletRoutes = require('./src/routes/outletRoutes');
const cashRegisterRoutes = require('./src/routes/cashRegisterRoutes');
const expenseRoutes = require('./src/routes/expenseRoutes');
const vendorRoutes = require('./src/routes/vendorRoutes');
const inventoryRoutes = require('./src/routes/inventoryRoutes');
const outletReportRoutes = require('./src/routes/outletReportRoutes');
const searchRoutes = require('./src/routes/searchRoutes');
const securityLogRoutes = require('./src/routes/securityLogRoutes');
const complaintRoutes = require('./src/routes/complaintRoutes');
const tpsRoutes = require('./src/routes/tpsRoutes');
const { checkOverdueDevices } = require('./src/controllers/paytriggerController');

// JWT secret (must be set in .env)
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('JWT_SECRET is not defined in environment variables');
  process.exit(1);
}

const app = express();
const server = http.createServer(app);

// ────────────────────────────────────────────────
// Socket.IO Setup
// ────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: [
      "http://localhost:3000",
      "http://localhost:5173",           // Vite default
      "http://127.0.0.1:3000",
      "https://qistmarket-app-dashboard.onrender.com",   // ← change to real domain
      "https://your-flutter-web-domain.com",       // if you have web version
      "*"
    ],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.set('io', io);

// Shared in-memory map to track which officer is currently active in a verification screen
const officerVerificationActiveMap = require('./src/utils/officerVerificationActiveMap');

io.on('connection', (socket) => {
  // Officer marks a verification as active (enters verification screen)
  socket.on('officer_verification_active', async ({ officerId, verificationId }) => {
    try {
      // Persist in DB
      await prisma.user.update({
        where: { id: officerId },
        data: { 
          current_active_verification_id: verificationId,
          updated_at: new Date(),
        },
      });
      const verification = await prisma.verification.findUnique({
        where: { id: verificationId },
        include: { order: { select: { order_ref: true, customer_name: true } } }
      });
      if (verification) {
        io.to('admins').emit('officer_current_verification_update', {
          officerId,
          current_verification: {
            id: verification.id,
            status: verification.status,
            order: verification.order,
          },
        });
      }
    } catch (err) {
      console.error('officer_verification_active error:', err.message);
    }
  });

  // Officer leaves verification screen (becomes inactive)
  socket.on('officer_verification_inactive', async ({ officerId }) => {
    try {
      // Persist in DB
      await prisma.user.update({
        where: { id: officerId },
        data: { 
          current_active_verification_id: null,
          updated_at: new Date(),
        },
      });
      io.to('admins').emit('officer_current_verification_update', {
        officerId,
        current_verification: null,
      });
    } catch (err) {
      console.error('officer_verification_inactive error:', err.message);
    }
  });
  console.log(`Client connected → ${socket.id}`);

  // Admin joins notifications room
  socket.on('join_admin_notifications', (token) => {
    if (!token) return;
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if ([4, 6, 7, 9].includes(decoded.role_id)) {
        socket.join('admins');
        socket.emit('joined_admin_room', { success: true, userId: decoded.id });
        console.log(`Admin ${decoded.id} joined admins room`);
      }

      // All users join their own personal room
      socket.join(`user_${decoded.id}`);
      socket.emit('joined_user_room', { success: true, userId: decoded.id });
      console.log(`User ${decoded.id} joined personal room user_${decoded.id}`);

      // Check if user belongs to an outlet and join that room too
      prisma.user.findUnique({
        where: { id: decoded.id },
        select: { outlet_id: true }
      }).then(user => {
        if (user && user.outlet_id) {
          socket.join(`outlet_${user.outlet_id}`);
          console.log(`User ${decoded.id} joined outlet room outlet_${user.outlet_id}`);
        }
      }).catch(err => console.error("Error joining outlet room:", err));
    } catch (err) {
      socket.emit('auth_error', { message: 'Invalid or expired token' });
    }
  });

  let officerId = null;

  socket.on('officer_login', async (token) => {
    if (!token) return;

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      console.log(`[socket][officer_login] token decoded → id=${decoded.id}, role=${decoded.role}, role_id=${decoded.role_id}`);

      const isVerificationOfficer = decoded.role === 'Verification Officer' || decoded.role_id === 1;
      const isDeliveryAgent = decoded.role === 'Delivery Agent' || decoded.role_id === 3;
      const isDeliveryOfficer = decoded.role === 'Delivery Officer' || decoded.role_id === 2;

      if (!isVerificationOfficer && !isDeliveryAgent && !isDeliveryOfficer) {
        console.warn(`[socket][officer_login] REJECTED → role not allowed: ${decoded.role} (role_id=${decoded.role_id})`);
        socket.emit('auth_error', { message: 'Not an authorized Officer/Agent' });
        return;
      }

      officerId = decoded.id;
      socket.officerId = officerId;

      // ─── Join rooms immediately so events can be sent ───────────────────────
      socket.join('verification_officers');
      socket.join(`officer_${officerId}`);
      socket.join(`user_${officerId}`);
      console.log(`[socket][officer_login] ✅ Officer ${officerId} joined rooms: officer_${officerId}, user_${officerId}`);

      socket.emit('officer_online_confirmed', { officerId, is_online: true });

      // ─── DB operations in separate try/catch so they can't block above ─────
      try {
        await prisma.user.update({
          where: { id: officerId },
          data: { 
            is_online: true, 
            last_online_at: new Date(),
            updated_at: new Date(), 
          },
        });

        let session = await prisma.officerSession.findFirst({
          where: { officer_id: officerId, end_time: null },
        });

        if (!session) {
          session = await prisma.officerSession.create({
            data: { 
              officer_id: officerId, 
              start_time: new Date(),
              created_at: new Date(), 
            },
          });
        }

        io.to('admins').emit('officer_status_update', {
          officerId,
          is_online: true,
          timestamp: new Date(),
        });

        const today = new Date().toISOString().split('T')[0];
        const dailyAgg = await prisma.officerSession.aggregate({
          where: {
            officer_id: officerId,
            start_time: {
              gte: new Date(`${today}T00:00:00.000Z`),
              lt: new Date(`${today}T23:59:59.999Z`),
            },
          },
          _sum: { duration_minutes: true },
        });
        const dailyHours = ((dailyAgg._sum.duration_minutes || 0) / 60).toFixed(2);
        io.to('admins').emit('officer_daily_update', { officerId, date: today, online_hours: dailyHours });

        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const monthlyAgg = await prisma.officerSession.aggregate({
          where: { officer_id: officerId, start_time: { gte: startOfMonth } },
          _sum: { duration_minutes: true },
        });
        const monthlyHours = ((monthlyAgg._sum.duration_minutes || 0) / 60).toFixed(2);
        io.to('admins').emit('officer_monthly_update', {
          officerId,
          monthly_online_hours: monthlyHours,
          month: now.toISOString().slice(0, 7),
        });

        console.log(`Officer ${officerId} → ONLINE ✅`);
      } catch (dbErr) {
        console.error(`[socket][officer_login] DB error for officer ${officerId} (non-critical):`, dbErr.message);
      }

    } catch (err) {
      console.error('officer_login auth error:', err.message);
      socket.emit('auth_error', { message: 'Invalid token' });
    }
  });



  // Transfer OTP Event Handler
  socket.on('stock_transfer_otp', (data) => {
    const { otp_log_id, action, message, otp, created_at } = data;
    try {
      console.log(`[Stock Transfer OTP] OTP Log ID: ${otp_log_id}, Action: ${action}, Created: ${created_at}`);
    } catch (err) {
      console.error('stock_transfer_otp handler error:', err.message);
    }
  });

  // Cash Submission OTP Event Handler (Mirroring Stock Transfer)
  socket.on('cash_submission_otp', (data) => {
    const { otp_log_id, action, message, otp, created_at } = data;
    try {
      console.log(`[Cash Submission OTP] OTP Log ID: ${otp_log_id}, Action: ${action}, Created: ${created_at}`);
    } catch (err) {
      console.error('cash_submission_otp handler error:', err.message);
    }
  });

  // Location update (unchanged, already emits to admins)
  socket.on('update_officer_location', async (data) => {
    if (!officerId) return;

    const { latitude, longitude, accuracy, verification_id } = data;
    if (typeof latitude !== 'number' || typeof longitude !== 'number') return;

    try {
      await prisma.user.update({
        where: { id: officerId },
        data: {
          last_known_latitude: latitude,
          last_known_longitude: longitude,
          last_online_at: new Date(),
          is_online: true,
          updated_at: new Date(),
        },
      });

      if (verification_id) {
        await prisma.locationTracking.create({
          data: {
            verification_id: Number(verification_id),
            latitude,
            longitude,
            accuracy: accuracy ? Number(accuracy) : null,
            label: 'live_position',
            timestamp: new Date(),
          },
        });
      }

      io.to('admins').emit('officer_location_update', {
        officerId,
        latitude,
        longitude,
        accuracy,
        timestamp: new Date(),
      });
    } catch (err) {
      console.error('Location update failed:', err.message);
    }
  });

  socket.on('disconnect', async () => {
    if (!officerId) return;

    try {
      const openSession = await prisma.officerSession.findFirst({
        where: { officer_id: officerId, end_time: null },
        orderBy: { start_time: 'desc' },
      });

      let dailyHours = '0.00';
      let monthlyHours = '0.00';
      let today = new Date().toISOString().split('T')[0];

      if (openSession) {
        const endTime = new Date();
        const durationMs = endTime.getTime() - openSession.start_time.getTime();
        const durationMin = Math.round(durationMs / 60000);

        await prisma.officerSession.update({
          where: { id: openSession.id },
          data: { end_time: endTime, duration_minutes: durationMin },
        });

        // ────────────────────────────────────────────────
        // Recalculate & emit DAILY delta
        // ────────────────────────────────────────────────
        const sessionDate = openSession.start_time.toISOString().split('T')[0];
        today = sessionDate; // use session date

        const dailyAgg = await prisma.officerSession.aggregate({
          where: {
            officer_id: officerId,
            start_time: {
              gte: new Date(`${sessionDate}T00:00:00.000Z`),
              lt: new Date(`${sessionDate}T23:59:59.999Z`),
            },
          },
          _sum: { duration_minutes: true },
        });

        dailyHours = ((dailyAgg._sum.duration_minutes || 0) / 60).toFixed(2);

        io.to('admins').emit('officer_daily_update', {
          officerId,
          date: sessionDate,
          online_hours: dailyHours,
        });

        // ────────────────────────────────────────────────
        // Recalculate & emit MONTHLY delta (current month)
        // ────────────────────────────────────────────────
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

        const monthlyAgg = await prisma.officerSession.aggregate({
          where: {
            officer_id: officerId,
            start_time: { gte: startOfMonth },
          },
          _sum: { duration_minutes: true },
        });

        monthlyHours = ((monthlyAgg._sum.duration_minutes || 0) / 60).toFixed(2);

        io.to('admins').emit('officer_monthly_update', {
          officerId,
          monthly_online_hours: monthlyHours,
          month: now.toISOString().slice(0, 7),
        });
      }

      // Mark user offline
      await prisma.user.update({
        where: { id: officerId },
        data: { is_online: false, 
          last_online_at: new Date(),
          updated_at: new Date(),
        },
      });

      io.to('admins').emit('officer_status_update', {
        officerId,
        is_online: false,
        timestamp: new Date(),
      });

      console.log(`Officer ${officerId} → OFFLINE`);
    } catch (err) {
      console.error('Disconnect handler error:', err.message);
    }

    officerId = null;
  });
});

// ────────────────────────────────────────────────
// Express Middleware
// ────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    socketio: 'enabled',
    timestamp: new Date(),
  });
});

// ────────────────────────────────────────────────
// Routes
// ────────────────────────────────────────────────
app.use('/api', paytriggerRoutes);
app.use('/api/hr', hrRoutes);
app.use('/api', employeePortalRoutes);
app.use('/api/smartpay/webhook', smartPayWebhookRoutes);
app.use('/ledger', ledgerRoutes);
app.use('/api/app-version', appVersionRoutes);   // Public ledger routes — no auth required, must be first!
app.use('/api/ledger', ledgerRoutes);
app.use('/api', authRoutes);
app.use('/api', outletRoutes); // Moved up
app.use('/api', orderRoutes);
app.use('/api', verificationRoutes);
app.use('/api', appVerificationOtpRoutes);
app.use('/api', deliveryRoutes);
app.use('/api', deliveryManagement);
app.use('/api', officerRoutes);           // ← officer realtime endpoints
app.use('/api', notificationRoutes);
app.use('/api/assignments', assignmentRoutes);
app.use('/api/address', addressRoutes);
app.use('/api', productRoutes);
app.use('/api/recovery', recoveryRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api', complaintRoutes);
app.use('/api/Payments', tpsRoutes);
app.use('/api', reportRoutes);
app.use('/api', cashRegisterRoutes);
app.use('/api', expenseRoutes);
app.use('/api', vendorRoutes);
app.use('/api', inventoryRoutes);
app.use('/api', outletReportRoutes);
app.use('/api', searchRoutes);
app.use('/api/security-logs', securityLogRoutes);


// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: { code: 404, message: 'Route not found' },
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Global error:', err.stack);
  res.status(500).json({
    success: false,
    error: { code: 500, message: 'Internal server error' },
  });
});

// ────────────────────────────────────────────────
// Start Server
// ────────────────────────────────────────────────
const PORT = process.env.PORT;

server.listen(PORT, () => {
  console.log(`═══════════════════════════════════════════════════════`);
  console.log(`Server + Socket.IO running on port ${PORT}`);
  console.log(`Environment     : ${process.env.NODE_ENV || 'development'}`);
  console.log(`CORS origins    : ${io.engine.opts.cors.origin}`);
  console.log(`Time            : ${new Date().toLocaleString('en-PK')}`);
  console.log(`═══════════════════════════════════════════════════════`);

  const runExpiryTask = async () => {
    try {
      const result = await expireOrders(io);
      if (result.expiredCount > 0) {
        console.log(`Order expiry task: expired ${result.expiredCount} order(s)`);
      }
    } catch (err) {
      console.error('Order expiry task failed:', err);
    }
  };

  // ── Expire pending online cash submissions after 24 hours ──────────────────
  const expirePendingCashSubmissions = async () => {
    try {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

      // Find all pending submission histories older than 24 hours
      const expired = await prisma.cashSubmissionHistory.findMany({
        where: { status: 'pending', submission_date: { lt: cutoff } },
        select: { id: true, submission_ref: true }
      });

      if (expired.length === 0) return;

      const refs = [...new Set(expired.map(e => e.submission_ref).filter(Boolean))];

      // Cancel the submission histories
      await prisma.cashSubmissionHistory.updateMany({
        where: { status: 'pending', submission_date: { lt: cutoff } },
        data: { status: 'cancelled' }
      });

      // Cancel pending officer transactions
      if (refs.length > 0) {
        await prisma.officerTransaction.updateMany({
          where: { submission_ref: { in: refs }, status: 'pending' },
          data: { status: 'cancelled' }
        });

        // Reset the ConsumerNumbers for these refs
        for (const ref of refs) {
          const consumer = await prisma.consumerNumber.findFirst({
            where: { cash_submission_ref: ref }
          });
          if (consumer) {
            await prisma.consumerNumber.update({
              where: { id: consumer.id },
              data: { bill_status: 'P', amount_due: 0, cash_submission_ref: null }
            });

            // Notify the officer via socket
            if (consumer.user_id) {
              io.to(`user_${consumer.user_id}`).emit('online_cash_submission_cancelled', {
                status: 'cancelled',
                submission_ref: ref,
                message: 'Your online cash submission expired after 24 hours.'
              });
            }
          }
        }

        console.log(`Cash expiry: cancelled ${refs.length} pending online submission(s)`);
      }
    } catch (err) {
      console.error('Cash submission expiry task failed:', err);
    }
  };

  runExpiryTask();
  setInterval(runExpiryTask, 5 * 60 * 1000);

  expirePendingCashSubmissions();
  setInterval(expirePendingCashSubmissions, 30 * 60 * 1000); // every 30 minutes

  // ── PayTrigger overdue device check ───────────────────────────────────
  const runPayTriggerCheck = async () => {
    try {
      const result = await checkOverdueDevices(io);
      if (result.checked > 0) {
        console.log(`[PayTrigger] Overdue check: ${result.checked} checked, ${result.locked} locked`);
      }
    } catch (err) {
      console.error('[PayTrigger] Overdue check failed:', err);
    }
  };
  runPayTriggerCheck();
  setInterval(runPayTriggerCheck, 60 * 60 * 1000); // every hour
});

// Graceful shutdown
const gracefulShutdown = (signal) => {
  console.log(`${signal} received. Shutting down gracefully...`);
  server.close(() => {
    console.log('HTTP & Socket.IO server closed.');
    process.exit(0);
  });

  // Force exit after 10 seconds if shutdown hangs
  setTimeout(() => {
    console.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));