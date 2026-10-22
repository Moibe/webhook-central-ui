<script>
  let { onLogin } = $props();

  let username = $state('');
  let password = $state('');
  let busy = $state(false);
  let error = $state('');

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    busy = true;
    error = '';
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) onLogin(data.user);
      else error = data?.error ?? `HTTP ${res.status}`;
    } catch (_) {
      error = 'Error de red';
    }
    busy = false;
  }
</script>

<div class="login-wrap">
  <form class="login-card" onsubmit={submit}>
    <h1>Buzzword IA DevOps</h1>
    <p>Inicia sesión para continuar</p>
    <label for="login-user">Usuario</label>
    <input id="login-user" type="text" autocomplete="username" bind:value={username} required />
    <label for="login-pass">Contraseña</label>
    <input id="login-pass" type="password" autocomplete="current-password" bind:value={password} required />
    {#if error}<p class="login-error">✗ {error}</p>{/if}
    <button type="submit" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
  </form>
</div>

<style>
  .login-wrap {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }

  .login-card {
    width: 100%;
    max-width: 360px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 28px;
    background: #fff;
    border-radius: 12px;
    box-shadow: 0 10px 25px rgba(26, 58, 92, 0.12);
  }

  h1 {
    font-size: 1.4rem;
    color: #1a3a5c;
  }

  p {
    color: #5a7a9a;
    font-size: 0.9rem;
    margin-bottom: 8px;
  }

  label {
    font-size: 0.82rem;
    color: #1a3a5c;
    font-weight: 600;
  }

  input {
    padding: 9px 11px;
    border: 1px solid #c8d8ea;
    border-radius: 6px;
    font-size: 0.95rem;
  }

  button {
    margin-top: 12px;
    padding: 10px;
    border: 0;
    border-radius: 6px;
    background: #2563eb;
    color: #fff;
    font-size: 0.95rem;
    cursor: pointer;
  }

  button:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .login-error {
    color: #b91c1c;
    margin: 0;
  }
</style>
