<script>
  import Dashboard from './Dashboard.svelte';
  import Login from './Login.svelte';
  import ChangePassword from './ChangePassword.svelte';

  let user = $state(null);
  let checking = $state(true);

  async function checkSession() {
    try {
      const res = await fetch('/api/me');
      if (res.ok) user = (await res.json()).user;
    } catch (_) {
      // sin red: se queda en login
    }
    checking = false;
  }

  async function logout(callServer) {
    if (callServer) await fetch('/api/logout', { method: 'POST' }).catch(() => {});
    user = null;
  }

  checkSession();
</script>

{#if checking}
  <p class="boot">Cargando…</p>
{:else if user?.must_change}
  <ChangePassword {user} onDone={(u) => (user = u)} onLogout={() => logout(true)} />
{:else if user}
  {#key user.username}
    <Dashboard {user} onLogout={logout} />
  {/key}
{:else}
  <Login onLogin={(u) => (user = u)} />
{/if}

<style>
  .boot {
    padding: 48px 40px;
    color: #5a7a9a;
  }
</style>
