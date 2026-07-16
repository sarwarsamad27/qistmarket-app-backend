const prisma = require('../../lib/prisma');
const { REPORT_TYPES, getReportRows, rowsToCsvBuffer } = require('../services/scheduledReportService');

/**
 * exportReportCsv
 * On-demand CSV export for a report type — reuses the exact same row
 * generator the scheduled-email cron job uses, so ad-hoc and scheduled
 * exports are always identical.
 */
const exportReportCsv = async (req, res) => {
    try {
        const { reportType } = req.params;
        if (!REPORT_TYPES.includes(reportType)) {
            return res.status(400).json({ success: false, message: `reportType must be one of: ${REPORT_TYPES.join(', ')}` });
        }

        const rows = await getReportRows(reportType);
        const csv = rowsToCsvBuffer(rows);

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${reportType}_${new Date().toISOString().slice(0, 10)}.csv"`);
        res.send(csv);
    } catch (error) {
        console.error('exportReportCsv error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const createScheduledReport = async (req, res) => {
    try {
        const { report_type, frequency, recipients } = req.body;
        if (!REPORT_TYPES.includes(report_type) || !['daily', 'weekly', 'monthly'].includes(frequency) || !recipients) {
            return res.status(400).json({ success: false, message: `report_type (${REPORT_TYPES.join('/')}), frequency (daily/weekly/monthly), and recipients are required.` });
        }

        const config = await prisma.scheduledReportConfig.create({
            data: { report_type, frequency, recipients, created_by_id: req.user.id },
        });

        res.status(201).json({ success: true, data: config });
    } catch (error) {
        console.error('createScheduledReport error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getScheduledReports = async (req, res) => {
    try {
        const configs = await prisma.scheduledReportConfig.findMany({
            include: { created_by: { select: { full_name: true } } },
            orderBy: { created_at: 'desc' },
        });
        res.json({ success: true, data: configs });
    } catch (error) {
        console.error('getScheduledReports error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const toggleScheduledReport = async (req, res) => {
    try {
        const { id } = req.params;
        const { is_active } = req.body;
        const config = await prisma.scheduledReportConfig.update({ where: { id: parseInt(id) }, data: { is_active: !!is_active } });
        res.json({ success: true, data: config });
    } catch (error) {
        console.error('toggleScheduledReport error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const deleteScheduledReport = async (req, res) => {
    try {
        await prisma.scheduledReportConfig.delete({ where: { id: parseInt(req.params.id) } });
        res.json({ success: true, message: 'Scheduled report removed.' });
    } catch (error) {
        console.error('deleteScheduledReport error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

module.exports = {
    exportReportCsv,
    createScheduledReport,
    getScheduledReports,
    toggleScheduledReport,
    deleteScheduledReport,
};
