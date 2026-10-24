<script>
  let { user = null, page = 'dashboard', onNavigate, onLogout } = $props();

  const isSuper = $derived(user?.role === 'superadmin');
</script>

<header class="site-header">
  <div class="bar">
    <div class="left">
      <h1>Buzzword IA DevOps</h1>
      {#if user && !user.must_change}
        <nav>
          <button type="button" class="nav-item {page === 'dashboard' ? 'active' : ''}" onclick={() => onNavigate('dashboard')}>Panel</button>
          {#if isSuper}
            <button type="button" class="nav-item {page === 'users' ? 'active' : ''}" onclick={() => onNavigate('users')}>Usuarios</button>
          {/if}
        </nav>
      {/if}
    </div>
    {#if user}
      <div class="right">
        <div class="who">
          <p class="who-name">{user.username}</p>
          <p class="who-role">{isSuper ? 'Superadministrador' : 'Usuario'}</p>
        </div>
        <div class="divider"></div>
        <button type="button" class="btn-out" onclick={onLogout}>Salir</button>
      </div>
    {/if}
  </div>
</header>

<style>
  .site-header {
    position: sticky;
    top: 0;
    z-index: 40;
    background: var(--card);
    border-bottom: 1px solid var(--border);
  }

  .bar {
    max-width: 90rem;
    margin: 0 auto;
    height: 64px;
    padding: 0 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
  }

  .left,
  .right {
    display: flex;
    align-items: center;
    gap: 24px;
  }

  .right {
    gap: 12px;
  }

  h1 {
    font-size: 1.75rem;
    font-weight: 700;
    letter-spacing: -0.3px;
    color: var(--foreground);
    margin: 0;
    white-space: nowrap;
  }

  nav {
    display: flex;
    gap: 8px;
  }

  .nav-item {
    padding: 10px 12px;
    border: 0;
    border-radius: var(--radius);
    background: none;
    color: var(--foreground);
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }

  .nav-item:hover {
    background: var(--muted);
  }

  .nav-item.active {
    background: var(--primary);
    color: var(--primary-foreground);
  }

  .who-name {
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--foreground);
  }

  .who-role {
    font-size: 0.75rem;
    color: var(--muted-foreground);
  }

  .divider {
    width: 1px;
    height: 24px;
    background: var(--border);
  }

  .btn-out {
    padding: 6px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--card);
    color: var(--foreground);
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
  }

  .btn-out:hover {
    background: var(--muted);
  }
</style>
