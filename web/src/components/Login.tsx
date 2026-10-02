import { useState } from 'react';
import { UnauthorizedError } from '../api';
import { login } from '../store';

export function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="login">
      <form
        className="login-card"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!username.trim() || !password) return;
          setBusy(true);
          setErr(null);
          try {
            await login(username.trim(), password);
          } catch (ex) {
            setErr(ex instanceof UnauthorizedError ? 'Wrong username or password.' : ex instanceof Error ? ex.message : String(ex));
          } finally {
            setBusy(false);
          }
        }}
      >
        <svg viewBox="0 0 32 32" width="44" height="44" aria-hidden>
          <rect width="32" height="32" rx="7" fill="var(--panel-2)" />
          <path d="M8 23V9h13M8 16h9" stroke="var(--accent)" strokeWidth="3.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="24" cy="22" r="3" fill="var(--accent)" />
        </svg>
        <h1>SketchUp Factory</h1>
        <label className="field">
          <span>Username</span>
          <input
            className="input"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            className="input"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {err && <div className="login-err">{err}</div>}
        <button className="btn btn-primary btn-block" disabled={busy || !username.trim() || !password}>
          {busy ? 'Checking…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
