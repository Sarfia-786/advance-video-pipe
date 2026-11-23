'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { authClient } from '@/lib/platform/accounts/client.mjs';
import AccountEntitlements from './AccountEntitlements';
import styles from './AccountPortal.module.css';

export default function AccountPortal({ mode, copy, rootPath }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [details, setDetails] = useState(null);
  const [invalidLink, setInvalidLink] = useState(false);
  const verificationReturn = rootPath + '/login?verified=1';
  const { data: session, isPending } = authClient.useSession();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (mode === 'reset' && (!params.get('token') || params.has('error'))) {
      setInvalidLink(true);
      setNotice(copy.invalidToken);
    } else if (mode === 'login' && params.has('error')) {
      setNotice(copy.invalidVerification);
    } else if (mode === 'login' && params.get('verified') === '1') {
      setNotice(copy.verificationDone);
    } else if (mode === 'login' && params.get('deleted') === '1') {
      setNotice(copy.deletionDone);
    }
  }, [mode, copy]);

  useEffect(() => {
    if (mode !== 'account' || !session?.user?.id) return;
    let current = true;
    fetch('/api/platform/v1/me', { cache: 'no-store', credentials: 'same-origin' })
      .then(async response => {
        if (!response.ok) throw new Error('Unable to load profile');
        return response.json();
      })
      .then(data => { if (current) { setDetails(data); setName(data.user.name || ''); } })
      .catch(() => { if (current) setNotice(copy.network); });
    return () => { current = false; };
  }, [mode, session?.user?.id, copy.network]);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setNotice('');
    try {
      let response;
      if (mode === 'signup') {
        response = await authClient.signUp.email({ name, email, password, callbackURL: verificationReturn });
        if (!response.error) setNotice(copy.verify);
      } else if (mode === 'login') {
        response = await authClient.signIn.email({ email, password, callbackURL: rootPath + '/account' });
        if (!response.error) { window.location.assign(rootPath + '/account'); return; }
      } else if (mode === 'recover') {
        response = await authClient.requestPasswordReset({ email, redirectTo: rootPath + '/reset-password' });
        if (!response.error) setNotice(copy.resetSent);
      } else if (mode === 'reset') {
        if (password !== confirmation) { setNotice(copy.passwordMismatch); return; }
        const token = new URLSearchParams(window.location.search).get('token');
        if (!token) { setNotice(copy.invalidToken); return; }
        response = await authClient.resetPassword({ newPassword: password, token });
        if (!response.error) setNotice(copy.resetDone);
      } else if (mode === 'account') {
        response = await authClient.updateUser({ name });
        if (!response.error) setNotice(copy.saved);
      }
      if (response?.error) setNotice(mode === 'login' ? copy.loginFailed : copy.network);
    } catch {
      setNotice(copy.network);
    } finally {
      setPassword('');
      setConfirmation('');
      setBusy(false);
    }
  }

  async function action(which) {
    if (busy) return;
    setBusy(true);
    setNotice('');
    try {
      let response;
      if (which === 'logout') {
        response = await authClient.signOut();
      } else if (which === 'logoutAll') {
        response = await authClient.revokeSessions();
        if (!response.error) response = await authClient.signOut();
      } else if (which === 'delete') {
        if (confirmation !== 'DELETE') { setNotice(copy.deleteConfirm); return; }
        response = await authClient.deleteUser({ password, callbackURL: rootPath + '/login?deleted=1' });
        if (!response.error) { setNotice(copy.deletePending); return; }
      }
      if (response?.error) setNotice(response.error.message || copy.network);
      else window.location.assign(rootPath + '/login');
    } catch {
      setNotice(copy.network);
    } finally {
      setPassword('');
      setBusy(false);
    }
  }

  const heading = ({ signup: copy.signup, login: copy.login, recover: copy.recover,
                     reset: copy.reset, account: copy.account })[mode];
  const submitLabel = ({ signup: copy.submitSignup, login: copy.submitLogin,
                         recover: copy.submitRecover, reset: copy.submitReset,
                         account: copy.save })[mode];

  return <main className={styles.page}>
    <div className={styles.shell}>
      <Link className={styles.back} href={rootPath + '/studio'}>← {copy.studio}</Link>
      <section className={styles.card}>
        <h1>{heading}</h1>
        {mode === 'account' && isPending ? <p>{copy.loading}</p> :
         mode === 'account' && !session?.user ? <p>{copy.requiresLogin} <Link href={rootPath + '/login'}>{copy.login}</Link></p> :
        <>
          {mode === 'account' && details && <div className={styles.details}>
            <div><span>{copy.email}</span><strong>{details.user.email}</strong></div>
            <div><span>{copy.status}</span><strong>{details.user.emailVerified ? copy.verified : copy.unverified}</strong></div>
            <div><span>{copy.plan}</span><strong>{copy.entitlements.plans[details.plan]}</strong></div>
            <div><span>{copy.workspace}</span><strong>{details.personalWorkspaceId}</strong></div>
            <div><span>{copy.credits}</span><strong>{details.creditUsage.available}</strong></div>
            <div><span>{copy.reservedCredits}</span><strong>{details.creditUsage.reserved}</strong></div>
            <div><span>{copy.spentCredits}</span><strong>{details.creditUsage.spent}</strong></div>
          </div>}
          {mode === 'account' && details?.user.id === session?.user?.id && details?.entitlements &&
            <AccountEntitlements key={details.user.id} entitlements={details.entitlements}
              copy={copy.entitlements} locale={rootPath === '/zh' ? 'zh-CN' : 'en'} />}
          {!(mode === 'reset' && invalidLink) && <form className={styles.form} onSubmit={submit}>
            {(mode === 'signup' || mode === 'account') && <label className={styles.field}>
              {copy.name}<input name="name" autoComplete="name" required maxLength={200}
                value={name} onChange={event => setName(event.target.value)} />
            </label>}
            {['signup', 'login', 'recover'].includes(mode) && <label className={styles.field}>
              {copy.email}<input type="email" name="email" autoComplete="email" required
                maxLength={320} value={email} onChange={event => setEmail(event.target.value)} />
            </label>}
            {['signup', 'login', 'reset'].includes(mode) && <label className={styles.field}>
              {mode === 'reset' ? copy.newPassword : copy.password}
              <input type="password" name="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                minLength={mode === 'login' ? undefined : 12} required maxLength={128}
                value={password} onChange={event => setPassword(event.target.value)} />
            </label>}
            {mode === 'reset' && <label className={styles.field}>
              {copy.confirmPassword}<input type="password" required minLength={12} maxLength={128}
                autoComplete="new-password" value={confirmation}
                onChange={event => setConfirmation(event.target.value)} />
            </label>}
            <button className={styles.button} disabled={busy} type="submit">
              {busy ? copy.sending : submitLabel}
            </button>
          </form>}
          {mode === 'account' && <div>
            <hr className={styles.divider}/>
            <div className={styles.form}>
              <button className={[styles.button, styles.secondary].join(' ')} disabled={busy}
                onClick={() => action('logout')} type="button">{copy.logout}</button>
              <button className={[styles.button, styles.secondary].join(' ')} disabled={busy}
                onClick={() => action('logoutAll')} type="button">{copy.logoutAll}</button>
            </div>
            <hr className={styles.divider}/>
            <p className={styles.warning}>{copy.deleteWarning}</p>
            <div className={styles.form}>
              <label className={styles.field}>{copy.password}
                <input type="password" value={password} autoComplete="current-password"
                  onChange={event => setPassword(event.target.value)} /></label>
              <label className={styles.field}>{copy.deleteConfirm}
                <input value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
              <button type="button" className={[styles.button, styles.danger].join(' ')}
                disabled={busy || confirmation !== 'DELETE' || !password}
                onClick={() => action('delete')}>{copy.deleteAccount}</button>
            </div>
          </div>}
        </>}
        <p className={styles.feedback} role="status" aria-live="polite">{notice}</p>
        <nav className={styles.links} aria-label={copy.account}>
          {mode !== 'signup' && <Link href={rootPath + '/signup'}>{copy.newAccount}</Link>}
          {mode !== 'login' && <Link href={rootPath + '/login'}>{copy.haveAccount}</Link>}
          {mode !== 'recover' && <Link href={rootPath + '/forgot-password'}>{copy.forgot}</Link>}
          <Link href={rootPath + '/account'}>{copy.account}</Link>
        </nav>
      </section>
    </div>
  </main>;
}
