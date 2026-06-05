const prisma = require('../../lib/prisma');
const { logOrderStatusChange } = require('../utils/orderAuditLogger');
const { notifyAdmins, notifyOutlet } = require('../utils/notificationUtils');
const { sendOrderAssignmentNotification } = require('./ordersController');
const { checkBlacklistStatus } = require('../utils/blacklistUtils');
const { getNormalizedLedger } = require('../utils/ledgerUtils');
const { getOrCreateCustomer, updateCsrRanking } = require('../services/rankingService');
const { updateVerificationRanking } = require('../services/verificationRankingService');

// Helper for current timestamp
const now = () => new Date();

// Start Verification
const startVerification = async (req, res) => {
  const { order_id } = req.body;

  try {
    const existingVerification = await prisma.verification.findUnique({
      where: { order_id: parseInt(order_id) }
    });

    if (existingVerification) {
      return res.status(400).json({
        success: false,
        error: { code: 400, message: 'Verification already started for this order' }
      });
    }

    const order = await prisma.order.findUnique({
      where: { id: parseInt(order_id) }
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Order not found' }
      });
    }

    const verification = await prisma.verification.create({
      data: {
        order_id: parseInt(order_id),
        verification_officer_id: req.user.id,
        status: 'in_progress',
        start_time: now(),
        created_at: now(),      // ✅ explicit
        updated_at: now()       // ✅ explicit
      },
      include: {
        order: { select: { order_ref: true } },
        verification_officer: { select: { full_name: true, username: true } }
      }
    });

    await prisma.order.update({
      where: { id: parseInt(order_id) },
      data: {
        status: 'in_progress',
        updated_at: now()
      }
    });

    await logOrderStatusChange(parseInt(order_id), order.status, 'in_progress', req.user);

    // Create empty purchaser
    const purchaser = await prisma.purchaserVerification.create({
      data: {
        verification_id: verification.id,
        name: '',
        father_husband_name: '',
        present_address: '',
        permanent_address: '',
        nearest_location: '',
        cnic_number: '',
        telephone_number: '',
        employment_type: 'EMPLOYED',
        job_type: null,
        employer_name: '',
        employer_address: '',
        designation: '',
        official_number: null,
        years_in_company: null,
        gross_salary: null,
        business_name: null,
        established_since: null,
        business_address: null,
        net_income: null,
        service_card_url: null,
        signature_url: null,
        is_verified: false
      }
    });

    // Grantor 1
    const grantor1 = await prisma.grantorVerification.create({
      data: {
        verification_id: verification.id,
        grantor_number: 1,
        name: '',
        father_husband_name: '',
        present_address: '',
        permanent_address: '',
        nearest_location: '',
        cnic_number: '',
        telephone_number: '',
        employment_type: 'EMPLOYED',
        job_type: null,
        designation: '',
        official_number: null,
        office_address: '',
        company_name: null,
        years_in_company: null,
        monthly_income: null,
        business_name: null,
        established_since: null,
        business_address: null,
        net_income: null,
        full_residential_address: '',
        relationship: '',
        service_card_url: null,
        signature_url: null,
        is_verified: false
      }
    });

    // Grantor 2
    const grantor2 = await prisma.grantorVerification.create({
      data: {
        verification_id: verification.id,
        grantor_number: 2,
        name: '',
        father_husband_name: '',
        present_address: '',
        permanent_address: '',
        nearest_location: '',
        cnic_number: '',
        telephone_number: '',
        employment_type: 'EMPLOYED',
        job_type: null,
        designation: '',
        official_number: null,
        office_address: '',
        company_name: null,
        years_in_company: null,
        monthly_income: null,
        business_name: null,
        established_since: null,
        business_address: null,
        net_income: null,
        full_residential_address: '',
        relationship: '',
        service_card_url: null,
        signature_url: null,
        is_verified: false
      }
    });

    const io = req.app.get('io');
    await notifyAdmins(
      'Verification Started',
      `Visit started for Order #${verification.order.order_ref} by ${verification.verification_officer.full_name}`,
      'verification_start',
      verification.id,
      io
    );

    if (order.outlet_id) {
      await notifyOutlet(
        order.outlet_id,
        'Verification Started',
        `Verification visit has started for Order #${verification.order.order_ref}.`,
        'verification_start',
        verification.id,
        io
      );
    }

    // Emit real-time update for officer's current verification assignment
    if (io) {
      const currentVerification = {
        id: verification.id,
        status: verification.status,
        order: {
          order_ref: verification.order.order_ref,
          customer_name: order.customer_name,
        },
      };
      io.to('admins').emit('officer_current_verification_update', {
        officerId: verification.verification_officer_id,
        current_verification: currentVerification,
      });
    }

    return res.status(201).json({
      success: true,
      message: 'Verification started successfully',
      data: {
        verification,
        purchaser: { id: purchaser.id },
        grantor1: { id: grantor1.id },
        grantor2: { id: grantor2.id }
      }
    });
  } catch (error) {
    console.error('Start verification error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

// Save Purchaser Verification - WITH ORDER DATA SWAP LOGIC
const savePurchaserVerification = async (req, res) => {
  const { verification_id } = req.params;
  const {
    name,
    father_husband_name,
    present_address,
    present_zone,
    present_area,
    present_block,
    present_street,
    present_house_no,
    present_period_of_stay,
    permanent_address,
    permanent_zone,
    permanent_area,
    permanent_block,
    permanent_street,
    permanent_house_no,
    permanent_period_of_stay,
    nearest_location,
    cnic_number,
    telephone_number,
    employment_type,
    job_type,
    employer_name,
    employer_address,
    designation,
    official_number,
    years_in_company,
    gross_salary,
    business_name,
    established_since,
    business_address,
    net_income,
    order_id
  } = req.body;

  try {
    // Check if blacklisted
    const blacklistCheck = await checkBlacklistStatus(cnic_number);
    if (blacklistCheck.isBlacklisted) {
      return res.status(400).json({
        success: false,
        message: `Yeh black list hay (${blacklistCheck.personType}). Aap is customer ke liye verification nahi kar sakte.`
      });
    }

    const orders = await prisma.order.findUnique({
      where: { id: parseInt(order_id) },
    });

    if (!orders) {
      return res.status(404).json({ success: false, error: { code: 404, message: 'Order not found' } });
    }

    // ============================================================
    // 🔥 STEP 1: ORDER KA PURANA DUMMY DATA DUMMY_CUSTOMER TABLE MEIN SAVE KARO
    // ============================================================
    const ordersData = orders;

    // Check agar already dummy customer record exist karta hai toh update karo
    const existingDummyCustomer = await prisma.dummyCustomer.findFirst({
      where: { order_id: ordersData.id }
    });

    if (existingDummyCustomer) {
      // Update existing dummy record
      await prisma.dummyCustomer.update({
        where: { id: existingDummyCustomer.id },
        data: {
          customer_name: ordersData.customer_name,
          whatsapp_number: ordersData.whatsapp_number,
          address: ordersData.address,
          city: ordersData.city,
          area: ordersData.area,
          block: ordersData.block,
          house_no: ordersData.house_no,
          street: ordersData.street,
          zone: ordersData.zone,
          alternate_contact: ordersData.alternate_contact,
          moved_at: now()
        }
      });
    } else {
      // Create new dummy customer record
      await prisma.dummyCustomer.create({
        data: {
          order_id: ordersData.id,
          customer_name: ordersData.customer_name,
          whatsapp_number: ordersData.whatsapp_number,
          address: ordersData.address,
          city: ordersData.city,
          area: ordersData.area,
          block: ordersData.block,
          house_no: ordersData.house_no,
          street: ordersData.street,
          zone: ordersData.zone,
          alternate_contact: ordersData.alternate_contact,
          moved_at: now()
        }
      });
    }

    // ============================================================
    // 🔥 STEP 2: PURCHASER KI REAL DETAILS ORDER TABLE MEIN UPDATE KARO
    // ============================================================

    await prisma.order.update({
      where: { id: ordersData.id },
      data: {
        customer_name: name,  // Real name from purchaser
        whatsapp_number: telephone_number,  // Real phone from purchaser
        address: present_address,  // Real address from purchaser
        city: ordersData.city,
        area: present_area,
        block: present_block,
        house_no: present_house_no,
        street: present_street,
        zone: present_zone,
        alternate_contact: telephone_number,
        updated_at: now()
      }
    });

    // ============================================================
    // 🔥 STEP 3: PURCHASER VERIFICATION TABLE SAVE KARO (NORMAL)
    // ============================================================

    const data = {
      name: name || '',
      father_husband_name: father_husband_name || '',
      present_address: present_address || '',
      present_zone: present_zone || null,
      present_area: present_area || null,
      present_block: present_block || null,
      present_street: present_street || null,
      present_house_no: present_house_no || null,
      present_period_of_stay: present_period_of_stay || null,
      permanent_address: permanent_address || '',
      permanent_zone: permanent_zone || null,
      permanent_area: permanent_area || null,
      permanent_block: permanent_block || null,
      permanent_street: permanent_street || null,
      permanent_house_no: permanent_house_no || null,
      permanent_period_of_stay: permanent_period_of_stay || null,
      nearest_location: nearest_location || '',
      cnic_number: cnic_number || '',
      telephone_number: telephone_number || '',
      employment_type: employment_type || 'EMPLOYED',
      job_type: job_type || null,
      is_verified: true
    };

    if (employment_type === 'SELF_EMPLOYED') {
      data.business_name = business_name || null;
      data.established_since = established_since || null;
      data.business_address = business_address || null;
      data.net_income = net_income || null;

      data.employer_name = '';
      data.employer_address = '';
      data.designation = '';
      data.official_number = null;
      data.years_in_company = null;
      data.gross_salary = null;
    } else {
      data.employer_name = employer_name || '';
      data.employer_address = employer_address || '';
      data.designation = designation || '';
      data.official_number = official_number || null;
      data.years_in_company = years_in_company || null;
      data.gross_salary = gross_salary || null;

      data.business_name = null;
      data.established_since = null;
      data.business_address = null;
      data.net_income = null;
    }

    const purchaser = await prisma.purchaserVerification.upsert({
      where: { verification_id: parseInt(verification_id) },
      update: data,
      create: {
        verification: { connect: { id: parseInt(verification_id) } },
        ...data
      }
    });

    return res.status(200).json({
      success: true,
      message: 'Purchaser verification saved successfully!',
      data: {
        purchaser,
        order_updated: {
          customer_name: name,
          whatsapp_number: telephone_number,
          address: present_address
        }
      }
    });
  } catch (error) {
    console.error('Save purchaser error:', error);
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

// Save Grantor Verification (updated with nearest_location)
const saveGrantorVerification = async (req, res) => {
  const { verification_id, grantor_number } = req.params;
  const {
    name,
    father_husband_name,
    present_address,
    present_zone,
    present_area,
    present_block,
    present_street,
    present_house_no,
    present_period_of_stay,
    permanent_address,
    permanent_zone,
    permanent_area,
    permanent_block,
    permanent_street,
    permanent_house_no,
    permanent_period_of_stay,
    nearest_location,
    cnic_number,
    telephone_number,
    employment_type,
    job_type,
    designation,
    official_number,
    office_address,
    company_name,
    years_in_company,
    monthly_income,
    business_name,
    established_since,
    business_address,
    net_income,
    full_residential_address,
    relationship
  } = req.body;

  try {
    // Check if blacklisted
    const blacklistCheck = await checkBlacklistStatus(cnic_number);
    if (blacklistCheck.isBlacklisted) {
      return res.status(400).json({
        success: false,
        message: `Yeh black list hay (${blacklistCheck.personType}). Aap is shakhs ko grantor nahi bana sakte.`
      });
    }

    const verification = await prisma.verification.findUnique({
      where: { id: parseInt(verification_id) }
    });

    if (!verification) {
      return res.status(404).json({ success: false, error: { code: 404, message: 'Verification not found' } });
    }

    const grantorNum = parseInt(grantor_number);
    if (grantorNum !== 1 && grantorNum !== 2) {
      return res.status(400).json({ success: false, error: { code: 400, message: 'Grantor number must be 1 or 2' } });
    }

    const data = {
      name: name || '',
      father_husband_name: father_husband_name || '',
      present_address: present_address || '',
      present_zone: present_zone || null,
      present_area: present_area || null,
      present_block: present_block || null,
      present_street: present_street || null,
      present_house_no: present_house_no || null,
      present_period_of_stay: present_period_of_stay || null,
      permanent_address: permanent_address || '',
      permanent_zone: permanent_zone || null,
      permanent_area: permanent_area || null,
      permanent_block: permanent_block || null,
      permanent_street: permanent_street || null,
      permanent_house_no: permanent_house_no || null,
      permanent_period_of_stay: permanent_period_of_stay || null,
      nearest_location: nearest_location || '',
      cnic_number: cnic_number || '',
      telephone_number: telephone_number || '',
      office_address: office_address || '',
      full_residential_address: full_residential_address || '',
      relationship: relationship || '',
      employment_type: employment_type || 'EMPLOYED',
      job_type: job_type || null,
      is_verified: true
    };

    if (employment_type === 'SELF_EMPLOYED') {
      data.business_name = business_name || null;
      data.established_since = established_since || null;
      data.business_address = business_address || null;
      data.net_income = net_income || null;

      data.designation = '';
      data.official_number = null;
      data.company_name = null;
      data.years_in_company = null;
      data.monthly_income = null;
    } else {
      data.designation = designation || '';
      data.official_number = official_number || null;
      data.company_name = company_name || null;
      data.years_in_company = years_in_company || null;
      data.monthly_income = monthly_income || null;

      data.business_name = null;
      data.established_since = null;
      data.business_address = null;
      data.net_income = null;
    }

    let grantor;

    const existing = await prisma.grantorVerification.findFirst({
      where: {
        verification_id: parseInt(verification_id),
        grantor_number: grantorNum
      }
    });

    if (existing) {
      grantor = await prisma.grantorVerification.update({
        where: {
          verification_id_grantor_number: {
            verification_id: parseInt(verification_id),
            grantor_number: grantorNum
          }
        },
        data
      });
    } else {
      grantor = await prisma.grantorVerification.create({
        data: {
          verification: { connect: { id: parseInt(verification_id) } },
          grantor_number: grantorNum,
          ...data
        }
      });
    }

    return res.status(200).json({
      success: true,
      message: `Grantor ${grantorNum} verification saved successfully`,
      data: { grantor }
    });
  } catch (error) {
    console.error('Save grantor error:', error);
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

// Save Next of Kin
const saveNextOfKin = async (req, res) => {
  const { verification_id } = req.params;
  const {
    name,
    cnic_number,
    relation,
    phone_number
  } = req.body;

  try {
    const verification = await prisma.verification.findUnique({
      where: { id: parseInt(verification_id) }
    });

    if (!verification) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Verification not found' }
      });
    }

    let nextOfKin;

    const existing = await prisma.nextOfKinVerification.findUnique({
      where: { verification_id: parseInt(verification_id) }
    });

    if (existing) {
      nextOfKin = await prisma.nextOfKinVerification.update({
        where: { verification_id: parseInt(verification_id) },
        data: { name, cnic_number, relation, phone_number }
      });
    } else {
      nextOfKin = await prisma.nextOfKinVerification.create({
        data: {
          verification_id: parseInt(verification_id),
          name,
          cnic_number,
          relation,
          phone_number
        }
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Next of kin saved successfully',
      data: { next_of_kin: nextOfKin }
    });
  } catch (error) {
    console.error('Save next of kin error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

// Save Location Tracking
const saveLocation = async (req, res) => {
  const { verification_id } = req.params;
  const {
    latitude,
    longitude,
    accuracy,
    label
  } = req.body;

  try {
    const verification = await prisma.verification.findUnique({
      where: { id: parseInt(verification_id) }
    });

    if (!verification) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Verification not found' }
      });
    }

    const location = await prisma.locationTracking.create({
      data: {
        verification_id: parseInt(verification_id),
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude),
        accuracy: accuracy ? parseFloat(accuracy) : null,
        label,
        timestamp: now()
      }
    });

    return res.status(201).json({
      success: true,
      message: 'Location saved successfully',
      data: { location }
    });
  } catch (error) {
    console.error('Save location error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

// NEW: Save Verification Location with photos
const saveVerificationLocation = async (req, res) => {
  const { verification_id } = req.params;
  const {
    location_type,
    latitude,
    longitude,
    address,
    label,
    person_type,
    person_id
  } = req.body;

  try {
    const verification = await prisma.verification.findUnique({
      where: { id: parseInt(verification_id) }
    });

    if (!verification) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Verification not found' }
      });
    }

    // Create location first
    const location = await prisma.verificationLocation.create({
      data: {
        verification_id: parseInt(verification_id),
        location_type,
        latitude: latitude ? parseFloat(latitude) : null,
        longitude: longitude ? parseFloat(longitude) : null,
        address,
        label,
        person_type,
        person_id: person_id ? parseInt(person_id) : null,
        created_at: now()
      }
    });

    // Get uploaded photos (up to 5)
    const photos = req.files || [];

    // Save photos to separate table
    const photoPromises = photos.map(file =>
      prisma.verificationLocationPhoto.create({
        data: {
          verification_location_id: location.id,
          file_url: file.url,
          uploaded_at: now()
        }
      })
    );

    const savedPhotos = await Promise.all(photoPromises);

    // Get location with photos
    const locationWithPhotos = await prisma.verificationLocation.findUnique({
      where: { id: location.id },
      include: {
        photos: true
      }
    });

    return res.status(201).json({
      success: true,
      message: 'Location saved successfully',
      data: { location: locationWithPhotos }
    });
  } catch (error) {
    console.error('Save verification location error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

// NEW: Get Verification Locations
const getVerificationLocations = async (req, res) => {
  const { verification_id } = req.params;

  try {
    const locations = await prisma.verificationLocation.findMany({
      where: { verification_id: parseInt(verification_id) },
      include: {
        photos: true
      },
      orderBy: { created_at: 'desc' }
    });

    return res.status(200).json({
      success: true,
      data: { locations }
    });
  } catch (error) {
    console.error('Get verification locations error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

// NEW: Delete Verification Location
const deleteVerificationLocation = async (req, res) => {
  const { location_id } = req.params;

  try {
    const location = await prisma.verificationLocation.findUnique({
      where: { id: parseInt(location_id) },
      include: { photos: true }
    });

    if (!location) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Location not found' }
      });
    }

    // Check permission
    const verification = await prisma.verification.findUnique({
      where: { id: location.verification_id }
    });

    if (verification.verification_officer_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: { code: 403, message: 'Not authorized to delete this location' }
      });
    }

    // Delete photos first (cascade delete would be better if configured)
    await prisma.verificationLocationPhoto.deleteMany({
      where: { verification_location_id: parseInt(location_id) }
    });

    // Delete location
    await prisma.verificationLocation.delete({
      where: { id: parseInt(location_id) }
    });

    return res.status(200).json({
      success: true,
      message: 'Location deleted successfully'
    });
  } catch (error) {
    console.error('Delete verification location error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

// Upload Purchaser Document
const uploadPurchaserDocument = async (req, res) => {
  const { verification_id } = req.params;
  const { document_type } = req.body;

  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: { code: 400, message: 'No file uploaded' } });
    }

    const purchaser = await prisma.purchaserVerification.findUnique({
      where: { verification_id: parseInt(verification_id) }
    });

    if (!purchaser) {
      return res.status(404).json({ success: false, error: { code: 404, message: 'Purchaser record not found' } });
    }

    const document = await prisma.verificationDocument.create({
      data: {
        verification_id: parseInt(verification_id),
        document_type,
        person_type: 'purchaser',
        person_id: purchaser.id,
        file_url: req.file.url,
        label: `${document_type} - Purchaser`,
        uploaded_at: now()
      }
    });

    let updateData = {};
    if (document_type === 'cnic_front') updateData.cnic_front_url = req.file.url;
    if (document_type === 'cnic_back') updateData.cnic_back_url = req.file.url;
    if (document_type === 'utility_bill') updateData.utility_bill_url = req.file.url;
    if (document_type === 'service_card') updateData.service_card_url = req.file.url;
    if (document_type === 'signature') updateData.signature_url = req.file.url;

    if (Object.keys(updateData).length > 0) {
      await prisma.purchaserVerification.update({
        where: { id: purchaser.id },
        data: updateData
      });
    }

    return res.status(201).json({
      success: true,
      message: 'Purchaser document uploaded successfully',
      data: { document }
    });
  } catch (error) {
    console.error('Upload purchaser document error:', error);
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

// Upload Grantor Document
const uploadGrantorDocument = async (req, res) => {
  const { verification_id, grantor_number } = req.params;
  const { document_type } = req.body;

  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: { code: 400, message: 'No file uploaded' } });
    }

    const grantor = await prisma.grantorVerification.findFirst({
      where: {
        verification_id: parseInt(verification_id),
        grantor_number: parseInt(grantor_number)
      }
    });

    if (!grantor) {
      return res.status(404).json({ success: false, error: { code: 404, message: 'Grantor record not found' } });
    }

    const document = await prisma.verificationDocument.create({
      data: {
        verification_id: parseInt(verification_id),
        document_type,
        person_type: `grantor${grantor_number}`,
        person_id: grantor.id,
        file_url: req.file.url,
        label: `${document_type} - Grantor ${grantor_number}`,
        uploaded_at: now()
      }
    });

    let updateData = {};
    if (document_type === 'cnic_front') updateData.cnic_front_url = req.file.url;
    if (document_type === 'cnic_back') updateData.cnic_back_url = req.file.url;
    if (document_type === 'utility_bill') updateData.utility_bill_url = req.file.url;
    if (document_type === 'service_card') updateData.service_card_url = req.file.url;
    if (document_type === 'signature') updateData.signature_url = req.file.url;

    if (Object.keys(updateData).length > 0) {
      await prisma.grantorVerification.update({
        where: {
          verification_id_grantor_number: {
            verification_id: parseInt(verification_id),
            grantor_number: parseInt(grantor_number)
          }
        },
        data: updateData
      });
    }

    return res.status(201).json({
      success: true,
      message: `Grantor ${grantor_number} document uploaded successfully`,
      data: { document }
    });
  } catch (error) {
    console.error('Upload grantor document error:', error);
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

// Upload Photo
const uploadPhoto = async (req, res) => {
  const { verification_id } = req.params;
  const { person_type, person_id, label } = req.body;

  try {
    const verification = await prisma.verification.findUnique({
      where: { id: parseInt(verification_id) }
    });

    if (!verification) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Verification not found' }
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: { code: 400, message: 'No file uploaded' }
      });
    }

    const document = await prisma.verificationDocument.create({
      data: {
        verification_id: parseInt(verification_id),
        document_type: 'photo',
        person_type,
        person_id: person_id ? parseInt(person_id) : null,
        file_url: req.file.url,
        label: label || `Photo - ${person_type}`,
        uploaded_at: now()
      }
    });

    return res.status(201).json({
      success: true,
      message: 'Photo uploaded successfully',
      data: { document }
    });
  } catch (error) {
    console.error('Upload photo error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

// Upload Signature
const uploadSignature = async (req, res) => {
  const { verification_id } = req.params;
  const { person_type, person_id } = req.body;

  try {
    const verification = await prisma.verification.findUnique({
      where: { id: parseInt(verification_id) }
    });

    if (!verification) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Verification not found' }
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: { code: 400, message: 'No file uploaded' }
      });
    }

    // Save document
    const document = await prisma.verificationDocument.create({
      data: {
        verification_id: parseInt(verification_id),
        document_type: 'signature',
        person_type,
        person_id: person_id ? parseInt(person_id) : null,
        file_url: req.file.url,
        label: `Signature - ${person_type}`,
        uploaded_at: now()
      }
    });

    // Update respective person's signature URL
    if (person_type === 'purchaser' && person_id) {
      await prisma.purchaserVerification.update({
        where: { id: parseInt(person_id) },
        data: { signature_url: req.file.url }
      });
    } else if (person_type.startsWith('grantor') && person_id) {
      await prisma.grantorVerification.update({
        where: { id: parseInt(person_id) },
        data: { signature_url: req.file.url }
      });
    }

    return res.status(201).json({
      success: true,
      message: 'Signature uploaded successfully',
      data: { document }
    });
  } catch (error) {
    console.error('Upload signature error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

// Delete Document
const deleteDocument = async (req, res) => {
  const { document_id } = req.params;

  try {
    const document = await prisma.verificationDocument.findUnique({
      where: { id: parseInt(document_id) }
    });

    if (!document) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Document not found' }
      });
    }

    // Check if user has permission to delete this document
    const verification = await prisma.verification.findUnique({
      where: { id: document.verification_id }
    });

    if (verification.verification_officer_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: { code: 403, message: 'Not authorized to delete this document' }
      });
    }

    // Record Edit History
    await recordEditHistory(
      document.verification_id,
      document.person_type,
      document.person_id,
      document.document_type,
      document.file_url,
      'DELETED',
      req.user.id,
      req.user.full_name
    );

    // Delete document
    await prisma.verificationDocument.delete({
      where: { id: parseInt(document_id) }
    });

    return res.status(200).json({
      success: true,
      message: 'Document deleted successfully'
    });
  } catch (error) {
    console.error('Delete document error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

// Complete Verification
const completeVerification = async (req, res) => {
  const { verification_id } = req.params;

  try {
    const verification = await prisma.verification.findUnique({
      where: { id: parseInt(verification_id) },
      include: {
        purchaser: true,
        grantors: true,
        nextOfKin: true,
        documents: true,
        locations: true,
        verification_locations: { include: { photos: true } }
      }
    });

    if (!verification) {
      return res.status(404).json({ success: false, error: { code: 404, message: 'Verification not found' } });
    }

    if (!verification.purchaser) {
      return res.status(400).json({ success: false, error: { code: 400, message: 'Purchaser record is required' } });
    }

    if (!verification.purchaser.cnic_front_url || !verification.purchaser.cnic_back_url) {
      return res.status(400).json({
        success: false,
        error: { code: 400, message: 'Purchaser CNIC front and back are required' }
      });
    }

    const { home_location_required = false, feedback = null } = req.body;

    const updatedVerification = await prisma.verification.update({
      where: { id: parseInt(verification_id) },
      data: {
        status: 'completed',
        end_time: now(),
        home_location_required: home_location_required === true || home_location_required === 'true',
        verification_feedback: feedback || null,
        updated_at: now()   // ✅ explicit
      },
      include: {
        order: { select: { order_ref: true, id: true } },
        verification_officer: { select: { full_name: true, username: true, outlet_id: true } },
        purchaser: true,
        grantors: true,
        nextOfKin: true,
        locations: true,
        verification_locations: { include: { photos: true } },
        documents: true
      }
    });

    await prisma.order.update({
      where: { id: updatedVerification.order_id },
      data: {
        status: 'completed',
        updated_at: now(),
        outlet_id: updatedVerification.verification_officer?.outlet_id || null // Route back to the officer's outlet
      }
    });

    await logOrderStatusChange(updatedVerification.order_id, 'in_progress', 'completed', req.user);

    // FIX: Ensure customer is created/updated for CSR ranking logic
    try {
      const orderDb = await prisma.order.findUnique({
        where: { id: updatedVerification.order_id }
      });
      if (orderDb) {
        await getOrCreateCustomer(orderDb.id);
        if (orderDb.created_by_user_id) {
          await updateCsrRanking(orderDb.created_by_user_id, 'month');
          await updateCsrRanking(orderDb.created_by_user_id, 'today');
        }
      }
    } catch (e) {
      console.error('Error auto-syncing customer/ranking:', e);
    }

    const io = req.app.get('io');
    await notifyAdmins(
      'Verification Completed',
      `Verification completed for Order #${updatedVerification.order.order_ref}`,
      'verification_complete',
      updatedVerification.id,
      io
    );

    if (updatedVerification.verification_officer?.outlet_id) {
      await notifyOutlet(
        updatedVerification.verification_officer.outlet_id,
        'Verification Completed',
        `Verification has been completed for Order #${updatedVerification.order.order_ref}.`,
        'verification_complete',
        updatedVerification.id,
        io
      );
    }

    return res.status(200).json({
      success: true,
      message: 'Verification completed successfully',
      data: { verification: updatedVerification }
    });
  } catch (error) {
    console.error('Complete verification error:', error);
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

const getVerificationByOrderId = async (req, res) => {
  const { order_id } = req.params;

  try {
    const verification = await prisma.verification.findUnique({
      where: { order_id: parseInt(order_id) },
      include: {
        order: {
          select: {
            id: true,
            order_ref: true,
            status: true,
            customer_name: true,
            whatsapp_number: true,
            address: true,
            city: true,
            area: true,
            block: true,
            house_no: true,
            street: true,
            zone: true,
            alternate_contact: true,
            channel: true,
            created_at: true,
            delivery_assigned_at: true,
            recovery_assigned_at: true,
            verification_assigned_at: true,
            postponed_feedback: true,
            created_by: { select: { username: true, full_name: true } },
            assigned_to: { select: { username: true, full_name: true } },
            delivery_officer: { select: { username: true, full_name: true } },
            recovery_officer: { select: { username: true, full_name: true } },
            statusHistories: {
              include: {
                user: { select: { username: true, full_name: true } }
              },
              orderBy: { created_at: 'desc' }
            },
            delivery: {
              include: {
                uploads: true
              }
            },
            installment_ledger: true,
            recovery_visits: {
              include: {
                photos: true,
                officer: { select: { username: true, full_name: true } }
              },
              orderBy: { visit_time: 'desc' }
            }
          }
        },
        verification_officer: {
          select: { full_name: true, username: true, id: true }
        },
        purchaser: true,
        grantors: true,
        nextOfKin: true,
        locations: true,
        verification_locations: {
          include: { photos: true }
        },
        documents: true,
        reviews: {
          include: {
            reviewer: {
              select: {
                id: true,
                full_name: true,
                username: true
              }
            }
          }
        },
        edit_history: {
          include: {
            edited_by: {
              select: { full_name: true, username: true }
            }
          },
          orderBy: { edited_at: 'desc' }
        }
      }
    });

    if (!verification) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Verification not found for this order' }
      });
    }

    // Organize edit history by entity
    const purchaserHistory = verification.edit_history.filter(h => h.entity_type === 'purchaser');
    const grantor1History = verification.edit_history.filter(h => h.entity_type === 'grantor' && h.entity_id === verification.grantors[0]?.id);
    const grantor2History = verification.edit_history.filter(h => h.entity_type === 'grantor' && h.entity_id === verification.grantors[1]?.id);

    // Attach history to respective entities
    if (verification.purchaser) {
      verification.purchaser.edit_history = purchaserHistory;
    }

    verification.grantors = verification.grantors.map(grantor => {
      if (grantor.id === verification.grantors[0]?.id) {
        return { ...grantor, edit_history: grantor1History };
      } else if (grantor.id === verification.grantors[1]?.id) {
        return { ...grantor, edit_history: grantor2History };
      }
      return grantor;
    });

    return res.status(200).json({
      success: true,
      data: {
        verification
      }
    });

  } catch (error) {
    console.error('Get verification by order error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

// Submit Verification Review
const submitVerificationReview = async (req, res) => {
  const { verification_id } = req.params;
  let { approved, remarks } = req.body;

  try {
    const verification = await prisma.verification.findUnique({
      where: { id: parseInt(verification_id) },
      include: {
        order: { select: { id: true, order_ref: true } },  // we need order.id
        reviews: true
      }
    });

    if (!verification) {
      return res.status(404).json({ success: false, error: 'Verification not found' });
    }

    if (verification.reviews.length >= 3) {
      return res.status(400).json({
        success: false,
        error: 'Maximum of 3 reviews allowed'
      });
    }

    if (verification.reviews.some(r => r.reviewer_id === req.user.id)) {
      return res.status(400).json({
        success: false,
        error: 'You have already reviewed this verification'
      });
    }

    // Normalize approved value
    approved = approved === 'true' || approved === true;

    let finalRemarks = remarks?.trim() || null;

    if (!approved) {  // Reject case
      if (!finalRemarks) {
        return res.status(400).json({
          success: false,
          error: 'Remarks are required when rejecting'
        });
      }
    }

    // Create the review
    const review = await prisma.verificationReview.create({
      data: {
        verification_id: parseInt(verification_id),
        reviewer_id: req.user.id,
        approved,
        remarks: finalRemarks,
        created_at: now()
      }
    });

    // Reload verification with updated reviews
    const updated = await prisma.verification.findUnique({
      where: { id: parseInt(verification_id) },
      include: {
        reviews: true,
        order: { select: { id: true } }
      }
    });

    const approvesCount = updated.reviews.filter(r => r.approved).length;
    const rejectsCount = updated.reviews.filter(r => !r.approved).length;
    const totalReviews = updated.reviews.length;
    const approvalPercentage = totalReviews > 0 ? Math.round((approvesCount / totalReviews) * 100) : 0;

    let orderStatusUpdate = null;

    // Rule: 2 Approvals = Final Approved
    if (approvesCount >= 2) {
      orderStatusUpdate = 'approved';
    }
    // Rule: 2 Rejections = Auto Cancelled
    else if (rejectsCount >= 2) {
      orderStatusUpdate = 'rejected';
    }

    const updates = [];

    if (orderStatusUpdate) {
      updates.push(
        prisma.order.update({
          where: { id: verification.order.id },
          data: {
            status: orderStatusUpdate,
            updated_at: now()
          }
        })
      );
    }

    if (orderStatusUpdate) {
      await logOrderStatusChange(verification.order.id, verification.order.status || 'completed', orderStatusUpdate, req.user);
    }

    if (updates.length > 0) {
      await prisma.$transaction(updates);
    }

    // ── Notification ─────────────────────────────────────────────
    const io = req.app.get('io');
    await notifyAdmins(
      'Review Submitted',
      `Review added to Order #${verification.order.order_ref} → ${orderStatusUpdate?.toUpperCase() || 'UNCHANGED'} (${approvalPercentage}%)`,
      'review_submitted',
      parseInt(verification_id),
      io
    );

    if (verification.order.outlet_id) {
      await notifyOutlet(
        verification.order.outlet_id,
        'Review Submitted',
        `Order #${verification.order.order_ref} has been reviewed and is now ${orderStatusUpdate?.toUpperCase() || 'in process'}.`,
        'review_submitted',
        parseInt(verification_id),
        io
      );
    }

    return res.status(200).json({
      success: true,
      message: 'Review submitted successfully',
      data: {
        review,
        approvalPercentage,
        totalReviews,
        approvesCount,
        orderStatus: orderStatusUpdate || 'unchanged'
      }
    });

  } catch (error) {
    console.error('Submit review error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

const getVerifications = async (req, res) => {
  const { page = 1, limit = 10, search = '', sortBy = 'created_at', sortDir = 'desc', ...filters } = req.query;

  const skip = (Number(page) - 1) * Number(limit);
  const take = Number(limit);

  try {
    const where = {};

    if (search.trim()) {
      where.OR = [
        { order: { customer_name: { contains: search } } },
        { order: { whatsapp_number: { contains: search } } },
        { order: { order_ref: { contains: search } } },
        { order: { token_number: { contains: search } } },
        { order: { product_name: { contains: search } } },
        { order: { city: { contains: search } } },
        { order: { area: { contains: search } } },
      ];
    }

    Object.entries(filters).forEach(([key, value]) => {
      if (value) {
        if (key === 'status') {
          where.status = value;
        } else if (key === 'verification_officer_id') {
          where.verification_officer_id = parseInt(value);
        }
      }
    });

    const verifications = await prisma.verification.findMany({
      where,
      skip,
      take,
      orderBy: { [sortBy]: sortDir },
      include: {
        order: true,
        verification_officer: {
          select: { full_name: true, username: true }
        },
        purchaser: true,
        grantors: true,
      },
    });

    const total = await prisma.verification.count({ where });

    return res.status(200).json({
      success: true,
      data: {
        verifications,
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
    console.error(error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' },
    });
  }
};

const getMyAssignedOrdersCursorPaginated = (targetStatus) => async (req, res) => {
  const officerId = req.user.id;

  const {
    lastId = 0,
    limit = 10,
    search = '',
  } = req.query;

  const take = Number(limit);
  const cursorId = Number(lastId);

  try {
    const baseWhere = {
      assigned_to_user_id: officerId,
      status: targetStatus,
    };

    if (search.trim()) {
      baseWhere.OR = [
        { customer_name: { contains: search } },
        { whatsapp_number: { contains: search } },
        { order_ref: { contains: search } },
        { token_number: { contains: search } },
        { product_name: { contains: search } },
        { city: { contains: search } },
        { area: { contains: search } },
      ];
    }

    const totalCount = await prisma.order.count({
      where: baseWhere,
    });

    const where = { ...baseWhere };
    if (cursorId > 0) {
      where.id = { gt: cursorId };
    }

    const orders = await prisma.order.findMany({
      where,
      take,
      orderBy: { id: 'asc' },
      include: {
        created_by: { select: { username: true, full_name: true } },
        assigned_to: { select: { username: true, full_name: true } },
        verification: {
          select: {
            id: true,
            status: true,
            start_time: true,
            end_time: true,
          }
        },
      },
    });

    let nextLastId = null;
    if (orders.length > 0) {
      nextLastId = orders[orders.length - 1].id;
    }

    const hasMore = orders.length === take;

    return res.status(200).json({
      success: true,
      data: {
        orders,
        pagination: {
          nextLastId,
          hasMore,
          limit: take,
          count: orders.length,
          totalCount,
        },
        currentStatus: targetStatus,
      },
    });
  } catch (error) {
    console.error(`Error fetching ${targetStatus} orders:`, error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' },
    });
  }
};

const getMyCustomersWithOrdersAndLedger = async (req, res) => {
  try {
    const orders = await prisma.order.findMany({
      where: {
        is_delivered: true,
      },
      include: {
        verification: {
          include: {
            purchaser: true,
            documents: {
              where: { document_type: 'photo', person_type: 'purchaser' },
              orderBy: { uploaded_at: 'desc' },
              take: 1,
            },
          },
        },
        delivery: {
          include: {
            installment_ledger: true,
          },
        },
        installment_ledger: true,
        cash_in_hand: {
          orderBy: { created_at: 'desc' },
          take: 1,
        },
      },
      orderBy: [{ customer_name: 'asc' }, { created_at: 'desc' }],
    });

    if (orders.length === 0) {
      return res.status(200).json({
        success: true,
        data: { totalCustomers: 0, totalOrders: 0, customers: [] },
      });
    }

    // ── Pre-fetch Inventory details based on IMEI ──────────────────
    const allImeis = orders
      .map(o => o.cash_in_hand?.[0]?.imei_serial || o.delivery?.product_imei || o.imei_serial)
      .filter(Boolean);

    const inventories = await prisma.outletInventory.findMany({
      where: { imei_serial: { in: allImeis } },
      select: { imei_serial: true, product_name: true, color_variant: true }
    });

    const inventoryMap = new Map();
    for (const inv of inventories) {
      if (inv.imei_serial) {
        inventoryMap.set(inv.imei_serial, inv);
      }
    }

    const customerMap = new Map();

    for (const order of orders) {
      const key = `order-${order.id}`;

      const purchaser = order.verification?.purchaser || null;
      const cashInHand = order.cash_in_hand?.[0] || null;
      const delivery = order.delivery;
      const installmentLedgerModel = delivery?.installment_ledger || null;
      const profilePhoto = order.verification?.documents?.[0]?.file_url || null;

      // ── Customer details: purchaser se, fallback Order ────────
      const customerName = purchaser?.name || order.customer_name;
      const fatherHusbandName = purchaser?.father_husband_name || null;
      const cnicNumber = purchaser?.cnic_number || null;
      const presentAddress = purchaser?.present_address || order.address || null;
      const permanentAddress = purchaser?.permanent_address || null;
      const telephoneNumber = purchaser?.telephone_number || order.whatsapp_number;
      const nearestLocation = purchaser?.nearest_location || null;
      const isBlacklisted = purchaser?.is_blacklisted || false;

      if (!customerMap.has(key)) {
        customerMap.set(key, {
          customer: {
            name: customerName,
            father_husband_name: fatherHusbandName,
            cnic_number: cnicNumber,
            whatsapp_number: order.whatsapp_number,
            telephone_number: telephoneNumber,
            present_address: presentAddress,
            permanent_address: permanentAddress,
            nearest_location: nearestLocation,
            city: order.city,
            area: order.area,
            profile_photo: profilePhoto,
            is_blacklisted: isBlacklisted,
          },
          orders: [],
          ledgerSummary: {
            totalOrders: 0,
            totalAdvanceReceived: 0,
            totalPaid: 0,
            totalRemaining: 0,
          },
        });
      }

      const group = customerMap.get(key);

      // ── Delivery date ──────────────────────────────────────────
      const deliveryDate = delivery?.end_time || order.updated_at;

      // ── Product info: Fetch from Inventory via IMEI first ───────────────────────────
      const imeiSerial = cashInHand?.imei_serial || delivery?.product_imei || order.imei_serial || null;
      const invInfo = imeiSerial ? inventoryMap.get(imeiSerial) : null;

      const productName = invInfo?.product_name || cashInHand?.product_name || order.product_name;
      const colorVariant = invInfo?.color_variant || cashInHand?.color_variant || null;

      // ── Use normalizeLedger for consistent financial calculations ──
      const ledgerModel = order.installment_ledger || order.delivery?.installment_ledger;
      const normalized = getNormalizedLedger(ledgerModel?.ledger_rows);
      const { advance_payment: advancePayment, installment_ledger: installmentLedger, summary } = normalized;

      const advAmountVal = advancePayment.amount || 0;
      const hasPaidAdvance = advancePayment.paid;
      const grandTotalPaid = summary.grandTotalPaid;
      const grandTotalRemaining = summary.grandTotalRemaining;
      const grandTotalDue = summary.grandTotalDue;

      let selectedPlan = order.delivery?.selected_plan || null;
      if (typeof selectedPlan === 'string') {
        try { selectedPlan = JSON.parse(selectedPlan); } catch { selectedPlan = null; }
      }

      // Use actual row amounts (not plan formula) for accurate totals
      const monthlyAmount = installmentLedger[0]?.dueAmount
        || Number(selectedPlan?.monthly_amount || selectedPlan?.monthlyAmount || 0);
      const totalMonths = installmentLedger.length
        || Number(selectedPlan?.months || selectedPlan?.totalMonths || 0);

      group.orders.push({
        order_id: order.id,
        order_ref: order.order_ref,
        token_number: order.token_number,
        status: order.status,
        is_delivered: true,
        delivery_date: deliveryDate ? deliveryDate : null,
        created_at: order.created_at,
        verification_status: order.verification?.status || null,

        product_details: {
          product_name: productName,
          imei_serial: imeiSerial,
          color_variant: colorVariant,
        },

        plan: {
          selected_plan: selectedPlan,
          advance_amount: advAmountVal,       // CashInHand.amount
          monthly_amount: monthlyAmount,       // selectedPlan.monthlyAmount (camelCase fixed)
          months: totalMonths,         // selectedPlan.months
          total_plan_value: grandTotalDue,       // advance + (monthly * months)
        },

        ledger: {
          advance_payment: advancePayment,
          installment_ledger: installmentLedger,
          ledger_token: ledgerModel?.short_id || null,
          summary: {
            ...summary,
            total_remaining: summary.totalInstallmentRemaining,
            total_paid: summary.totalInstallmentPaid,
            total_due: summary.totalInstallmentDue
          },
        },
      });

      // ── Customer ledger summary update ─────────────────────────
      group.ledgerSummary.totalOrders += 1;
      group.ledgerSummary.totalAdvanceReceived += advAmountVal;
      group.ledgerSummary.totalPaid += grandTotalPaid;
      group.ledgerSummary.totalRemaining += grandTotalRemaining;
    }

    const customers = Array.from(customerMap.values()).sort((a, b) =>
      a.customer.name.localeCompare(b.customer.name)
    );

    return res.status(200).json({
      success: true,
      data: {
        totalCustomers: customers.length,
        totalOrders: orders.length,
        customers,
      },
    });
  } catch (error) {
    console.error('Error in getMyCustomersWithOrdersAndLedger:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' },
    });
  }
};

// Helper function to record edit history
const recordEditHistory = async (
  verification_id,
  entity_type,
  entity_id,
  field_name,
  old_value,
  new_value,
  edited_by_id,
  edited_by_name
) => {
  try {
    // Don't record if values are the same
    if (old_value === new_value) return null;

    const history = await prisma.verificationEditHistory.create({
      data: {
        verification_id: parseInt(verification_id),
        entity_type,
        entity_id: parseInt(entity_id),
        field_name,
        old_value: old_value ? String(old_value) : null,
        new_value: new_value ? String(new_value) : null,
        edited_by_id: parseInt(edited_by_id),
        edited_by_name,
        edited_at: now()
      }
    });

    return history;
  } catch (error) {
    console.error('Error recording edit history:', error);
    return null;
  }
};

// Update Purchaser Field (New API for single field update)
const updatePurchaserField = async (req, res) => {
  const { verification_id } = req.params;
  const { field_name, new_value } = req.body;

  try {
    const verification = await prisma.verification.findUnique({
      where: { id: parseInt(verification_id) },
      include: { purchaser: true }
    });

    if (!verification) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Verification not found' }
      });
    }

    if (!verification.purchaser) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Purchaser record not found' }
      });
    }

    // Get old value
    const old_value = verification.purchaser[field_name];

    // Update the field
    const updatedPurchaser = await prisma.purchaserVerification.update({
      where: { id: verification.purchaser.id },
      data: { [field_name]: new_value }
    });

    // Record edit history
    await recordEditHistory(
      verification_id,
      'purchaser',
      verification.purchaser.id,
      field_name,
      old_value,
      new_value,
      req.user.id,
      req.user.full_name
    );

    // Get updated verification with history
    const updatedVerification = await prisma.verification.findUnique({
      where: { id: parseInt(verification_id) },
      include: {
        purchaser: true,
        grantors: true,
        edit_history: {
          where: { entity_type: 'purchaser', entity_id: verification.purchaser.id },
          orderBy: { edited_at: 'desc' }
        }
      }
    });

    return res.status(200).json({
      success: true,
      message: 'Purchaser field updated successfully',
      data: {
        purchaser: updatedPurchaser,
        edit_history: updatedVerification.edit_history
      }
    });

  } catch (error) {
    console.error('Update purchaser field error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

// Update Grantor Field (New API for single field update)
const updateGrantorField = async (req, res) => {
  const { verification_id, grantor_id } = req.params;
  const { field_name, new_value } = req.body;

  try {
    const verification = await prisma.verification.findUnique({
      where: { id: parseInt(verification_id) }
    });

    if (!verification) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Verification not found' }
      });
    }

    const grantor = await prisma.grantorVerification.findFirst({
      where: {
        id: parseInt(grantor_id),
        verification_id: parseInt(verification_id)
      }
    });

    if (!grantor) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Grantor not found' }
      });
    }

    // Get old value
    const old_value = grantor[field_name];

    // Update the field
    const updatedGrantor = await prisma.grantorVerification.update({
      where: { id: grantor.id },
      data: { [field_name]: new_value }
    });

    // Record edit history
    await recordEditHistory(
      verification_id,
      'grantor',
      grantor.id,
      field_name,
      old_value,
      new_value,
      req.user.id,
      req.user.full_name
    );

    // Get updated verification with history
    const updatedVerification = await prisma.verification.findUnique({
      where: { id: parseInt(verification_id) },
      include: {
        grantors: true,
        edit_history: {
          where: { entity_type: 'grantor', entity_id: grantor.id },
          orderBy: { edited_at: 'desc' }
        }
      }
    });

    return res.status(200).json({
      success: true,
      message: 'Grantor field updated successfully',
      data: {
        grantor: updatedGrantor,
        edit_history: updatedVerification.edit_history
      }
    });

  } catch (error) {
    console.error('Update grantor field error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

// Get Edit History for an entity
const getEditHistory = async (req, res) => {
  const { verification_id, entity_type, entity_id } = req.params;

  try {
    const history = await prisma.verificationEditHistory.findMany({
      where: {
        verification_id: parseInt(verification_id),
        entity_type,
        entity_id: parseInt(entity_id)
      },
      orderBy: { edited_at: 'desc' },
      include: {
        edited_by: {
          select: { full_name: true, username: true }
        }
      }
    });

    return res.status(200).json({
      success: true,
      data: { history }
    });

  } catch (error) {
    console.error('Get edit history error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

const sendToVOForLocation = async (req, res) => {
  const { verification_id } = req.params;
  const { officer_id } = req.body;

  try {
    const verification = await prisma.verification.findUnique({
      where: { id: parseInt(verification_id) },
      include: { order: true }
    });

    if (!verification) {
      return res.status(404).json({ success: false, message: 'Verification not found' });
    }

    await prisma.verification.update({
      where: { id: verification.id },
      data: {
        verification_officer_id: parseInt(officer_id),
        status: 'location_capture_pending',
        updated_at: now()   // ✅ explicit
      }
    });

    // Notify Verification Officer
    const officer = await prisma.user.findUnique({ where: { id: parseInt(officer_id) } });
    const io = req.app ? req.app.get('io') : null;
    if (officer) {
      await sendOrderAssignmentNotification(verification.order, officer, 'verification_location', io);
    }

    return res.status(200).json({
      success: true,
      message: 'Sent to Verification Officer for location capture'
    });
  } catch (error) {
    console.error('sendToVOForLocation error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const sendToDOForLocation = async (req, res) => {
  const { verification_id } = req.params;
  const { officer_id } = req.body;

  try {
    const verification = await prisma.verification.findUnique({
      where: { id: parseInt(verification_id) },
      include: { order: true }
    });

    if (!verification) {
      return res.status(404).json({ success: false, message: 'Verification not found' });
    }

    // Normal delivery assignment but we know it needs location
    await prisma.verification.update({
      where: { id: verification.id },
      data: {
        verification_officer_id: parseInt(officer_id),
        status: 'location_capture_pending',
        updated_at: now()   // ✅ explicit
      }
    });

    // Notify Delivery Officer
    const officer = await prisma.user.findUnique({ where: { id: parseInt(officer_id) } });
    const io = req.app ? req.app.get('io') : null;
    if (officer) {
      await sendOrderAssignmentNotification(verification.order, officer, 'delivery_location', io);
    }

    return res.status(200).json({
      success: true,
      message: 'Sent to Delivery Officer for delivery and location capture'
    });
  } catch (error) {
    console.error('sendToDOForLocation error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const updateLocationVerified = async (req, res) => {
  const { verification_id } = req.params;
  const {
    location_type,
    latitude,
    longitude,
    address,
    label,
    person_type,
    person_id
  } = req.body;

  try {
    const verification = await prisma.verification.findUnique({
      where: { id: parseInt(verification_id) }
    });

    if (!verification) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Verification not found' }
      });
    }

    // Create location first
    const location = await prisma.verificationLocation.create({
      data: {
        verification_id: parseInt(verification_id),
        location_type,
        latitude: latitude ? parseFloat(latitude) : null,
        longitude: longitude ? parseFloat(longitude) : null,
        address,
        label,
        person_type,
        person_id: person_id ? parseInt(person_id) : null,
        created_at: now()
      }
    });

    // Get uploaded photos (up to 5)
    const photos = req.files || [];

    // Save photos to separate table
    const photoPromises = photos.map(file =>
      prisma.verificationLocationPhoto.create({
        data: {
          verification_location_id: location.id,
          file_url: file.url,
          uploaded_at: now()
        }
      })
    );

    const savedPhotos = await Promise.all(photoPromises);

    // Update verification flags
    await prisma.verification.update({
      where: { id: parseInt(verification_id) },
      data: {
        home_location_verified: true,
        home_location_required: false,
        status: 'location_captured',
        updated_at: now()   // ✅ explicit
      }
    });

    // Get location with photos
    const locationWithPhotos = await prisma.verificationLocation.findUnique({
      where: { id: location.id },
      include: {
        photos: true
      }
    });

    return res.status(200).json({
      success: true,
      message: 'Location verified successfully',
      data: { location: locationWithPhotos }
    });
  } catch (error) {
    console.error('updateLocationVerified error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

const getDeliveredProductDetails = async (req, res) => {
  const { order_id } = req.params;

  try {
    // Fetch order with delivery and cash_in_hand data
    const order = await prisma.order.findUnique({
      where: { id: parseInt(order_id) },
      include: {
        delivery: {
          include: {
            installment_ledger: true,
            uploads: true
          }
        },
        installment_ledger: true,
        cash_in_hand: {
          orderBy: { created_at: 'desc' },
          take: 1
        }
      }
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Order not found' }
      });
    }

    // Check if order is delivered
    if (!order.is_delivered && order.status !== 'delivered') {
      return res.status(400).json({
        success: false,
        error: { code: 400, message: 'Order is not delivered yet' }
      });
    }

    // Get IMEI from delivery or cash_in_hand
    const imeiSerial = order.cash_in_hand?.[0]?.imei_serial ||
      order.delivery?.product_imei ||
      order.imei_serial;

    let inventoryDetails = null;

    // Fetch inventory details if IMEI exists
    if (imeiSerial) {
      const inventory = await prisma.outletInventory.findFirst({
        where: { imei_serial: imeiSerial }
      });

      if (inventory) {
        inventoryDetails = {
          product_name: inventory.product_name,
          category: inventory.category,
          color_variant: inventory.color_variant,
          imei_serial: inventory.imei_serial,
          purchase_price: inventory.purchase_price,
          installment_price: inventory.installment_price,
          status: inventory.status
        };
      }
    }

    // Extract delivery details
    let deliveryDetails = null;
    if (order.delivery) {
      // Fetch delivery agent details
      let deliveryAgentName = null;
      if (order.delivery.delivery_agent_id) {
        const deliveryAgent = await prisma.user.findUnique({
          where: { id: order.delivery.delivery_agent_id },
          select: { full_name: true, username: true }
        });
        if (deliveryAgent) {
          deliveryAgentName = `${deliveryAgent.full_name} (${deliveryAgent.username})`;
        }
      }

      deliveryDetails = {
        id: order.delivery.id,
        status: order.delivery.status,
        start_time: order.delivery.start_time,
        end_time: order.delivery.end_time,
        feedback: order.delivery.feedback,
        verified: order.delivery.verified,
        product_imei: order.delivery.product_imei,
        selected_plan: order.delivery.selected_plan,
        self_pickup: order.delivery.self_pickup,
        delivery_agent_id: order.delivery.delivery_agent_id,
        delivery_agent_name: deliveryAgentName, // Add agent name here
        uploads: order.delivery.uploads
      };
    }

    // Extract advance payment details and installment ledger details
    let advancePayment = null;
    let installmentDetails = null;
    const ledger = order.installment_ledger || order.delivery?.installment_ledger;

    if (ledger?.ledger_rows) {
      const normalized = getNormalizedLedger(ledger.ledger_rows);

      // Derive advance payment from ledger
      if (normalized.advance_payment) {
        advancePayment = {
          amount: normalized.advance_payment.amount,
          paid_amount: normalized.advance_payment.paid ? normalized.advance_payment.amount : 0,
          status: normalized.advance_payment.status,
          paid_at: normalized.advance_payment.paidAt,
          payment_method: normalized.advance_payment.paymentMethod,
          label: normalized.advance_payment.label || 'Advance Payment'
        };
      }

      installmentDetails = {
        token: ledger.short_id || ledger.token,
        advance_payment: normalized.advance_payment,
        installments: normalized.installment_ledger.map((row) => ({
          month: row.monthNumber,
          label: row.label,
          due_date: row.dueDate,
          due_amount: row.dueAmount,
          paid_amount: row.paidAmount,
          remaining_amount: row.remainingAmount,
          status: row.status,
          paid_at: row.paidAt,
          payment_method: row.paymentMethod,
          arrears: row.arrears
        })),
        summary: {
          total_installments: normalized.summary.totalInstallments || normalized.installment_ledger.length,
          paid_installments: normalized.summary.paidInstallments,
          pending_installments: normalized.summary.pendingInstallments,
          total_due_amount: normalized.summary.totalInstallmentDue,
          total_paid_amount: normalized.summary.totalInstallmentPaid,
          total_remaining_amount: normalized.summary.totalInstallmentRemaining
        }
      };
    }

    // Compile delivered product details
    const deliveredProductDetails = {
      order_info: {
        id: order.id,
        order_ref: order.order_ref,
        token_number: order.token_number,
        customer_name: order.customer_name,
        whatsapp_number: order.whatsapp_number,
        is_delivered: order.is_delivered,
        status: order.status,
        delivered_at: order.updated_at
      },
      product_details: inventoryDetails || {
        product_name: order.product_name,
        imei_serial: imeiSerial,
        total_amount: order.total_amount,
        advance_amount: order.advance_amount,
        monthly_amount: order.monthly_amount,
        months: order.months
      },
      delivery_details: deliveryDetails,
      payment_details: {
        advance_payment: advancePayment,
        installment_plan: installmentDetails
      }
    };

    return res.status(200).json({
      success: true,
      data: deliveredProductDetails
    });
  } catch (error) {
    console.error('Get delivered product details error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

// Get all delivered products for an outlet or officer
const getDeliveredProductsList = async (req, res) => {
  const { page = 1, limit = 10, search = '', outlet_id } = req.query;

  const skip = (Number(page) - 1) * Number(limit);
  const take = Number(limit);

  try {
    const where = {
      is_delivered: true
    };

    // Filter by outlet if provided
    if (outlet_id) {
      where.outlet_id = parseInt(outlet_id);
    }

    // Search by customer name, order_ref, or product name
    if (search.trim()) {
      where.OR = [
        { customer_name: { contains: search } },
        { order_ref: { contains: search } },
        { token_number: { contains: search } },
        { product_name: { contains: search } }
      ];
    }

    const orders = await prisma.order.findMany({
      where,
      skip,
      take,
      orderBy: { updated_at: 'asc' },
      include: {
        delivery: {
          include: {
            installment_ledger: true
          }
        },
        cash_in_hand: {
          orderBy: { created_at: 'desc' },
          take: 1
        },
        outlet: {
          select: { id: true, name: true, code: true }
        }
      }
    });

    // Enrich each order with inventory details
    const enrichedOrders = await Promise.all(orders.map(async (order) => {
      const imeiSerial = order.cash_in_hand?.[0]?.imei_serial ||
        order.delivery?.product_imei ||
        order.imei_serial;

      let inventoryDetails = null;
      if (imeiSerial) {
        const inventory = await prisma.outletInventory.findFirst({
          where: { imei_serial: imeiSerial }
        });
        if (inventory) {
          inventoryDetails = {
            product_name: inventory.product_name,
            category: inventory.category,
            color_variant: inventory.color_variant,
            imei_serial: inventory.imei_serial
          };
        }
      }

      return {
        ...order,
        inventory_details: inventoryDetails
      };
    }));

    const total = await prisma.order.count({ where });

    return res.status(200).json({
      success: true,
      data: {
        orders: enrichedOrders,
        pagination: {
          page: Number(page),
          limit: take,
          total,
          totalPages: Math.ceil(total / take),
          hasNext: skip + take < total,
          hasPrev: Number(page) > 1
        }
      }
    });
  } catch (error) {
    console.error('Get delivered products list error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

// Update Verification Media (Single document/photo update)
const updateVerificationMedia = async (req, res) => {
  const { verification_id } = req.params;
  const { document_type, person_type, person_id, label, document_id } = req.body;

  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded' });
  }

  try {
    const verification = await prisma.verification.findUnique({
      where: { id: parseInt(verification_id) },
      include: { purchaser: true, grantors: true }
    });

    if (!verification) {
      return res.status(404).json({ success: false, error: 'Verification not found' });
    }

    let old_value = null;
    let entity_id = null;

    // 1. Identify Entity
    if (person_type === 'purchaser') {
      if (!verification.purchaser) {
        return res.status(404).json({ success: false, error: 'Purchaser record not found' });
      }
      entity_id = verification.purchaser.id;
    } else if (person_type.startsWith('grantor')) {
      const grantorId = person_id ? parseInt(person_id) : null;
      const grantor = verification.grantors.find(g =>
        (grantorId && g.id === grantorId) ||
        (!grantorId && person_type === `grantor${g.grantor_number}`)
      );

      if (!grantor) {
        return res.status(404).json({ success: false, error: 'Grantor record not found' });
      }
      entity_id = grantor.id;
    }

    // 2. Identify old value and update/create document
    let document;
    if (document_id) {
      const existingDoc = await prisma.verificationDocument.findUnique({
        where: { id: parseInt(document_id) }
      });
      if (existingDoc) {
        old_value = existingDoc.file_url;
        document = await prisma.verificationDocument.update({
          where: { id: existingDoc.id },
          data: {
            file_url: req.file.url,
            uploaded_at: now()
          }
        });
      }
    } else {
      document = await prisma.verificationDocument.create({
        data: {
          verification_id: parseInt(verification_id),
          document_type,
          person_type,
          person_id: entity_id,
          file_url: req.file.url,
          label: label || `${document_type}`,
          uploaded_at: now()
        }
      });
    }

    // 3. Update the primary URL in Purchaser/Grantor table (syncing)
    let primaryField = document_type;
    const suffixTypes = ['cnic_front', 'cnic_back', 'utility_bill', 'service_card', 'signature', 'office_card'];
    if (suffixTypes.includes(document_type)) {
      primaryField = `${document_type}_url`;
    }

    try {
      if (person_type === 'purchaser') {
        await prisma.purchaserVerification.update({
          where: { id: entity_id },
          data: { [primaryField]: req.file.url }
        });
      } else if (entity_id) {
        await prisma.grantorVerification.update({
          where: { id: entity_id },
          data: { [primaryField]: req.file.url }
        });
      }
    } catch (updateError) {
      console.warn(`Optional primary field update failed for ${primaryField}:`, updateError.message);
    }

    // 4. Record Edit History
    await recordEditHistory(
      parseInt(verification_id),
      person_type,
      entity_id,
      document_type,
      old_value,
      req.file.url,
      req.user.id,
      req.user.full_name
    );

    return res.status(200).json({
      success: true,
      message: 'Media updated and replaced successfully',
      data: { document }
    });
  } catch (error) {
    console.error('Update verification media error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

// Replace a verification location photo (Super Admin only)
const replaceLocationPhoto = async (req, res) => {
  const { photo_id } = req.params;

  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded' });
  }

  try {
    const existing = await prisma.verificationLocationPhoto.findUnique({
      where: { id: parseInt(photo_id) }
    });

    if (!existing) {
      return res.status(404).json({ success: false, error: 'Photo not found' });
    }

    const updated = await prisma.verificationLocationPhoto.update({
      where: { id: parseInt(photo_id) },
      data: {
        file_url: req.file.url,
        uploaded_at: now()
      },
      include: {
        verification_location: {
          include: {
            verification: true
          }
        }
      }
    });

    // Log to edit history
    await prisma.verificationEditHistory.create({
      data: {
        verification_id: updated.verification_location.verification_id,
        entity_type: 'location_photo',
        entity_id: updated.id,
        field_name: 'file_url',
        old_value: existing.file_url,
        new_value: updated.file_url,
        edited_by_id: req.user.id,
        edited_by_name: req.user.full_name,
        edited_at: now()
      }
    });

    return res.status(200).json({
      success: true,
      message: 'Location photo replaced successfully',
      data: { photo: updated }
    });
  } catch (error) {
    console.error('Replace location photo error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

const getVerificationDashboardStats = async (req, res) => {
  try {
    const { filter = 'today', startDate, endDate } = req.query;
    const userId = req.user?.id;

    // Fetch officer info from DB (for bike_km_range, working_hours)
    const officerInfo = await prisma.user.findUnique({
      where: { id: userId },
      select: { bike_km_range: true, working_hours_start: true, working_hours_end: true }
    });

    // Trigger async ranking update
    updateVerificationRanking(userId, 'today').catch(err => console.error('Auto-ranking update error:', err));
    updateVerificationRanking(userId, 'month').catch(err => console.error('Auto-ranking update error:', err));

    const nowDt = new Date();
    let start, end;

    if (filter === 'today') {
      start = new Date(nowDt); start.setHours(0, 0, 0, 0);
      end = new Date(nowDt); end.setHours(23, 59, 59, 999);
    } else if (filter === 'month') {
      start = new Date(nowDt.getFullYear(), nowDt.getMonth(), 1, 0, 0, 0, 0);
      end = new Date(nowDt.getFullYear(), nowDt.getMonth() + 1, 0, 23, 59, 59, 999);
    } else if (filter === 'custom' && startDate && endDate) {
      start = new Date(startDate); start.setHours(0, 0, 0, 0);
      end = new Date(endDate); end.setHours(23, 59, 59, 999);
    } else {
      start = new Date(nowDt); start.setHours(0, 0, 0, 0);
      end = new Date(nowDt); end.setHours(23, 59, 59, 999);
    }

    const dateFilter = { gte: start, lte: end };

    const baseWhere = {
      updated_at: dateFilter,
      assigned_to_user_id: userId
    };

    // Status counts
    const statusGroups = await prisma.order.groupBy({
      by: ['status'],
      where: baseWhere,
      _count: { id: true },
    });

    const statusCounts = statusGroups.reduce((acc, item) => {
      acc[item.status] = item._count.id;
      return acc;
    }, {});

    const totalOrders = Object.values(statusCounts).reduce((a, b) => a + b, 0);
    const newCount = statusCounts['new'] || 0;
    const pendingCount = statusCounts['pending'] || 0;
    const inProgressCount = statusCounts['in_progress'] || 0;
    const cancelledCount = statusCounts['cancelled'] || 0;
    const completedCount = statusCounts['completed'] || 0;
    const deliveredCount = statusCounts['delivered'] || 0;
    const expiredCount = statusCounts['expired'] || 0;
    const approvedCount = statusCounts['approved'] || 0;
    const rejectedCount = statusCounts['rejected'] || 0;

    // specific metrics
    const homeLocationRequiredCount = await prisma.verification.count({
        where: {
            verification_officer_id: userId,
            home_location_required: true,
            home_location_verified: false,
            updated_at: dateFilter
        }
    });

    const topVisitDeadlineOrders = await prisma.order.findMany({
        where: {
            assigned_to_user_id: userId,
            status: { in: ['pending', 'in_progress', 'new'] }
        },
        orderBy: { updated_at: 'asc' },
        take: 5
    });

    // Yesterday for increment
    const yesterdayStart = new Date(start); yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    const yesterdayEnd = new Date(end); yesterdayEnd.setDate(yesterdayEnd.getDate() - 1);

    const yesterdayStatusGroups = await prisma.order.groupBy({
      by: ['status'],
      where: { ...baseWhere, updated_at: { gte: yesterdayStart, lte: yesterdayEnd } },
      _count: { id: true },
    });

    const yesterdayCounts = yesterdayStatusGroups.reduce((acc, item) => {
      acc[item.status] = item._count.id;
      return acc;
    }, {});

    const calcIncrement = (curr, prev) => {
      if (!prev || prev === 0) return curr > 0 ? 100 : 0;
      return Math.round(((curr - prev) / prev) * 100);
    };

    const todayIncrement = {
      total: calcIncrement(totalOrders, Object.values(yesterdayCounts).reduce((a, b) => a + b, 0)),
      new: calcIncrement(newCount, yesterdayCounts['new']),
      pending: calcIncrement(pendingCount, yesterdayCounts['pending']),
      delivered: calcIncrement(deliveredCount, yesterdayCounts['delivered']),
      approved: calcIncrement(approvedCount, yesterdayCounts['approved']),
      cancelled: calcIncrement(cancelledCount, yesterdayCounts['cancelled']),
      expired: calcIncrement(expiredCount, yesterdayCounts['expired']),
      in_progress: calcIncrement(inProgressCount, yesterdayCounts['in_progress']),
      completed: calcIncrement(completedCount, yesterdayCounts['completed']),
      rejected: calcIncrement(rejectedCount, yesterdayCounts['rejected']),
    };

    // Rankings
    const rankingPeriod = filter === 'custom' ? 'month' : filter;
    
    // Fetch all Verification Officers
    const verificationOfficers = await prisma.user.findMany({
      where: {
        role: {
          name: { contains: 'Verification' }
        }
      },
      select: { id: true, full_name: true, username: true, image: true, outlet: { select: { name: true } } }
    });

    const rankings = await prisma.verificationRanking.findMany({
      where: {
        period: rankingPeriod,
        month: rankingPeriod === 'month' ? nowDt.getMonth() + 1 : 0,
        year: rankingPeriod === 'month' ? nowDt.getFullYear() : 0,
      }
    });

    const rankingMap = rankings.reduce((acc, r) => { acc[r.officer_id] = r; return acc; }, {});

    let officerRanking = verificationOfficers.map(officer => {
      const rankRecord = rankingMap[officer.id];
      const score = rankRecord ? rankRecord.score : 0;
      let league = 'Bronze';
      if (score >= 1500) league = 'Gold';
      else if (score >= 1000) league = 'Silver';

      return {
        userId: officer.id,
        name: officer.full_name,
        username: officer.username,
        image: officer.image,
        outletName: officer.outlet?.name || 'Main Outlet',
        uniqueCustomers: rankRecord ? rankRecord.unique_customers : 0,
        delivered: rankRecord ? rankRecord.delivered_customers : 0,
        completed: rankRecord ? rankRecord.completed_customers : 0,
        cancelled: rankRecord ? rankRecord.cancelled_customers : 0,
        expired: rankRecord ? rankRecord.expired_customers : 0,
        totalSales: rankRecord ? rankRecord.total_sales : 0,
        score: score,
        trend: rankRecord ? rankRecord.trend : 0,
        league: league
      };
    });

    officerRanking.sort((a, b) => b.score - a.score);
    officerRanking = officerRanking.map((r, index) => ({ ...r, rank: index + 1 }));

    // Channel stats
    const channelGroups = await prisma.order.groupBy({
      by: ['channel', 'status'],
      where: baseWhere,
      _count: { id: true },
    });

    const channelMap = {};
    channelGroups.forEach(item => {
      const ch = (item.channel || 'unknown').toLowerCase();
      if (!channelMap[ch]) channelMap[ch] = { total: 0, completed: 0, cancelled: 0 };
      channelMap[ch].total += item._count.id;
      if (item.status === 'completed' || item.status === 'approved') channelMap[ch].completed += item._count.id;
      if (item.status === 'cancelled') channelMap[ch].cancelled += item._count.id;
    });

    const buildChannelStats = (names) => {
      const combined = { total: 0, completed: 0, cancelled: 0 };
      names.forEach(n => {
        const data = channelMap[n.toLowerCase()];
        if (data) {
          combined.total += data.total;
          combined.completed += data.completed;
          combined.cancelled += data.cancelled;
        }
      });
      combined.successRate = combined.total > 0 ? Math.round((combined.completed / combined.total) * 100) : 0;
      combined.cancelRate = combined.total > 0 ? Math.round((combined.cancelled / combined.total) * 100) : 0;
      return combined;
    };

    const channelStats = {
      referral: buildChannelStats(['referral']),
      call: buildChannelStats(['call']),
      whatsapp: buildChannelStats(['whatsapp', 'whats_app', 'whats app']),
      website: buildChannelStats(['website']),
    };

    return res.status(200).json({
      success: true,
      data: {
        filter,
        dateRange: { start, end },
        totalOrders,
        statusCounts: {
          new: newCount,
          pending: pendingCount,
          in_progress: inProgressCount,
          cancelled: cancelledCount,
          completed: completedCount,
          delivered: deliveredCount,
          expired: expiredCount,
          approved: approvedCount,
          rejected: rejectedCount,
        },
        bikeRange: officerInfo?.bike_km_range || 0,
        workingHours: `${officerInfo?.working_hours_start || '09:00'} - ${officerInfo?.working_hours_end || '18:00'}`,
        homeLocationRequiredCount,
        topVisitDeadlineOrders,
        todayIncrement,
        channelStats,
        officerRanking
      },
    });
  } catch (error) {
    console.error('getDashboardStats error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

module.exports = {
  getVerificationDashboardStats,
  getVerifications,
  startVerification,
  savePurchaserVerification,
  saveGrantorVerification,
  saveNextOfKin,
  saveLocation,
  saveVerificationLocation,
  getVerificationLocations,
  deleteVerificationLocation,
  uploadPurchaserDocument,
  uploadGrantorDocument,
  uploadPhoto,
  uploadSignature,
  deleteDocument,
  completeVerification,
  getVerificationByOrderId,
  submitVerificationReview,
  updateGrantorField,
  getEditHistory,
  updatePurchaserField,
  getMyPendingOrders: getMyAssignedOrdersCursorPaginated('pending'),
  getMyConfirmedOrders: getMyAssignedOrdersCursorPaginated('confirmed'),
  getMyCancelledOrders: getMyAssignedOrdersCursorPaginated('cancelled'),
  getMyCustomersWithOrdersAndLedger,
  sendToVOForLocation,
  sendToDOForLocation,
  updateLocationVerified,
  getDeliveredProductDetails,
  getDeliveredProductsList,
  updateVerificationMedia,
  replaceLocationPhoto
};