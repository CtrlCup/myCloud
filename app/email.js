const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const { getSetting } = require('./db');

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const EMAIL_TEMPLATES_DIR = path.join(__dirname, 'templates', 'email');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Resolves the branding a rendered template email should show: the configured cloud name/app
// URL, and either the admin-uploaded icon (referenced via the same cid attachment sendMail()
// embeds below) or the design's default cloud glyph when no custom icon has been set.
async function getEmailBranding() {
  const cloudName = await getSetting('cloud_name') || 'myCloud';
  const appUrl = await getSetting('app_url') || process.env.APP_URL || 'http://localhost:3030';
  const hasIcon = await getSetting('cloud_icon_path') ? true : false;
  const logoMark = hasIcon
    ? '<img src="cid:mycloud-logo" width="22" height="22" alt="" style="vertical-align:middle; border-radius:4px;">'
    : '<span style="color:#0a84ff;">&#9729;</span>';
  return { cloudName, appUrl, logoMark };
}

// Strips or keeps a <!--MARKER:START-->...<!--MARKER:END--> section, for template blocks that
// only make sense when certain data is present (e.g. an expiry date).
function applyConditionalBlock(html, marker, keep) {
  const startTag = `<!--${marker}:START-->`;
  const endTag = `<!--${marker}:END-->`;
  const startIdx = html.indexOf(startTag);
  const endIdx = html.indexOf(endTag);
  if (startIdx === -1 || endIdx === -1) return html;
  const inner = html.slice(startIdx + startTag.length, endIdx);
  return html.slice(0, startIdx) + (keep ? inner : '') + html.slice(endIdx + endTag.length);
}

// Loads templates/email/<name>.html and substitutes {{KEY}} placeholders. Values are escaped by
// default (most come from user-controlled data like names or file names); pass a value already
// wrapped as { raw: '<img ...>' } for placeholders that carry trusted HTML (e.g. LOGO_MARK).
function renderEmailTemplate(name, vars) {
  let html = fs.readFileSync(path.join(EMAIL_TEMPLATES_DIR, `${name}.html`), 'utf8');
  for (const [key, value] of Object.entries(vars)) {
    const replacement = value && typeof value === 'object' && 'raw' in value ? value.raw : escapeHtml(value);
    html = html.split(`{{${key}}}`).join(replacement);
  }
  return html;
}

async function createTransporter() {
  // Versuche Einstellungen aus der DB zu laden
  const host = await getSetting('email_smtp_host') || process.env.EMAIL_SMTP_HOST;
  const port = await getSetting('email_smtp_port') || process.env.EMAIL_SMTP_PORT || 587;
  const user = await getSetting('email_smtp_user') || process.env.EMAIL_SMTP_USER;
  const pass = await getSetting('email_smtp_pass') || process.env.EMAIL_SMTP_PASS;

  if (!host || !user || !pass) {
    console.log('SMTP settings are incomplete. Mail delivery is disabled.');
    return null;
  }

  return nodemailer.createTransport({
    host,
    port: parseInt(port),
    secure: parseInt(port) === 465, // true für 465, false für andere Ports
    auth: {
      user,
      pass,
    },
  });
}

async function sendMail({ to, subject, text, html, templated }) {
  try {
    const transporter = await createTransporter();
    if (!transporter) {
      console.warn('Mail could not be sent: SMTP not configured');
      return false;
    }

    const fromAddress = await getSetting('email_from') || process.env.EMAIL_FROM || 'noreply@mycloud.local';
    const fromName = await getSetting('email_from_name');
    const from = fromName ? { name: fromName, address: fromAddress } : fromAddress;

    // No SMTP-level equivalent of a sender "profile picture" exists — inbox avatars (Gmail
    // contacts, Gravatar, ...) aren't controllable from the sending server. Embed the cloud's
    // own branding icon as an inline logo in the mail body instead, via a cid: attachment so
    // it always renders without the recipient's client fetching an external image. Templated
    // mails (built via renderEmailTemplate()) already place this same cid inline in their own
    // designed header, so skip the auto-prepended logo there to avoid showing it twice.
    const attachments = [];
    let finalHtml = html;
    if (html) {
      const iconFilename = await getSetting('cloud_icon_path');
      const iconPath = iconFilename && path.join(UPLOADS_DIR, iconFilename);
      if (iconPath && fs.existsSync(iconPath)) {
        attachments.push({ filename: path.basename(iconPath), path: iconPath, cid: 'mycloud-logo' });
        if (!templated) {
          finalHtml = `<img src="cid:mycloud-logo" alt="${fromName || 'myCloud'}" style="height: 40px; margin-bottom: 1.5rem;"><div>${html}</div>`;
        }
      }
    }

    const info = await transporter.sendMail({
      from,
      to,
      subject,
      text,
      html: finalHtml,
      attachments: attachments.length ? attachments : undefined,
    });

    console.log('Message sent: %s', info.messageId);
    return true;
  } catch (error) {
    console.error('Error sending email:', error);
    return false;
  }
}

module.exports = {
  sendMail,
  renderEmailTemplate,
  getEmailBranding,
  applyConditionalBlock,
  escapeHtml,
};
