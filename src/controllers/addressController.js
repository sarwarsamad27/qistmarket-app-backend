const prisma = require('../../lib/prisma');

// Helper functions for timestamps
function now() {
    return new Date();
}

// City Operations
const getCities = async (req, res) => {
    try {
        const { all } = req.query;
        const where = all === 'true' ? {} : { status: 'active' };

        const cities = await prisma.city.findMany({
            where,
            include: { _count: { select: { zones: true } } },
            orderBy: { name: 'asc' }
        });
        return res.json({ success: true, data: cities });
    } catch (error) {
        console.error('getCities error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

const createCity = async (req, res) => {
    const { name, status } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Name is required' });
    try {
        const data = {
            name,
            status: status || 'active',
            created_at: now(),
            updated_at: now()
        };

        const city = await prisma.city.create({ data });
        return res.json({ success: true, data: city });
    } catch (error) {
        console.error('createCity error:', error);
        if (error.code === 'P2002') return res.status(400).json({ success: false, error: 'City already exists' });
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

const updateCity = async (req, res) => {
    const { id } = req.params;
    const { name, status } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Name is required' });
    try {
        const data = {
            name,
            updated_at: now()
        };
        if (status) data.status = status;

        const city = await prisma.city.update({
            where: { id: parseInt(id) },
            data
        });
        return res.json({ success: true, data: city });
    } catch (error) {
        console.error('updateCity error:', error);
        if (error.code === 'P2002') return res.status(400).json({ success: false, error: 'City name already exists' });
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

// Zone Operations
const getZones = async (req, res) => {
    const { cityId, all } = req.query;
    try {
        const where = {};
        if (cityId) where.city_id = parseInt(cityId);
        if (all !== 'true') where.status = 'active';

        const zones = await prisma.zone.findMany({
            where,
            include: { city: true, _count: { select: { areas: true } } },
            orderBy: { name: 'asc' }
        });
        return res.json({ success: true, data: zones });
    } catch (error) {
        console.error('getZones error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

const createZone = async (req, res) => {
    const { name, city_id, status } = req.body;
    if (!name || !city_id) return res.status(400).json({ success: false, error: 'Name and city_id are required' });
    try {
        const data = {
            name,
            city_id: parseInt(city_id),
            status: status || 'active',
            created_at: now(),
            updated_at: now()
        };

        const zone = await prisma.zone.create({ data });
        return res.json({ success: true, data: zone });
    } catch (error) {
        console.error('createZone error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

const updateZone = async (req, res) => {
    const { id } = req.params;
    const { name, city_id, status } = req.body;
    if (!name || !city_id) return res.status(400).json({ success: false, error: 'Name and city_id are required' });
    try {
        const data = {
            name,
            city_id: parseInt(city_id),
            updated_at: now()
        };
        if (status) data.status = status;

        const zone = await prisma.zone.update({
            where: { id: parseInt(id) },
            data
        });
        return res.json({ success: true, data: zone });
    } catch (error) {
        console.error('updateZone error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

// Area Operations
const getAreas = async (req, res) => {
    const { zoneId, all } = req.query;
    try {
        const where = {};
        if (zoneId) where.zone_id = parseInt(zoneId);
        if (all !== 'true') where.status = 'active';

        const areas = await prisma.area.findMany({
            where,
            include: { zone: { include: { city: true } } },
            orderBy: { name: 'asc' }
        });
        return res.json({ success: true, data: areas });
    } catch (error) {
        console.error('getAreas error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

const createArea = async (req, res) => {
    const { name, zone_id, status } = req.body;
    if (!name || !zone_id) return res.status(400).json({ success: false, error: 'Name and zone_id are required' });
    try {
        const data = {
            name,
            zone_id: parseInt(zone_id),
            status: status || 'active',
            created_at: now(),
            updated_at: now()
        };

        const area = await prisma.area.create({ data });
        return res.json({ success: true, data: area });
    } catch (error) {
        console.error('createArea error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

const updateArea = async (req, res) => {
    const { id } = req.params;
    const { name, zone_id, status } = req.body;
    if (!name || !zone_id) return res.status(400).json({ success: false, error: 'Name and zone_id are required' });
    try {
        const data = {
            name,
            zone_id: parseInt(zone_id),
            updated_at: now()
        };
        if (status) data.status = status;

        const area = await prisma.area.update({
            where: { id: parseInt(id) },
            data
        });
        return res.json({ success: true, data: area });
    } catch (error) {
        console.error('updateArea error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

// Hierarchical Fetch
const getAddressHierarchy = async (req, res) => {
    try {
        const { all } = req.query;
        const statusFilter = all === 'true' ? {} : { status: 'active' };

        const hierarchy = await prisma.city.findMany({
            where: statusFilter,
            include: {
                zones: {
                    where: statusFilter,
                    include: {
                        areas: {
                            where: statusFilter
                        }
                    }
                }
            },
            orderBy: { name: 'asc' }
        });
        return res.json({ success: true, data: hierarchy });
    } catch (error) {
        console.error('getAddressHierarchy error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

// Delete Operations
const deleteCity = async (req, res) => {
    const { id } = req.params;
    try {
        await prisma.city.delete({ where: { id: parseInt(id) } });
        return res.json({ success: true, message: 'City deleted' });
    } catch (error) {
        console.error('deleteCity error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

const deleteZone = async (req, res) => {
    const { id } = req.params;
    try {
        await prisma.zone.delete({ where: { id: parseInt(id) } });
        return res.json({ success: true, message: 'Zone deleted' });
    } catch (error) {
        console.error('deleteZone error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

const deleteArea = async (req, res) => {
    const { id } = req.params;
    try {
        await prisma.area.delete({ where: { id: parseInt(id) } });
        return res.json({ success: true, message: 'Area deleted' });
    } catch (error) {
        console.error('deleteArea error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

// Bulk Upload with explicit timestamps
const bulkUploadAddresses = async (req, res) => {
    const { data } = req.body; // Expecting array of { city, zone, area }
    if (!data || !Array.isArray(data)) {
        return res.status(400).json({ success: false, error: 'Invalid data format' });
    }

    try {
        let createdCount = 0;
        let skippedExisting = 0;
        let invalidRows = 0;
        let totalRows = 0;

        for (const row of data) {
            const { city: cityName, zone: zoneName, area: areaName } = row;
            if (!cityName || !zoneName || !areaName) {
                invalidRows++;
                continue;
            }

            totalRows++;

            // 1. Find or create city (with explicit timestamps)
            let city = await prisma.city.findUnique({ where: { name: cityName.trim() } });
            if (!city) {
                city = await prisma.city.create({
                    data: {
                        name: cityName.trim(),
                        status: 'active',
                        created_at: now(),
                        updated_at: now()
                    }
                });
            }

            // 2. Find or create zone
            let zone = await prisma.zone.findFirst({
                where: { name: zoneName.trim(), city_id: city.id }
            });
            if (!zone) {
                zone = await prisma.zone.create({
                    data: {
                        name: zoneName.trim(),
                        city_id: city.id,
                        status: 'active',
                        created_at: now(),
                        updated_at: now()
                    }
                });
            }

            // 3. Find or create area
            const existingArea = await prisma.area.findFirst({
                where: { name: areaName.trim(), zone_id: zone.id }
            });
            if (!existingArea) {
                await prisma.area.create({
                    data: {
                        name: areaName.trim(),
                        zone_id: zone.id,
                        status: 'active',
                        created_at: now(),
                        updated_at: now()
                    }
                });
                createdCount++;
            } else {
                skippedExisting++;
            }
        }

        return res.json({
            success: true,
            message: `Processed ${totalRows} rows. New areas created: ${createdCount}.`,
            stats: {
                totalRows,
                createdCount,
                skippedExisting,
                invalidRows,
            },
        });
    } catch (error) {
        console.error('bulkUploadAddresses error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

module.exports = {
    getCities,
    createCity,
    updateCity,
    deleteCity,
    getZones,
    createZone,
    updateZone,
    deleteZone,
    getAreas,
    createArea,
    updateArea,
    deleteArea,
    getAddressHierarchy,
    bulkUploadAddresses
};