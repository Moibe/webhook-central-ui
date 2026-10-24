<script>
  import Dashboard from './Dashboard.svelte';
  import Login from './Login.svelte';
  import ChangePassword from './ChangePassword.svelte';
  import Header from './Header.svelte';
  import Users from './Users.svelte';

  let user = $state(null);
  let checking = $state(true);
  let page = $state('dashboard'); // 'dashboard' | 'users'

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
    page = 'dashboard';
  }

  checkSession();
</script>

<Header {user} {page} onNavigate={(p) => (page = p)} onLogout={() => logout(true)} />

{#if checking}
  <p class="boot">Cargando…</p>
{:else if user?.must_change}
  <ChangePassword {user} onDone={(u) => (user = u)} onLogout={() => logout(true)} />
{:else if user}
  {#key user.username}
    <!-- el panel sigue montado al ver Usuarios para no perder su telemetría -->
    <div hidden={page !== 'dashboard'}>
      <Dashboard {user} onLogout={logout} />
    </div>
    {#if page === 'users' && user.role === 'superadmin'}
      <Users />
    {/if}
  {/key}
{:else}
  <Login onLogin={(u) => (user = u)} />
{/if}

<style>
  .boot {
    padding: 48px 40px;
    color: var(--muted-foreground);
  }
</style>
