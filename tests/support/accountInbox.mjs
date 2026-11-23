import assert from 'node:assert/strict';

const MAILPIT = process.env.MAILPIT_URL || 'http://localhost:8025';

export async function latestEmail(recipient, subjectPart) {
  for (let attempt = 0; attempt < 35; attempt++) {
    const query = new URLSearchParams({ query: 'to:' + recipient });
    const inbox = await fetch(MAILPIT + '/api/v1/search?' + query).then(r => r.json());
    for (const item of inbox.messages || []) {
      const recipients = (item.To || []).map(to => to.Address);
      if (!recipients.includes(recipient) || !item.Subject?.includes(subjectPart)) continue;
      const message = await fetch(MAILPIT + '/api/v1/message/' + encodeURIComponent(item.ID));
      assert.equal(message.status, 200);
      return message.json();
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('Expected a real SMTP email at local Mailpit for ' + recipient);
}

export function linkFromEmail(message) {
  const match = message.Text?.match(/https?:\/\/[^\s<>"']+/);
  assert.ok(match, 'Expected a link in the plain-text email');
  return match[0].replace(/[)>.,]+$/, '');
}
