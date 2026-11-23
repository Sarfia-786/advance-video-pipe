import nodemailer from 'nodemailer';

let transporter;

export function validateMailSettings(env = process.env) {
  const host = env.SMTP_HOST;
  const from = env.SMTP_FROM;
  const port = Number(env.SMTP_PORT ?? '1025');
  if (!host || !from || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Configure SMTP_HOST, SMTP_PORT and SMTP_FROM before enabling email authentication');
  }
  if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASSWORD)) {
    throw new Error('SMTP_USER and SMTP_PASSWORD must both be configured or both be absent');
  }
  return { host, port, from, secure: env.SMTP_SECURE === 'true' };
}

export function assertSameOriginLink(url, origin = process.env.BETTER_AUTH_URL) {
  const target = new URL(url);
  if (!origin || target.origin !== new URL(origin).origin || !/^https?:$/.test(target.protocol)) {
    throw new Error('Refusing to email a link outside the configured application origin');
  }
  return target.toString();
}

export async function sendAccountEmail({ to, subject, action, url }) {
  const options = validateMailSettings();
  const safeUrl = assertSameOriginLink(url);
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure,
      requireTLS: Boolean(process.env.SMTP_USER) && !options.secure,
      ...(process.env.SMTP_USER ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } } : {}),
    });
  }
  await transporter.sendMail({
    from: options.from,
    to,
    subject,
    text: action + '\n\n' + safeUrl + '\n\nIf you did not request this, ignore the message.',
  });
}
