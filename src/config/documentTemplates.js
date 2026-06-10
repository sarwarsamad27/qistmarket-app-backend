const DOCUMENT_TEMPLATES = [
  {
    doc_type: "offer_letter",
    title: "Offer Letter",
    description: "Formal job offer with compensation details",
    default_content: `<div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto; padding: 40px;">
<h1 style="text-align: center; color: #1a1a2e;">Offer Letter</h1>
<p style="text-align: center; color: #666;">Date: {issue_date}</p>
<hr style="border: 1px solid #e0e0e0; margin: 20px 0;" />
<p><strong>Subject:</strong> Offer of Employment</p>
<p>Dear <strong>{employee_name}</strong>,</p>
<p>We are pleased to offer you the position of <strong>{designation}</strong> in the <strong>{department}</strong> department at <strong>QIST Market</strong>. Your employee ID will be <strong>{employee_id}</strong>.</p>
<p>We were impressed with your qualifications and experience, and we are confident that you will be a valuable addition to our team.</p>
<h3>Compensation Details</h3>
<table style="width: 100%; border-collapse: collapse;">
<tr><td style="padding: 8px; border-bottom: 1px solid #e0e0e0;">Basic Salary</td><td style="padding: 8px; border-bottom: 1px solid #e0e0e0; text-align: right;">Rs. {basic_salary}</td></tr>
<tr><td style="padding: 8px; border-bottom: 1px solid #e0e0e0;">Department</td><td style="padding: 8px; border-bottom: 1px solid #e0e0e0; text-align: right;">{department}</td></tr>
<tr><td style="padding: 8px; border-bottom: 1px solid #e0e0e0;">Designation</td><td style="padding: 8px; border-bottom: 1px solid #e0e0e0; text-align: right;">{designation}</td></tr>
<tr><td style="padding: 8px;">Date of Joining</td><td style="padding: 8px; text-align: right;">{date_of_joining}</td></tr>
</table>
<p style="margin-top: 20px;">Please sign and return this letter to confirm your acceptance of this offer.</p>
<p>Sincerely,<br/><strong>HR Department</strong><br/>QIST Market</p>
</div>`,
  },
  {
    doc_type: "appointment_letter",
    title: "Appointment Letter",
    description: "Official appointment confirmation",
    default_content: `<div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto; padding: 40px;">
<h1 style="text-align: center; color: #1a1a2e;">Appointment Letter</h1>
<p style="text-align: center; color: #666;">Date: {issue_date}</p>
<hr style="border: 1px solid #e0e0e0; margin: 20px 0;" />
<p><strong>Subject:</strong> Appointment Confirmation</p>
<p>Dear <strong>{employee_name}</strong>,</p>
<p>Following your acceptance of our offer, we are pleased to confirm your appointment as <strong>{designation}</strong> at <strong>QIST Market</strong> (Employee ID: {employee_id}).</p>
<p>Your appointment is effective from <strong>{date_of_joining}</strong>. You will be reporting to the {department} department.</p>
<h3>Terms of Appointment</h3>
<ul>
<li>Probation period: 3 months</li>
<li>Working days: Monday to Saturday</li>
<li>Timings: 9:00 AM to 6:00 PM</li>
<li>Annual leave entitlement: As per company policy</li>
</ul>
<p>We look forward to a long and mutually beneficial association.</p>
<p>Sincerely,<br/><strong>HR Department</strong><br/>QIST Market</p>
</div>`,
  },
  {
    doc_type: "warning_letter",
    title: "Warning Letter",
    description: "Official warning or show-cause notice",
    default_content: `<div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto; padding: 40px;">
<h1 style="text-align: center; color: #cc0000;">Warning Letter</h1>
<p style="text-align: center; color: #666;">Date: {issue_date}</p>
<hr style="border: 1px solid #e0e0e0; margin: 20px 0;" />
<p><strong>Subject:</strong> Formal Warning Notice</p>
<p>Dear <strong>{employee_name}</strong> (Employee ID: {employee_id}),</p>
<p>This letter serves as a formal warning regarding your conduct/performance in the <strong>{department}</strong> department.</p>
<p>Details of the issue: <em>{custom_reason}</em></p>
<p>Please be advised that any recurrence of such behavior may result in further disciplinary action, up to and including termination of employment.</p>
<p>You are required to acknowledge receipt of this warning letter.</p>
<p>Sincerely,<br/><strong>HR Department</strong><br/>QIST Market</p>
</div>`,
    has_custom_reason: true,
  },
  {
    doc_type: "experience_letter",
    title: "Experience Letter",
    description: "Certificate of employment experience",
    default_content: `<div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto; padding: 40px;">
<h1 style="text-align: center; color: #1a1a2e;">Experience Certificate</h1>
<p style="text-align: center; color: #666;">Date: {issue_date}</p>
<hr style="border: 1px solid #e0e0e0; margin: 20px 0;" />
<p>To Whom It May Concern,</p>
<p>This is to certify that <strong>{employee_name}</strong> (Employee ID: {employee_id}) was employed with <strong>QIST Market</strong> from <strong>{date_of_joining}</strong> to <strong>{custom_date}</strong>.</p>
<p>During their tenure, {employee_name} served as <strong>{designation}</strong> in the <strong>{department}</strong> department. They demonstrated professionalism, dedication, and strong work ethics.</p>
<p>We wish them the best in their future endeavors.</p>
<p>Sincerely,<br/><strong>HR Department</strong><br/>QIST Market</p>
</div>`,
    has_custom_date: true,
  },
  {
    doc_type: "certificate",
    title: "Training Certificate",
    description: "Certificate of training completion",
    default_content: `<div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto; padding: 40px;">
<h1 style="text-align: center; color: #1a1a2e;">Certificate of Completion</h1>
<p style="text-align: center; color: #666;">Date: {issue_date}</p>
<hr style="border: 1px solid #e0e0e0; margin: 20px 0;" />
<p style="text-align: center; font-size: 18px;">This is proudly presented to</p>
<h2 style="text-align: center; color: #1a1a2e;">{employee_name}</h2>
<p style="text-align: center;">Employee ID: {employee_id}</p>
<p style="text-align: center;">{department} Department</p>
<p>For successfully completing the training program on <strong>{custom_topic}</strong> held on {issue_date}.</p>
<p>We appreciate your dedication to professional growth and development.</p>
<p style="margin-top: 30px;">Authorized Signatory<br/><strong>HR Department</strong><br/>QIST Market</p>
</div>`,
    has_custom_topic: true,
  },
];

const PLACEHOLDER_HELPERS = {
  capitalize: (s) => s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '',
  formatDate: (d) => d ? new Date(d).toLocaleDateString("en-PK", { year: "numeric", month: "long", day: "numeric" }) : 'N/A',
  formatCurrency: (n) => n ? `Rs. ${parseFloat(n).toLocaleString()}` : 'N/A',
};

function renderTemplateContent(template, employee, customFields = {}) {
  const d = new Date();
  const issueDate = d.toLocaleDateString("en-PK", { year: "numeric", month: "long", day: "numeric" });
  const doj = employee.date_of_joining ? new Date(employee.date_of_joining).toLocaleDateString("en-PK", { year: "numeric", month: "long", day: "numeric" }) : 'N/A';
  const baseSalary = employee.basic_salary ? `Rs. ${parseFloat(employee.basic_salary).toLocaleString()}` : 'N/A';

  const replacements = {
    '{employee_name}': employee.full_name || 'N/A',
    '{employee_id}': employee.employee_id || 'N/A',
    '{department}': employee.department || 'N/A',
    '{designation}': employee.designation || 'N/A',
    '{date_of_joining}': doj,
    '{basic_salary}': baseSalary,
    '{issue_date}': issueDate,
    '{custom_reason}': customFields.custom_reason || 'Not specified',
    '{custom_date}': customFields.custom_date || 'Present',
    '{custom_topic}': customFields.custom_topic || 'Professional Development',
  };

  let content = template.default_content;
  for (const [key, value] of Object.entries(replacements)) {
    content = content.replaceAll(key, value);
  }
  return content;
}

function getTemplateByType(docType) {
  return DOCUMENT_TEMPLATES.find((t) => t.doc_type === docType);
}

module.exports = { DOCUMENT_TEMPLATES, getTemplateByType, renderTemplateContent, PLACEHOLDER_HELPERS };
