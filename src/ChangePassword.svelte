<script>
  let { user, onDone, onLogout } = $props();

  let current = $state('');
  let next = $state('');
  let repeat = $state('');
  let busy = $state(false);
  let error = $state('');

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    if (next !== repeat) { error = 'Las contraseñas nuevas no coinciden'; return; }
    busy = true;
    error = '';
    try {
      const res = await fetch('/api/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current, next }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) onDone(data.user);
      else error = data?.error ?? `HTTP ${res.status}`;
    } catch (_) {
      error = 'Error de red';
    }
    busy = false;
  }
</script>

<div class="wrap">
  <form class="card" onsubmit={submit}>
    <h1>Crea tu contraseña</h1>
    <p>Hola {user.username}, estás usando una contraseña temporal. Elige la tuya para continuar.</p>
    <label for="cp-cur">Contraseña temporal</label>
    <input id="cp-cur" type="password" autocomplete="current-password" bind:value={current} required />
    <label for="cp-new">Nueva contraseña (mín. 8)</label>
    <input id="cp-new" type="password" autocomplete="new-password" bind:value={next} required />
    <label for="cp-rep">Repite la nueva contraseña</label>
    <input id="cp-rep" type="password" autocomplete="new-password" bind:value={repeat} required />
    {#if error}<p class="err">✗ {error}</p>{/if}
    <button type="submit" disabled={busy}>{busy ? 'Guardando…' : 'Guardar y entrar'}</button>
    <button type="button" class="link" onclick={onLogout}>Salir</button>
  </form>
</div>

<style>
  .wrap { min-height: calc(100vh - 65px); display: flex; align-items: center; justify-content: center; padding: 24px; }
  .card {
    width: 100%; max-width: 360px; display: flex; flex-direction: column; gap: 8px; padding: 28px;
    background: #fff; border-radius: 14px; box-shadow: 0 10px 25px rgba(26, 58, 92, 0.12);
  }
  h1 { font-size: 1.4rem; color: var(--foreground); }
  p { color: var(--muted-foreground); font-size: 0.9rem; margin-bottom: 8px; }
  label { font-size: 0.82rem; color: var(--foreground); font-weight: 600; }
  input { padding: 9px 11px; border: 1px solid var(--border); border-radius: 8px; font-size: 0.95rem; }
  button { margin-top: 12px; padding: 10px; border: 0; border-radius: 8px; background: var(--primary); color: #fff; font-size: 0.95rem; cursor: pointer; }
  button:disabled { opacity: 0.6; cursor: default; }
  button.link { margin-top: 0; background: none; color: var(--muted-foreground); font-size: 0.85rem; }
  .err { color: var(--destructive); margin: 0; }
</style>
