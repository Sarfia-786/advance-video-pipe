'use client';

import { useState } from 'react';
import styles from './AccountPortal.module.css';

export default function AccountEntitlements({ entitlements, copy, locale }) {
  const [history, setHistory] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { capabilities, limits, status, accessUntil } = entitlements;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const numbers = new Intl.NumberFormat(locale);

  async function loadHistory() {
    setLoading(true);
    setError('');
    try {
      const query = history?.nextBefore ? '?' + new URLSearchParams({ before: history.nextBefore }) : '';
      const response = await fetch('/api/platform/v1/usage/history' + query, { cache: 'no-store' });
      if (response.status === 401 || response.status === 403) {
        setHistory(null);
        setError(copy.accessChanged);
        return;
      }
      if (!response.ok) throw new Error('History request failed');
      const page = await response.json();
      setHistory({ entries: [...(history?.entries || []), ...page.entries], nextBefore: page.nextBefore });
    } catch {
      setError(copy.historyError);
    } finally {
      setLoading(false);
    }
  }

  return <section className={styles.entitlements} aria-label={copy.limits}>
    <h2>{copy.limits}</h2>
    <dl>
      <dt>{copy.subscription}</dt><dd>{copy.statuses[status]}</dd>
      {accessUntil && <><dt>{copy.accessUntil}</dt><dd><time dateTime={accessUntil}>{date.format(new Date(accessUntil))}</time></dd></>}
      <dt>{copy.projects}</dt><dd>{limits.projectExpiryDays === null ? copy.persistent : copy.days.replace('{n}', limits.projectExpiryDays)}</dd>
      <dt>{copy.storage}</dt><dd>{numbers.format(limits.storageMiB)} MiB</dd>
      <dt>{copy.voice}</dt><dd>{copy.minutes.replace('{n}', numbers.format(limits.monthlyVoiceMinutes))}</dd>
      <dt>{copy.concurrency}</dt><dd>{numbers.format(limits.maxConcurrentJobs)}</dd>
      <dt>{copy.watermark}</dt><dd>{capabilities.watermarkRequired ? copy.required : copy.off}</dd>
    </dl>
    {capabilities.usageHistory === 'detailed' && <div>
      {history && (history.entries.length ? <table>
        <caption>{copy.history}</caption>
        <thead><tr><th scope="col">{copy.date}</th><th scope="col">{copy.activity}</th><th scope="col">{copy.credits}</th></tr></thead>
        <tbody>{history.entries.map(entry => <tr key={entry.id}>
          <td><time dateTime={entry.createdAt}>{date.format(new Date(entry.createdAt))}</time></td>
          <td>{copy.kinds[entry.kind]}</td><td>{numbers.format(BigInt(entry.amount))}</td>
        </tr>)}</tbody>
      </table> : <p>{copy.noEntries}</p>)}
      {(!history || history.nextBefore) && <button type="button" className={styles.historyButton} onClick={loadHistory} disabled={loading}>
        {loading ? copy.loading : history ? copy.more : copy.history}
      </button>}
      {error && <p role="alert">{error}</p>}
    </div>}
  </section>;
}
