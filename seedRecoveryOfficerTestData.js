const prisma = require('./lib/prisma');
const bcrypt = require('bcryptjs');

async function seed() {
    console.log('Starting seed script for dummy Recovery Officer test data...');

    try {
        const passwordHash = await bcrypt.hash('password123', 10);
        const futureDate = new Date();
        futureDate.setFullYear(futureDate.getFullYear() + 5);

        // 1. Ensure Roles Exist
        const recRoleObj = await prisma.role.findFirst({ where: { name: 'Recovery Officer' } });
        const recRoleId = recRoleObj ? recRoleObj.id : 3;

        const voRoleObj = await prisma.role.findFirst({ where: { name: 'Verification Officer' } });
        const voRoleId = voRoleObj ? voRoleObj.id : 1;

        const daRoleObj = await prisma.role.findFirst({ where: { name: 'Delivery Agent' } });
        const daRoleId = daRoleObj ? daRoleObj.id : 2;

        console.log(`Roles: Recovery Officer (${recRoleId}), Verification Officer (${voRoleId}), Delivery Agent (${daRoleId})`);

        // 2. Ensure system users exist
        let voOfficer = await prisma.user.findFirst({ where: { role_id: voRoleId } });
        if (!voOfficer) {
            console.log('Creating dummy Verification Officer...');
            voOfficer = await prisma.user.create({
                data: {
                    full_name: 'System Verification Officer',
                    username: 'sysverif',
                    password_hash: passwordHash,
                    phone: '03009999999',
                    email: 'sysverif@test.com',
                    role_id: voRoleId,
                    status: 'active',
                    created_at: new Date(),
                    updated_at: new Date()
                }
            });
        }

        let delAgent = await prisma.user.findFirst({ where: { role_id: daRoleId } });
        if (!delAgent) {
            console.log('Creating dummy Delivery Agent...');
            delAgent = await prisma.user.create({
                data: {
                    full_name: 'System Delivery Agent',
                    username: 'sysdelagent',
                    password_hash: passwordHash,
                    phone: '03008888888',
                    email: 'sysdelagent@test.com',
                    role_id: daRoleId,
                    status: 'active',
                    created_at: new Date(),
                    updated_at: new Date()
                }
            });
        }

        // 3. Clean up previously seeded test data to allow idempotency
        const testUsernames = ['rec_dummy1', 'rec_dummy2', 'rec_dummy3', 'rec_dummy4'];
        const testMobiles = [];
        const testOrderRefs = [];
        for (let idx = 100; idx <= 150; idx++) {
            testMobiles.push(`0311222${idx}`);
            testOrderRefs.push(`ORD-REC-${idx}`);
        }

        console.log('Cleaning up previously seeded dummy recovery data explicitly...');

        // Delete CashSubmissionHistory
        await prisma.cashSubmissionHistory.deleteMany({
            where: {
                cash_in_hand: {
                    order: {
                        order_ref: { in: testOrderRefs }
                    }
                }
            }
        });

        // Delete CashInHand
        await prisma.cashInHand.deleteMany({
            where: {
                order: {
                    order_ref: { in: testOrderRefs }
                }
            }
        });

        // Delete OfficerTransaction
        await prisma.officerTransaction.deleteMany({
            where: {
                order_ref: { in: testOrderRefs }
            }
        });

        // Delete RecoveryVisitPhoto
        await prisma.recoveryVisitPhoto.deleteMany({
            where: {
                recovery_visit: {
                    order: {
                        order_ref: { in: testOrderRefs }
                    }
                }
            }
        });

        // Delete RecoveryVisit
        await prisma.recoveryVisit.deleteMany({
            where: {
                order: {
                    order_ref: { in: testOrderRefs }
                }
            }
        });

        // Delete PayTriggerDevice
        await prisma.payTriggerDevice.deleteMany({
            where: {
                order_ref: { in: testOrderRefs }
            }
        });

        // Delete ConsumerNumber
        await prisma.consumerNumber.deleteMany({
            where: {
                mobile_number: { in: testMobiles }
            }
        });

        // Delete InstallmentLedger
        await prisma.installmentLedger.deleteMany({
            where: {
                order: {
                    order_ref: { in: testOrderRefs }
                }
            }
        });

        // Delete DeliveryUpload
        await prisma.deliveryUpload.deleteMany({
            where: {
                delivery: {
                    order: {
                        order_ref: { in: testOrderRefs }
                    }
                }
            }
        });

        // Delete Delivery
        await prisma.delivery.deleteMany({
            where: {
                order: {
                    order_ref: { in: testOrderRefs }
                }
            }
        });

        // Delete VerificationDocument
        await prisma.verificationDocument.deleteMany({
            where: {
                verification: {
                    order: {
                        order_ref: { in: testOrderRefs }
                    }
                }
            }
        });

        // Delete PurchaserVerification
        await prisma.purchaserVerification.deleteMany({
            where: {
                verification: {
                    order: {
                        order_ref: { in: testOrderRefs }
                    }
                }
            }
        });

        // Delete GrantorVerification
        await prisma.grantorVerification.deleteMany({
            where: {
                verification: {
                    order: {
                        order_ref: { in: testOrderRefs }
                    }
                }
            }
        });

        // Delete Verification
        await prisma.verification.deleteMany({
            where: {
                order: {
                    order_ref: { in: testOrderRefs }
                }
            }
        });

        // Delete OrderPayment
        await prisma.orderPayment.deleteMany({
            where: {
                order: {
                    order_ref: { in: testOrderRefs }
                }
            }
        });

        // Delete Orders
        await prisma.order.deleteMany({
            where: {
                order_ref: { in: testOrderRefs }
            }
        });

        // Delete Customers
        await prisma.customer.deleteMany({
            where: {
                mobile: { in: testMobiles }
            }
        });

        // Delete Users
        await prisma.user.deleteMany({
            where: {
                username: { in: testUsernames }
            }
        });

        // Delete Dummy Outlet
        await prisma.outlet.deleteMany({
            where: {
                code: 'QTD-999'
            }
        });

        console.log('Cleanup complete.');

        // Clean up test OTPs
        await prisma.otp.deleteMany({
            where: {
                phone: { in: ['03001234561', '03001234562', '03001234563', '03001234564'] }
            }
        });

        // 4. Create Dummy Outlet if not exists
        const dummyOutletCode = 'QTD-999';
        let dummyOutlet = await prisma.outlet.findUnique({
            where: { code: dummyOutletCode }
        });
        if (!dummyOutlet) {
            console.log('Creating Test Dummy Outlet...');
            dummyOutlet = await prisma.outlet.create({
                data: {
                    code: dummyOutletCode,
                    name: 'Test Dummy Outlet',
                    address: 'Test Outlet Address, Karachi',
                    status: 'active'
                }
            });
        }
        console.log(`Outlet 'Test Dummy Outlet' is available with ID ${dummyOutlet.id}`);

        // 5. Create Dummy Recovery Officers
        const dummyOfficers = [
            {
                full_name: 'Test Recovery Officer Sadar',
                username: 'rec_dummy1',
                phone: '03001234561',
                email: 'recdummy1@test.com',
                role_id: recRoleId,
                outlet_id: 1, // Sadar
                status: 'active'
            },
            {
                full_name: 'Test Recovery Officer Gulshan',
                username: 'rec_dummy2',
                phone: '03001234562',
                email: 'recdummy2@test.com',
                role_id: recRoleId,
                outlet_id: 3, // Gulshan
                status: 'active'
            },
            {
                full_name: 'Test Recovery Officer Korangi',
                username: 'rec_dummy3',
                phone: '03001234563',
                email: 'recdummy3@test.com',
                role_id: recRoleId,
                outlet_id: 5, // Korangi
                status: 'active'
            },
            {
                full_name: 'Test Recovery Officer Outlet',
                username: 'rec_dummy4',
                phone: '03001234564',
                email: 'recdummy4@test.com',
                role_id: recRoleId,
                outlet_id: dummyOutlet.id, // Test Dummy Outlet!
                status: 'active'
            }
        ];

        const seededOfficers = [];
        for (const officerData of dummyOfficers) {
            const officer = await prisma.user.create({
                data: {
                    ...officerData,
                    password_hash: passwordHash,
                    created_at: new Date(),
                    updated_at: new Date()
                }
            });
            seededOfficers.push(officer);
            console.log(`Created Recovery Officer: ${officer.full_name} (${officer.username})`);

            // Seed Long-Lived Login OTP
            await prisma.otp.create({
                data: {
                    phone: officer.phone,
                    otp: '12345',
                    purpose: 'login',
                    expiresAt: futureDate,
                    isUsed: false,
                    createdAt: new Date(),
                    updatedAt: new Date()
                }
            });
            console.log(`  └─ Seeded OTP '12345' for phone ${officer.phone}`);
        }

        // 5. Build and seed orders and related data for each officer
        let seedCounter = 100;
        const nowLocal = new Date();

        for (const officer of seededOfficers) {
            console.log(`Seeding recovery cases for ${officer.full_name}...`);

            const cases = [
                {
                    caseType: 'overdue_non_payment',
                    customerName: `Customer Alpha - ${officer.full_name.split(' ').pop()}`,
                    phone: `0311222${seedCounter}`,
                    cnic: `42101-${seedCounter}-1`,
                    product: 'Infinix Hot 30',
                    totalAmount: 32000,
                    advanceAmount: 8000,
                    monthlyAmount: 4000,
                    months: 6,
                    ledgerRows: [
                        { month: 0, amount: 8000, status: 'paid', due_date: subtractDays(nowLocal, 75).toISOString(), paid_at: subtractDays(nowLocal, 75).toISOString(), payment_method: 'Cash' },
                        { month: 1, amount: 4000, status: 'paid', due_date: subtractDays(nowLocal, 45).toISOString(), paid_amount: 4000, paid_at: subtractDays(nowLocal, 45).toISOString(), payment_method: 'Cash' },
                        { month: 2, amount: 4000, status: 'pending', due_date: subtractDays(nowLocal, 15).toISOString(), paid_amount: 0 }, // OVERDUE
                        { month: 3, amount: 4000, status: 'pending', due_date: addDays(nowLocal, 15).toISOString(), paid_amount: 0 },
                        { month: 4, amount: 4000, status: 'pending', due_date: addDays(nowLocal, 45).toISOString(), paid_amount: 0 },
                        { month: 5, amount: 4000, status: 'pending', due_date: addDays(nowLocal, 75).toISOString(), paid_amount: 0 },
                        { month: 6, amount: 4000, status: 'pending', due_date: addDays(nowLocal, 105).toISOString(), paid_amount: 0 }
                    ],
                    hasPtp: true,
                    ptpDays: 3,
                    deviceLockStatus: 'locked'
                },
                {
                    caseType: 'partial_payment_arrears',
                    customerName: `Customer Beta - ${officer.full_name.split(' ').pop()}`,
                    phone: `0311222${seedCounter + 1}`,
                    cnic: `42101-${seedCounter + 1}-1`,
                    product: 'Samsung Galaxy A14',
                    totalAmount: 45000,
                    advanceAmount: 10000,
                    monthlyAmount: 5000,
                    months: 7,
                    ledgerRows: [
                        { month: 0, amount: 10000, status: 'paid', due_date: subtractDays(nowLocal, 85).toISOString(), paid_at: subtractDays(nowLocal, 85).toISOString(), payment_method: 'Cash' },
                        { month: 1, amount: 5000, status: 'paid', due_date: subtractDays(nowLocal, 55).toISOString(), paid_amount: 5000, paid_at: subtractDays(nowLocal, 55).toISOString(), payment_method: 'Cash' },
                        { month: 2, amount: 5000, status: 'partial', due_date: subtractDays(nowLocal, 25).toISOString(), paid_amount: 2000, paid_at: subtractDays(nowLocal, 23).toISOString(), payment_method: 'Cash' }, // 3000 arrears
                        { month: 3, amount: 5000, status: 'pending', due_date: addDays(nowLocal, 5).toISOString(), paid_amount: 0 }, // upcoming due
                        { month: 4, amount: 5000, status: 'pending', due_date: addDays(nowLocal, 35).toISOString(), paid_amount: 0 },
                        { month: 5, amount: 5000, status: 'pending', due_date: addDays(nowLocal, 65).toISOString(), paid_amount: 0 },
                        { month: 6, amount: 5000, status: 'pending', due_date: addDays(nowLocal, 95).toISOString(), paid_amount: 0 },
                        { month: 7, amount: 5000, status: 'pending', due_date: addDays(nowLocal, 125).toISOString(), paid_amount: 0 }
                    ],
                    hasPtp: false,
                    deviceLockStatus: 'unlocked'
                },
                {
                    caseType: 'multiple_installments_overdue',
                    customerName: `Customer Gamma - ${officer.full_name.split(' ').pop()}`,
                    phone: `0311222${seedCounter + 2}`,
                    cnic: `42101-${seedCounter + 2}-1`,
                    product: 'Redmi Note 12',
                    totalAmount: 38000,
                    advanceAmount: 8000,
                    monthlyAmount: 5000,
                    months: 6,
                    ledgerRows: [
                        { month: 0, amount: 8000, status: 'paid', due_date: subtractDays(nowLocal, 100).toISOString(), paid_at: subtractDays(nowLocal, 100).toISOString(), payment_method: 'Cash' },
                        { month: 1, amount: 5000, status: 'pending', due_date: subtractDays(nowLocal, 70).toISOString(), paid_amount: 0 }, // Overdue 1
                        { month: 2, amount: 5000, status: 'pending', due_date: subtractDays(nowLocal, 40).toISOString(), paid_amount: 0 }, // Overdue 2
                        { month: 3, amount: 5000, status: 'pending', due_date: subtractDays(nowLocal, 10).toISOString(), paid_amount: 0 }, // Overdue 3
                        { month: 4, amount: 5000, status: 'pending', due_date: addDays(nowLocal, 20).toISOString(), paid_amount: 0 },
                        { month: 5, amount: 5000, status: 'pending', due_date: addDays(nowLocal, 50).toISOString(), paid_amount: 0 },
                        { month: 6, amount: 5000, status: 'pending', due_date: addDays(nowLocal, 80).toISOString(), paid_amount: 0 }
                    ],
                    hasPtp: false,
                    deviceLockStatus: 'locked'
                }
            ];

            for (const c of cases) {
                // Create Customer
                const customer = await prisma.customer.create({
                    data: {
                        name: c.customerName,
                        mobile: c.phone,
                        cnic: c.cnic,
                        created_at: new Date(),
                        updated_at: new Date()
                    }
                });

                // Create Order
                const order = await prisma.order.create({
                    data: {
                        order_ref: `ORD-REC-${seedCounter}`,
                        token_number: `TOK-REC-${seedCounter}`,
                        customer_name: c.customerName,
                        whatsapp_number: c.phone,
                        address: `Block ${seedCounter % 5 + 1}, House ${seedCounter}, Karachi`,
                        city: 'Karachi',
                        area: 'Gulshan',
                        product_name: c.product,
                        total_amount: c.totalAmount,
                        advance_amount: c.advanceAmount,
                        monthly_amount: c.monthlyAmount,
                        months: c.months,
                        channel: 'mobile_app',
                        status: 'delivered',
                        is_delivered: true,
                        recovery_officer_id: officer.id,
                        outlet_id: officer.outlet_id,
                        customer_id: customer.id,
                        created_at: subtractDays(nowLocal, 100),
                        updated_at: subtractDays(nowLocal, 1),
                        recovery_assigned_at: subtractDays(nowLocal, 10)
                    }
                });

                console.log(`  ├─ Created Order: ${order.order_ref} for ${c.customerName}`);

                // Create Verification
                const verification = await prisma.verification.create({
                    data: {
                        order_id: order.id,
                        verification_officer_id: voOfficer.id,
                        status: 'approved',
                        start_time: subtractDays(nowLocal, 105),
                        end_time: subtractDays(nowLocal, 104),
                        created_at: subtractDays(nowLocal, 105),
                        updated_at: subtractDays(nowLocal, 104)
                    }
                });

                // Create PurchaserVerification
                await prisma.purchaserVerification.create({
                    data: {
                        verification_id: verification.id,
                        name: c.customerName,
                        father_husband_name: 'Father of ' + c.customerName.split(' ')[0],
                        present_address: order.address,
                        permanent_address: order.address,
                        cnic_number: c.cnic,
                        telephone_number: c.phone,
                        employer_name: 'Seeded Employer Co.',
                        employer_address: 'Main Industrial Area, Karachi',
                        designation: 'Accounts Officer',
                        nearest_location: 'Near Metro Station',
                        is_verified: true
                    }
                });

                // Create Delivery Agent Assignment
                const delivery = await prisma.delivery.create({
                    data: {
                        order_id: order.id,
                        delivery_agent_id: delAgent.id,
                        status: 'completed',
                        start_time: subtractDays(nowLocal, 103),
                        end_time: subtractDays(nowLocal, 102),
                        verified: true,
                        product_imei: `IMEI-${seedCounter}`,
                        selected_plan: {
                            advance_amount: c.advanceAmount,
                            monthly_amount: c.monthlyAmount,
                            months: c.months
                        },
                        created_at: subtractDays(nowLocal, 103),
                        updated_at: subtractDays(nowLocal, 102)
                    }
                });

                // Create InstallmentLedger linked to order & delivery
                const ledgerShortId = `L${seedCounter}`;
                await prisma.installmentLedger.create({
                    data: {
                        order_id: order.id,
                        delivery_id: delivery.id, // linked properly!
                        token: `TOKEN-${order.order_ref}`,
                        short_id: ledgerShortId,
                        ledger_rows: c.ledgerRows,
                        created_at: subtractDays(nowLocal, 100),
                        updated_at: subtractDays(nowLocal, 1)
                    }
                });

                // Create PayTriggerDevice
                const deviceImei = `IMEI-${seedCounter}`;
                const device = await prisma.payTriggerDevice.create({
                    data: {
                        imei: deviceImei,
                        device_tag: `TAG-${seedCounter}`,
                        order_id: order.id,
                        order_ref: order.order_ref,
                        delivery_id: delivery.id, // optional link to delivery
                        enrollment_status: 'enrolled',
                        lock_status: c.deviceLockStatus,
                        ptp_status: c.hasPtp ? 'active' : 'none',
                        promised_date: c.hasPtp ? addDays(nowLocal, c.ptpDays) : null,
                        created_at: subtractDays(nowLocal, 100),
                        updated_at: subtractDays(nowLocal, 1)
                    }
                });

                // Create a past recovery visit log
                const visit = await prisma.recoveryVisit.create({
                    data: {
                        order_id: order.id,
                        officer_id: officer.id,
                        latitude: 24.8607 + (seedCounter * 0.001),
                        longitude: 67.0011 + (seedCounter * 0.001),
                        visit_time: subtractDays(nowLocal, 4),
                        customer_feedback: 'Customer was not at home, met spouse. Promised to pay upcoming installment soon.',
                        visit_notes: 'Spouse confirmed salary is delayed. Will revisit.',
                        payment_collected: false,
                        created_at: subtractDays(nowLocal, 4)
                    }
                });

                // If this order has a PTP (Promise to Pay), create a RecoveryVisit that set the PTP
                if (c.hasPtp) {
                    await prisma.recoveryVisit.create({
                        data: {
                            order_id: order.id,
                            officer_id: officer.id,
                            latitude: 24.8607 + (seedCounter * 0.001),
                            longitude: 67.0011 + (seedCounter * 0.001),
                            visit_time: subtractDays(nowLocal, 1),
                            customer_feedback: 'Client requested 3 more days due to emergency. Set promise to pay date.',
                            visit_notes: 'Set PTP to ' + addDays(nowLocal, c.ptpDays).toLocaleDateString(),
                            payment_collected: false,
                            promised_date: addDays(nowLocal, c.ptpDays),
                            created_at: subtractDays(nowLocal, 1)
                        }
                    });
                }

                // 6. Create some unsubmitted CashInHand collections (Day Book data)
                if (c.caseType === 'partial_payment_arrears') {
                    const cashEntry = await prisma.cashInHand.create({
                        data: {
                            officer_id: officer.id,
                            order_id: order.id,
                            amount: 2500, // PKR 2500 collected
                            status: 'pending',
                            payment_method: 'Cash',
                            outlet_id: officer.outlet_id,
                            customer_name: c.customerName,
                            product_name: c.product,
                            imei_serial: deviceImei,
                            cash_type: 'Installment payment',
                            submitted_amount: 0,
                            created_at: subtractDays(nowLocal, 0.5), // half day ago
                            updated_at: subtractDays(nowLocal, 0.5)
                        }
                    });

                    // Create matching transaction history log
                    await prisma.officerTransaction.create({
                        data: {
                            transaction_id: `TX-${seedCounter}`,
                            officer_id: officer.id,
                            type: 'credit',
                            amount: 2500,
                            balance: 2500,
                            status: 'pending',
                            description: `Installment payment collected from ${c.customerName}`,
                            payment_method: 'Cash',
                            order_ref: order.order_ref,
                            transaction_date: subtractDays(nowLocal, 0.5)
                        }
                    });

                    console.log(`  └─ Seeded unsubmitted CashInHand collection: PKR 2500`);
                }

                seedCounter++;
            }
        }

        console.log('Dummy Recovery Officer test data seeded successfully!');
    } catch (error) {
        console.error('Error during seeding:', error);
    } finally {
        await prisma.$disconnect();
    }
}

// Helper date functions
function subtractDays(date, days) {
    const result = new Date(date);
    result.setDate(result.getDate() - days);
    return result;
}

function addDays(date, days) {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
}

seed();
