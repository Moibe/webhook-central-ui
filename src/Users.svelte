<script>
  import ConfirmDialog from './ConfirmDialog.svelte';

  let users = $state([]);
  let error = $state('');
  let newUser = $state({ username: '', email: '', phone: '' });
  let revealed = $state({}); // username -> true si el ojito está abierto
  let justIssued = $state(null); // { username, password } recién generada, para copiarla

  async function api(path, method = 'GET', body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
    return data;
  }

  async function load() {
    try {
      users = await api('/api/users');
    } catch (e) {
      error = e.message;
    }
  }

  async function run(fn) {
    error = '';
    try {
      await fn();
      await load();
    } catch (e) {
      error = e.message;
    }
  }

  const addUser = () => run(async () => {
    const { temp_password } = await api('/api/users', 'POST', newUser);
    justIssued = { username: newUser.username, password: temp_password };
    newUser = { username: '', email: '', phone: '' };
  });

  const setContact = (u, field, value) => run(() => api(`/api/users/${encodeURIComponent(u.username)}`, 'PATCH', { [field]: value }));

  let pending = $state(null); // { kind: 'reset' | 'delete', user }

  const resetPassword = (u) => (pending = { kind: 'reset', user: u });
  const removeUser = (u) => (pending = { kind: 'delete', user: u });

  function confirmPending() {
    const { kind, user: u } = pending;
    pending = null;
    if (kind === 'delete') {
      run(() => api(`/api/users/${encodeURIComponent(u.username)}`, 'DELETE'));
    } else {
      run(async () => {
        const { temp_password } = await api(`/api/users/${encodeURIComponent(u.username)}`, 'PATCH', { reset: true });
        justIssued = { username: u.username, password: temp_password };
        revealed[u.username] = true;
      });
    }
  }

  load();
</script>

<ConfirmDialog
  open={!!pending}
  title={pending?.kind === 'delete' ? `¿Borrar a ${pending.user.username}?` : `¿Restablecer la contraseña de ${pending?.user.username}?`}
  message={pending?.kind === 'delete'
    ? 'Se eliminará el usuario y se cerrarán sus sesiones. Esta acción no se puede deshacer.'
    : 'Se generará una contraseña temporal nueva y se cerrará su sesión actual.'}
  confirmLabel={pending?.kind === 'delete' ? 'Borrar' : 'Restablecer'}
  onConfirm={confirmPending}
  onCancel={() => (pending = null)}
/>

<div class="users-page">
  <div class="card">
    <h2>Usuarios</h2>

    {#if error}<p class="err">✗ {error}</p>{/if}
    {#if justIssued}
      <p class="issued">
        Contraseña temporal de <strong>{justIssued.username}</strong>: <code>{justIssued.password}</code>
        <button type="button" onclick={() => navigator.clipboard?.writeText(justIssued.password)}>Copiar</button>
      </p>
    {/if}

    <table>
      <thead><tr><th>Usuario</th><th>Correo</th><th>Celular</th><th>Contraseña</th><th></th></tr></thead>
      <tbody>
        {#each users as u (u.username)}
          <tr>
            <td>{u.username}{u.role === 'superadmin' ? ' ★' : ''}</td>
            <td class="contact">
              <input type="email" value={u.email} placeholder="correo" autocomplete="off" onchange={(e) => setContact(u, 'email', e.currentTarget.value)} />
            </td>
            <td class="contact">
              <input type="tel" value={u.phone} placeholder="celular" autocomplete="off" onchange={(e) => setContact(u, 'phone', e.currentTarget.value)} />
            </td>
            <td class="pass">
              {#if u.role === 'superadmin'}
                <span class="muted">—</span>
              {:else if u.temp_password}
                <code>{revealed[u.username] ? u.temp_password : '•••••'}</code>
                <button type="button" class="eye" aria-label={revealed[u.username] ? 'Ocultar' : 'Ver'} onclick={() => (revealed[u.username] = !revealed[u.username])}>
                  {revealed[u.username] ? '🙈' : '👁'}
                </button>
                <!-- Envío de la contraseña temporal: aún sin funcionalidad -->
                <button type="button" class="send" aria-disabled="true" title="Enviar contraseña por correo (próximamente)" aria-label="Enviar contraseña por correo">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
                </button>
                <button type="button" class="send" aria-disabled="true" title="Enviar contraseña por celular (próximamente)" aria-label="Enviar contraseña por celular">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/></svg>
                </button>
              {:else}
                <span class="muted" title="El usuario ya definió la suya; solo se guarda su hash">propia</span>
              {/if}
            </td>
            <td class="actions">
              {#if u.role !== 'superadmin'}
                <button type="button" onclick={() => resetPassword(u)}>Restablecer</button>
                <button type="button" class="danger" onclick={() => removeUser(u)}>Borrar</button>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>

    <h4>Nuevo usuario</h4>
    <form class="new" onsubmit={(e) => { e.preventDefault(); addUser(); }}>
      <input placeholder="usuario (= owner)" autocomplete="off" bind:value={newUser.username} required />
      <input type="email" placeholder="correo (opcional)" autocomplete="off" bind:value={newUser.email} />
      <input type="tel" placeholder="celular (opcional)" autocomplete="off" bind:value={newUser.phone} />
      <button type="submit">Crear</button>
      <span class="muted">Se genera una contraseña temporal de 5 caracteres.</span>
    </form>
  </div>
</div>

<style>
  .users-page { padding: 16px 40px 32px; }
  .card {
    max-width: 1100px; background: #fff; border-radius: 14px; padding: 20px 24px;
    box-shadow: 0 4px 14px rgba(26, 58, 92, 0.1);
  }
  h2 { margin-bottom: 12px; }
  h2, h4 { color: var(--foreground); }
  h4 { margin: 18px 0 8px; font-size: 0.95rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
  th, td { padding: 7px 8px; text-align: center; border-bottom: 1px solid #e5edf5; }
  th:first-child, td:first-child { text-align: left; }
  .contact input { width: 100%; min-width: 150px; padding: 5px 8px; border: 1px solid #e5edf5; border-radius: 8px; font-size: 0.85rem; color: var(--foreground); }
  .contact input:focus { border-color: var(--primary); outline: none; }
  .actions { text-align: right; white-space: nowrap; }
  button { padding: 4px 10px; border: 1px solid var(--border); border-radius: 8px; background: #fff; color: var(--foreground); cursor: pointer; font-size: 0.8rem; }
  button.danger { color: var(--destructive); border-color: #f0c4c4; }
  .new { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 0.85rem; }
  .new input:not([type='checkbox']) { padding: 6px 9px; border: 1px solid var(--border); border-radius: 8px; }
  .pass code, .issued code { font-family: ui-monospace, Consolas, monospace; background: var(--muted); padding: 2px 6px; border-radius: 4px; }
  .send { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; margin-left: 2px; color: var(--muted-foreground); cursor: not-allowed; opacity: 0.6; }
  .send svg { width: 14px; height: 14px; }
  .eye { border: 0; background: none; font-size: 0.95rem; padding: 0 4px; }
  .muted { color: #8aa0b8; font-size: 0.8rem; }
  .issued { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 8px 10px; margin-bottom: 10px; font-size: 0.88rem; color: #166534; }
  .err { color: var(--destructive); font-size: 0.85rem; margin-bottom: 8px; }
</style>
