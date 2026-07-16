/**
 * Helper to get outlet filter based on user role and query
 * Priority: If user has outlet_id in JWT → always scope to that outlet
 * Only if user has NO outlet_id (pure admin/HO users) → check for query param
 */
const getOutletFilter = (req) => {
    const { outlet_id: userOutletId } = req.user;

    // If the logged-in user is assigned to a specific outlet, ALWAYS scope to it
    if (userOutletId) {
        return { outlet_id: Number(userOutletId) };
    }

    // Head Office / Super Admin / Accountant: no outlet_id in token → can query any outlet
    const queryOutletId = req.query.outletId || req.query.outlet_id;
    if (queryOutletId && queryOutletId !== 'all') {
        return { outlet_id: Number(queryOutletId) };
    }

    // No filter = see all outlets
    return {};
};

module.exports = { getOutletFilter };
