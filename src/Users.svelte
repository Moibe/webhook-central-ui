<script>
  let { onClose } = $props();

  const TABS = [['dev', 'Dev'], ['prod', 'Prod'], ['open', 'Open']];

  let users = $state([]);
  let error = $state('');
  let newUser = $state({ username: '', tabs: ['dev'] });
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

  const toggle = (tabs, t) => (tabs.includes(t) ? tabs.filter((x) => x !== t) : [...tabs, t]);

  const addUser = () => run(async () => {
    const { temp_password } = await api('/api/users', 'POST', newUser);
    justIssued = { username: newUser.username, password: temp_password };
    newUser = { username: '', tabs: ['dev'] };
  });

  const setTabs = (u, t) => run(() => api(`/api/users/${encodeURIComponent(u.username)}`, 'PATCH', { tabs: toggle(u.tabs, t) }));

  const resetPassword = (u) => {
    if (!confirm(`¿Generar una contraseña temporal nueva para ${u.username}? Se cerrará su sesión.`)) return;
    run(async () => {
      const { temp_password } = await api(`/api/users/${encodeURIComponent(u.username)}`, 'PATCH', { reset: true });
      justIssued = { username: u.username, password: temp_password };
      revealed[u.username] = true;
    });
  };

  const removeUser = (u) => {
    if (confirm(`¿Borrar a ${u.username}?`)) run(() => api(`/api/users/${encodeURIComponent(u.username)}`, 'DELETE'));
  };

  load();
</script>

<div class="modal-backdrop" onclick={onClose} onkeydown={(e) => { if (e.key === 'Escape') onClose(); }} role="presentation">
  <div class="modal" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Usuarios" tabindex="-1">
    <header class="modal-header">
      <h3>Usuarios</h3>
      <button type="button" class="modal-close" onclick={onClose} aria-label="Cerrar">✕</button>
    </header>

    {#if error}<p class="err">✗ {error}</p>{/if}
    {#if justIssued}
      <p class="issued">
        Contraseña temporal de <strong>{justIssued.username}</strong>: <code>{justIssued.password}</code>
        <button type="button" onclick={() => navigator.clipboard?.writeText(justIssued.password)}>Copiar</button>
      </p>
    {/if}

    <table>
      <thead><tr><th>Usuario</th>{#each TABS as [, label]}<th>{label}</th>{/each}<th>Contraseña</th><th></th></tr></thead>
      <tbody>
        {#each users as u (u.username)}
          <tr>
            <td>{u.username}{u.role === 'superadmin' ? ' ★' : ''}</td>
            {#each TABS as [t]}
              <td>
                <input type="checkbox" checked={u.tabs.includes(t)} disabled={u.role === 'superadmin'} onchange={() => setTabs(u, t)} />
              </td>
            {/each}
            <td class="pass">
              {#if u.role === 'superadmin'}
                <span class="muted">—</span>
              {:else if u.temp_password}
                <code>{revealed[u.username] ? u.temp_password : '•••••'}</code>
                <button type="button" class="eye" aria-label={revealed[u.username] ? 'Ocultar' : 'Ver'} onclick={() => (revealed[u.username] = !revealed[u.username])}>
                  {revealed[u.username] ? '🙈' : '👁'}
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
      <input placeholder="usuario" autocomplete="off" bind:value={newUser.username} required />
      {#each TABS as [t, label]}
        <label><input type="checkbox" checked={newUser.tabs.includes(t)} onchange={() => (newUser.tabs = toggle(newUser.tabs, t))} /> {label}</label>
      {/each}
      <button type="submit">Crear</button>
      <span class="muted">Se genera una contraseña temporal de 5 caracteres.</span>
    </form>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(15, 30, 50, 0.45);
    display: flex; align-items: center; justify-content: center; padding: 24px; z-index: 50;
  }
  .modal {
    width: 100%; max-width: 640px; max-height: 90vh; overflow: auto;
    background: #fff; border-radius: 12px; padding: 20px 24px;
    box-shadow: 0 20px 40px rgba(0, 0, 0, 0.25);
  }
  .modal-header { display: flex; justify-content: space-between; align-items: center; padding: 0; margin-bottom: 12px; }
  h3, h4 { color: #1a3a5c; }
  h4 { margin: 18px 0 8px; font-size: 0.95rem; }
  .modal-close { border: 0; background: none; font-size: 1.1rem; cursor: pointer; color: #5a7a9a; }
  table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
  th, td { padding: 7px 8px; text-align: center; border-bottom: 1px solid #e5edf5; }
  th:first-child, td:first-child { text-align: left; }
  .actions { text-align: right; white-space: nowrap; }
  button { padding: 4px 10px; border: 1px solid #c8d8ea; border-radius: 6px; background: #fff; color: #1a3a5c; cursor: pointer; font-size: 0.8rem; }
  button.danger { color: #b91c1c; border-color: #f0c4c4; }
  .new { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 0.85rem; }
  .new input:not([type='checkbox']) { padding: 6px 9px; border: 1px solid #c8d8ea; border-radius: 6px; }
  .pass code, .issued code { font-family: ui-monospace, Consolas, monospace; background: #eef5ff; padding: 2px 6px; border-radius: 4px; }
  .eye { border: 0; background: none; font-size: 0.95rem; padding: 0 4px; }
  .muted { color: #8aa0b8; font-size: 0.8rem; }
  .issued { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 6px; padding: 8px 10px; margin-bottom: 10px; font-size: 0.88rem; color: #166534; }
  .err { color: #b91c1c; font-size: 0.85rem; margin-bottom: 8px; }
</style>
