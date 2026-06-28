const nodemailer = require('nodemailer');
const { getSetting } = require('./db');

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

async function sendMail({ to, subject, text, html }) {
  try {
    const transporter = await createTransporter();
    if (!transporter) {
      console.warn('Mail could not be sent: SMTP not configured');
      return false;
    }

    const from = await getSetting('email_from') || process.env.EMAIL_FROM || 'noreply@mycloud.local';

    const info = await transporter.sendMail({
      from,
      to,
      subject,
      text,
      html,
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
};
