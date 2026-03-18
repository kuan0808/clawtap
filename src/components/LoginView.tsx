import { useState, type FormEvent } from 'react';
import { api, setToken } from '../lib/api';
import { Button } from './ui/button';
import { ClawAscii } from './ui/ClawLogo';

export function LoginView({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { token } = await api.login(password);
      setToken(token);
      onLogin();
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-bg p-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm space-y-4"
      >
        <div className="text-center space-y-2">
          <ClawAscii className="mx-auto text-glow" />
          <h1 className="text-2xl font-bold font-mono tracking-wider text-text text-glow">ClawTap</h1>
          <p className="text-text-dim font-mono text-xs">remote terminal</p>
        </div>

        <div>
          <span className="text-accent font-mono text-xs mb-1 block">password:</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter password"
            className="w-full bg-surface border border-border rounded-md px-3 py-2 text-sm text-text font-mono placeholder-text-dim focus:outline-none focus:border-accent focus:shadow-[0_0_8px_var(--color-accent-glow)]"
            autoFocus
          />
        </div>

        {error && (
          <p className="text-danger text-sm">{error}</p>
        )}

        <Button
          type="submit"
          disabled={loading || !password}
          className="w-full"
        >
          {loading ? 'Signing in...' : 'Sign In'}
        </Button>
      </form>
    </div>
  );
}
