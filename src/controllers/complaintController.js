const prisma = require('../../lib/prisma');
const { sendComplaintReceived, sendComplaintResolved } = require('../services/watiService');

const createComplaint = async (req, res) => {
  try {
    const { customer_name, customer_cnic, mobile_number, description } = req.body;

    if (!customer_name || !customer_cnic || !mobile_number || !description) {
      return res.status(400).json({
        success: false,
        error: { code: 400, message: 'customer_name, customer_cnic, mobile_number, and description are required.' },
      });
    }

    const complaintId = `CMP-${new Date().replace(/[^0-9]/g, '').slice(0, 14)}-${Math.floor(1000 + Math.random() * 9000)}`;

    // Build media URLs from uploaded files
    let mediaUrls = [];
    if (req.files && req.files.length > 0) {
      mediaUrls = req.files.map((file) => file.url).filter(Boolean);
    } else if (req.file) {
      mediaUrls = [req.file.url].filter(Boolean);
    }

    const complaint = await prisma.complaint.create({
      data: {
        complaint_id: complaintId,
        customer_name: customer_name.trim(),
        customer_cnic: customer_cnic ? customer_cnic.trim() : null,
        mobile_number: mobile_number.trim(),
        description: description.trim(),
        media_urls: mediaUrls.length > 0 ? mediaUrls : null,
        created_by_user_id: req.user?.id || null,
        status: 'New'
      },
    });

    // Notify customer
    await sendComplaintReceived(mobile_number, {
      customerName: customer_name.trim(),
      complaintId: complaintId
    });

    return res.status(201).json({
      success: true,
      message: 'Complaint recorded successfully.',
      data: { complaint },
    });
  } catch (error) {
    console.error('Create complaint error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' },
    });
  }
};

const getComplaints = async (req, res) => {
  try {
    const { status, tab, page = 1, limit = 20, search = '', my_only } = req.query;
    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    const where = {};

    // Tab-based filtering
    if (tab === 'unassigned') {
      where.assigned_to_user_id = null;
      where.status = { not: 'Solved' };
    } else if (tab === 'picked') {
      where.assigned_to_user_id = req.user?.id;
      where.status = { not: 'Solved' };
    } else if (tab === 'solved') {
      where.status = 'Solved';
    } else if (status) {
      const statusList = status.split(',').map((s) => s.trim());
      if (statusList.length > 1) {
        where.status = { in: statusList };
      } else {
        where.status = statusList[0];
      }
    }
    
    if (search) {
      const q = search.trim();
      where.OR = [
        { complaint_id: { contains: q } },
        { mobile_number: { contains: q } },
        { customer_name: { contains: q } },
        { customer_cnic: { contains: q } }
      ];
    }
    
    if (my_only === 'true') {
      where.created_by_user_id = req.user?.id;
    }

    const [complaints, total] = await prisma.$transaction([
      prisma.complaint.findMany({
        where,
        orderBy: { created_at: 'desc' },
        include: {
          created_by: { select: { id: true, full_name: true, role: { select: { name: true } } } },
          assigned_to: { select: { id: true, full_name: true } }
        },
        skip,
        take,
      }),
      prisma.complaint.count({ where }),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        complaints,
        pagination: {
          page: Number(page),
          limit: take,
          total,
          totalPages: Math.ceil(total / take),
          hasNext: skip + take < total,
          hasPrev: Number(page) > 1,
        },
      },
    });
  } catch (error) {
    console.error('Get complaints error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' },
    });
  }
};

const updateComplaint = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, resolution_note, assigned_to_user_id } = req.body;

    const existing = await prisma.complaint.findUnique({ where: { id: Number(id) } });
    if (!existing) {
      return res.status(404).json({ success: false, error: { code: 404, message: 'Complaint not found.' } });
    }

    // Restriction: Only CSR (or Super Admin) can mark as Solved
    if (status === 'Solved' && existing.status !== 'Solved') {
      const userRole = req.user?.role;
      // Note: role name might vary, checking for CSR as well if needed
      if (userRole !== 'Sales Officer' && userRole !== 'Super Admin' && userRole !== 'Admin' && userRole !== 'CSR') {
        return res.status(403).json({
          success: false,
          error: { code: 403, message: 'Only authorized staff can resolve complaints.' }
        });
      }
    }

    const updateData = {};
    if (status) updateData.status = status;
    if (resolution_note !== undefined) updateData.resolution_note = resolution_note;
    if (assigned_to_user_id !== undefined) updateData.assigned_to_user_id = assigned_to_user_id;

    const complaint = await prisma.complaint.update({
      where: { id: Number(id) },
      data: updateData,
    });

    if (status === 'Solved' && existing.status !== 'Solved') {
      await sendComplaintResolved(existing.mobile_number, {
        customerName: existing.customer_name,
        complaintId: existing.complaint_id,
        note: resolution_note || 'Resolved gracefully',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Complaint updated successfully.',
      data: { complaint },
    });
  } catch (error) {
    console.error('Update complaint error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' },
    });
  }
};

const pickComplaint = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const existing = await prisma.complaint.findUnique({ where: { id: Number(id) } });
    if (!existing) {
      return res.status(404).json({ success: false, error: { code: 404, message: 'Complaint not found.' } });
    }

    if (existing.assigned_to_user_id) {
      return res.status(400).json({ success: false, error: { code: 400, message: 'Complaint already assigned.' } });
    }

    const complaint = await prisma.complaint.update({
      where: { id: Number(id) },
      data: {
        assigned_to_user_id: userId,
        status: 'Assigned'
      },
    });

    return res.status(200).json({
      success: true,
      message: 'Complaint picked successfully.',
      data: { complaint },
    });
  } catch (error) {
    console.error('Pick complaint error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' },
    });
  }
};

const searchPurchasers = async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 3) {
      return res.status(200).json({ success: true, data: [] });
    }

    const purchasers = await prisma.purchaserVerification.findMany({
      where: {
        OR: [
          { cnic_number: { contains: q } },
          { name: { contains: q } }
        ]
      },
      take: 10,
      select: {
        id: true,
        name: true,
        cnic_number: true,
        telephone_number: true,
      }
    });

    return res.status(200).json({
      success: true,
      data: purchasers
    });
  } catch (error) {
    console.error('Search purchasers error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' },
    });
  }
};

module.exports = {
  createComplaint,
  getComplaints,
  updateComplaint,
  pickComplaint,
  searchPurchasers,
};
