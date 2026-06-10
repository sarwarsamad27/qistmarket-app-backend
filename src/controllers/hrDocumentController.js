const prisma = require('../../lib/prisma');
const { DOCUMENT_TEMPLATES, getTemplateByType, renderTemplateContent } = require('../config/documentTemplates');
const { generateDocumentPdf } = require('../services/documentPdfService');
const sendEmail = require('../utils/sendEmail');

const now = () => new Date();

const getDocumentTemplates = async (req, res) => {
  try {
    const templates = DOCUMENT_TEMPLATES.map((t) => ({
      doc_type: t.doc_type,
      title: t.title,
      description: t.description,
      has_custom_reason: t.has_custom_reason,
      has_custom_date: t.has_custom_date,
      has_custom_topic: t.has_custom_topic,
      default_content_preview: t.default_content.substring(0, 200) + '...',
    }));
    return res.json({ success: true, templates });
  } catch (error) {
    console.error('getDocumentTemplates error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getDocumentTemplatePreview = async (req, res) => {
  try {
    const { doc_type, employee_id } = req.params;

    if (!doc_type || !employee_id) {
      return res.status(400).json({ success: false, message: 'doc_type and employee_id required' });
    }

    const template = getTemplateByType(doc_type);
    if (!template) {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }

    const id = parseInt(employee_id);
    const employee = await prisma.employee.findUnique({
      where: { id },
      include: { payroll_slips: { orderBy: [{ year: 'desc' }, { month: 'desc' }], take: 1 } },
    });
    if (!employee) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }

    const enriched = {
      ...employee,
      basic_salary: employee.payroll_slips?.[0]?.basic_salary || 0,
    };

    const renderedContent = renderTemplateContent(template, enriched);
    const { password_hash, ...safe } = enriched;

    return res.json({
      success: true,
      template: { doc_type: template.doc_type, title: template.title },
      employee: safe,
      renderedContent,
    });
  } catch (error) {
    console.error('getDocumentTemplatePreview error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const issueDocument = async (req, res) => {
  try {
    const { doc_type, employee_id, custom_content, custom_fields, send_via_email } = req.body;

    if (!doc_type || !employee_id) {
      return res.status(400).json({ success: false, message: 'doc_type and employee_id required' });
    }

    const template = getTemplateByType(doc_type);
    if (!template) {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }

    const id = parseInt(employee_id);
    const employee = await prisma.employee.findUnique({
      where: { id },
      include: { payroll_slips: { orderBy: [{ year: 'desc' }, { month: 'desc' }], take: 1 } },
    });
    if (!employee) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }

    const enriched = {
      ...employee,
      basic_salary: employee.payroll_slips?.[0]?.basic_salary || 0,
    };

    const finalContent = custom_content || renderTemplateContent(template, enriched, custom_fields || {});
    const docTitle = `${template.title} - ${employee.full_name}`;

    // Generate PDF
    const pdf = await generateDocumentPdf(docTitle, finalContent);

    // Save to EmployeeDocument
    const doc = await prisma.employeeDocument.create({
      data: {
        employee_id: employee.id,
        doc_type,
        title: docTitle,
        file_url: pdf.url,
      },
    });

    // Create notification for employee
    await prisma.employeeNotification.create({
      data: {
        employee_id: employee.id,
        title: `New Document: ${template.title}`,
        message: `Your ${template.title} has been issued. You can view it in your Document Center.`,
        type: 'document',
      },
    });

    // Send email if requested and employee has email
    if (send_via_email !== false && employee.email) {
      try {
        const emailHtml = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #1a1a2e;">${template.title}</h2>
            <p>Dear ${employee.full_name},</p>
            <p>Your <strong>${template.title}</strong> has been issued by the HR department.</p>
            <p>Please find the document attached to this email. You can also view it in your Employee Portal under Document Center.</p>
            <hr style="border: 1px solid #e0e0e0; margin: 20px 0;" />
            <p style="font-size: 12px; color: #888;">QIST Market — Har Chez Qist Pey</p>
          </div>
        `;
        await sendEmail({
          to: employee.email,
          subject: docTitle,
          html: emailHtml,
          attachments: [{ filename: `${docTitle}.pdf`, path: pdf.filepath }],
        });
      } catch (emailErr) {
        console.error('Failed to send document email:', emailErr.message);
        // Don't fail the whole request if email fails
      }
    }

    return res.status(201).json({
      success: true,
      message: `Document issued successfully to ${employee.full_name}`,
      document: doc,
      pdfUrl: pdf.url,
      employeeName: employee.full_name,
    });
  } catch (error) {
    console.error('issueDocument error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const bulkIssueDocument = async (req, res) => {
  try {
    const { doc_type, employee_ids, custom_content, send_via_email } = req.body;

    if (!doc_type || !employee_ids?.length) {
      return res.status(400).json({ success: false, message: 'doc_type and employee_ids required' });
    }

    const results = [];
    const errors = [];

    for (const eid of employee_ids) {
      try {
        const result = await issueDocumentHelper({ doc_type, employee_id: eid, custom_content, send_via_email });
        results.push(result);
      } catch (err) {
        errors.push({ employee_id: eid, error: err.message });
      }
    }

    return res.json({
      success: true,
      issued: results.length,
      errors: errors.length,
      results,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error('bulkIssueDocument error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

async function issueDocumentHelper({ doc_type, employee_id, custom_content, send_via_email, custom_fields }) {
  const template = getTemplateByType(doc_type);
  if (!template) throw new Error('Template not found');

  const employee = await prisma.employee.findUnique({
    where: { id: parseInt(employee_id) },
    include: { payroll_slips: { orderBy: [{ year: 'desc' }, { month: 'desc' }], take: 1 } },
  });
  if (!employee) throw new Error('Employee not found');

  const enriched = {
    ...employee,
    basic_salary: employee.payroll_slips?.[0]?.basic_salary || 0,
  };

  const finalContent = custom_content || renderTemplateContent(template, enriched, custom_fields || {});
  const docTitle = `${template.title} - ${employee.full_name}`;
  const pdf = await generateDocumentPdf(docTitle, finalContent);

  const doc = await prisma.employeeDocument.create({
    data: { employee_id: employee.id, doc_type, title: docTitle, file_url: pdf.url },
  });

  await prisma.employeeNotification.create({
    data: {
      employee_id: employee.id,
      title: `New Document: ${template.title}`,
      message: `Your ${template.title} has been issued. View it in Document Center.`,
      type: 'document',
    },
  });

  if (send_via_email !== false && employee.email) {
    try {
      await sendEmail({
        to: employee.email,
        subject: docTitle,
        html: `<p>Dear ${employee.full_name},<br/>Your <strong>${template.title}</strong> has been issued.</p>`,
        attachments: [{ filename: `${docTitle}.pdf`, path: pdf.filepath }],
      });
    } catch (e) { /* silent */ }
  }

  return { employee_id: employee.id, employee_name: employee.full_name, document: doc, pdfUrl: pdf.url };
}

const editDocument = async (req, res) => {
  try {
    const docId = parseInt(req.params.docId);
    const { content } = req.body;

    if (!content) {
      return res.status(400).json({ success: false, message: 'content is required' });
    }

    const existing = await prisma.employeeDocument.findUnique({ where: { id: docId }, include: { employee: true } });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Document not found' });
    }

    const template = getTemplateByType(existing.doc_type);
    const title = `${template?.title || existing.title} - ${existing.employee.full_name}`;

    const versionPdf = await generateDocumentVersion(title, content, 2, existing.file_url);

    const doc = await prisma.employeeDocument.update({
      where: { id: docId },
      data: { file_url: versionPdf.pdf.url, title },
    });

    await prisma.employeeNotification.create({
      data: {
        employee_id: existing.employee.id,
        title: `Document Updated: ${template?.title || existing.doc_type}`,
        message: `Your document has been updated to version 2. View it in Document Center.`,
        type: 'document',
      },
    });

    return res.json({ success: true, document: doc, history: versionPdf.history });
  } catch (error) {
    console.error('editDocument error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getDocumentHistory = async (req, res) => {
  try {
    const docId = parseInt(req.params.docId);
    const existing = await prisma.employeeDocument.findUnique({ where: { id: docId } });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Document not found' });
    }
    return res.json({
      success: true,
      document: existing,
      versions: [{ version: 1, url: existing.file_url, createdAt: existing.created_at }],
    });
  } catch (error) {
    console.error('getDocumentHistory error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

module.exports = {
  getDocumentTemplates,
  getDocumentTemplatePreview,
  issueDocument,
  bulkIssueDocument,
  editDocument,
  getDocumentHistory,
};
