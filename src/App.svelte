<script>
  const WEBHOOK_BASE = 'http://172.10.30.15:8090';
  const APPS_URL = 'http://172.10.30.15:4174/apps.json';
  const DEPLOYS_URL = 'http://172.10.30.15:4174/logs/deploys.jsonl';
  const LOGS_BASE = 'http://172.10.30.15:4174/logs';
  const PM2_STATUS_URL = WEBHOOK_BASE + '/hooks/pm2-status';
  const POLL_INTERVAL_MS = 4000;
  const FINISHED_TTL_MS = 10 * 60 * 1000;

  const PROJECT_BY_APP = {
    'mide-chatbot': 'Mide',
    'svelte_mide': 'Mide',
    'notificaciones_twilio': 'Mide',
    'sandbox_mensajes': 'Mide',
    'document_ai': 'Art',
    'conmutador': 'Art',
    'webhook-central-ui': 'DevOps',
    'webhook-central': 'DevOps',
    'constructor-agente-rag': 'Buzzword Agentes',
    'buzzword-agentes-ui': 'Buzzword Agentes',
    'host-asistentes': 'Buzzword Agentes',
    'nexus_back': 'Nexus IA',
    'nexus_poc_svelte': 'Nexus IA',
    'infra-timelapse': 'Prototipo',
    'shape_up': 'Prototipo',
  };

  let projects = $state([]);
  let loading = $state(true);
  let error = $state(null);
  let hookStates = $state({}); // estado local transitorio entre el click y la próxima lectura del backend
  let preClickIds = $state({}); // rec.id que estaba en backendDeploys al hacer click; cualquier id distinto = deploy nuevo

  let backendDeploys = $state({}); // app -> último registro leído de deploys.jsonl
  let pollOk = $state(false); // false hasta el primer poll exitoso
  let pm2Status = $state({}); // pm2_name -> status ('online', 'stopped', 'errored', ...)

  let detailDeploy = $state(null);
  let detailLogContent = $state('');
  let detailLogLoading = $state(false);

  let sortKey = $state('project');
  let sortDir = $state('asc');

  let activeEnv = $state('dev');

  function setSort(key) {
    if (sortKey === key) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sortKey = key;
      sortDir = 'asc';
    }
  }

  function sortValue(project, key) {
    switch (key) {
      case 'name': return (project.name ?? '').toLowerCase();
      case 'project': return (PROJECT_BY_APP[project.id] ?? '￿').toLowerCase();
      case 'stack': return project.stack ?? '';
      case 'branch': return project.branch ?? '';
      case 'type': return project.stack === 'python' ? 'api' : 'webapp';
      case 'port': {
        const p = appPort(project);
        return p ? parseInt(p, 10) : -1;
      }
      case 'webhook': return project.deploy_url ?? '';
      case 'status': return effectiveStatus(project.id).kind;
      case 'live': return liveStatus(project) === 'online' ? 0 : 1;
      default: return '';
    }
  }

  const sortedProjects = $derived.by(() => {
    if (!sortKey) return projects;
    const arr = [...projects];
    arr.sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      // Tiebreaker: ordenar por nombre de app dentro del mismo grupo
      const an = (a.name ?? '').toLowerCase();
      const bn = (b.name ?? '').toLowerCase();
      if (an < bn) return -1;
      if (an > bn) return 1;
      return 0;
    });
    return arr;
  });

  async function loadProjects() {
    try {
      const res = await fetch(APPS_URL);
      projects = await res.json();
    } catch (e) {
      error = 'No se pudo cargar la lista de proyectos';
    } finally {
      loading = false;
    }
  }

  async function refreshDeploys() {
    try {
      const res = await fetch(DEPLOYS_URL, { cache: 'no-store' });
      if (!res.ok) return; // 404 mientras no haya logs/deploys.jsonl todavía
      const text = await res.text();
      const next = {};
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const rec = JSON.parse(t);
          // El último evento por app gana (jsonl es append-only en orden cronológico)
          next[rec.app] = rec;
        } catch (_) {
          // línea malformada, ignorar
        }
      }
      backendDeploys = next;
      pollOk = true;
    } catch (_) {
      // red caída, etc. — silencioso
    }
  }

  async function refreshPm2Status() {
    try {
      const res = await fetch(PM2_STATUS_URL, { cache: 'no-store' });
      if (!res.ok) return;
      pm2Status = await res.json();
    } catch (_) {
      // red caída, etc. — se mantiene el último estado conocido
    }
  }

  function liveStatus(project) {
    if (!project.pm2_name) return 'unknown';
    return pm2Status[project.pm2_name] ?? 'unknown';
  }

  loadProjects();

  $effect(() => {
    refreshDeploys();
    const id = setInterval(refreshDeploys, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  });

  $effect(() => {
    refreshPm2Status();
    const id = setInterval(refreshPm2Status, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  });

  function webhookUrl(project) {
    return WEBHOOK_BASE + project.deploy_url;
  }

  function appHref(project) {
    if (!project.app_url) return null;
    return project.stack === 'python' ? project.app_url + '/docs' : project.app_url;
  }

  function repoLabel(url) {
    return url.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
  }

  function publicHref(project) {
    if (!project.public_url) return null;
    return project.stack === 'python' ? project.public_url + '/docs' : project.public_url;
  }

  function appPort(project) {
    if (!project.app_url) return null;
    try {
      const port = new URL(project.app_url).port;
      return port || null;
    } catch (_) {
      return null;
    }
  }

  function effectiveStatus(projectId) {
    const local = hookStates[projectId];
    const rec = backendDeploys[projectId];
    const preId = preClickIds[projectId];

    // Mostrar 'loading' local hasta que el backend reporte un rec.id distinto al que había antes del click.
    if (local === 'loading') {
      if (!rec || rec.id === preId) {
        return { kind: 'loading', rec: null };
      }
    }

    if (!rec) {
      if (local === 'error') return { kind: 'error', rec: null };
      return { kind: 'idle', rec: null };
    }

    if (rec.event === 'started') return { kind: 'running', rec };
    if (rec.event === 'finished') {
      const endedMs = rec.ended_at ? new Date(rec.ended_at).getTime() : null;
      if (endedMs && Date.now() - endedMs > FINISHED_TTL_MS) {
        return { kind: 'idle', rec: null };
      }
      return { kind: rec.status, rec }; // 'success' | 'failed' | 'no_changes'
    }
    return { kind: 'idle', rec };
  }

  function fmtDuration(s) {
    if (s == null) return '';
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const ss = s % 60;
    return `${m}m ${ss}s`;
  }

  function fmtDurationVerbose(s) {
    if (s == null) return '';
    if (s < 60) return `${s} segundo${s === 1 ? '' : 's'}`;
    const m = Math.floor(s / 60);
    const ss = s % 60;
    const mPart = `${m} minuto${m === 1 ? '' : 's'}`;
    const sPart = ss === 0 ? '' : ` ${ss} segundo${ss === 1 ? '' : 's'}`;
    return mPart + sPart;
  }

  function fmtTime(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  async function triggerWebhook(event, project) {
    event.preventDefault();

    const cur = effectiveStatus(project.id).kind;
    if (cur === 'loading' || cur === 'running') return;

    preClickIds[project.id] = backendDeploys[project.id]?.id ?? null;
    hookStates[project.id] = 'loading';
    try {
      await fetch(webhookUrl(project), { mode: 'no-cors' });
    } catch (_) {
      hookStates[project.id] = 'error';
    }
    // El estado final lo marca el polling de deploys.jsonl
  }

  function openDetail(rec) {
    detailDeploy = rec;
    detailLogContent = '';
    detailLogLoading = false;
  }

  function closeDetail() {
    detailDeploy = null;
    detailLogContent = '';
    detailLogLoading = false;
  }

  async function loadFullLog() {
    if (!detailDeploy || !detailDeploy.log_file) return;
    detailLogLoading = true;
    try {
      const res = await fetch(`${LOGS_BASE}/${detailDeploy.log_file}`, { cache: 'no-store' });
      if (!res.ok) {
        detailLogContent = `(no se pudo cargar el log: HTTP ${res.status})`;
      } else {
        detailLogContent = await res.text();
      }
    } catch (e) {
      detailLogContent = '(error de red al cargar el log)';
    } finally {
      detailLogLoading = false;
    }
  }
</script>

<div class="app">
  <div class="container">
    <header>
      <h1>Buzzword IA DevOps</h1>
      <p>Panel de despliegue de servicios{pollOk ? '' : ' · sin telemetría aún'}</p>
    </header>

    <div class="panel">
      <div class="env-tabs">
        <button
          type="button"
          class="env-tab {activeEnv === 'dev' ? 'active' : ''}"
          onclick={() => activeEnv = 'dev'}
        >
          Dev
        </button>
        <button
          type="button"
          class="env-tab {activeEnv === 'prod' ? 'active' : ''}"
          onclick={() => activeEnv = 'prod'}
        >
          Prod
        </button>
      </div>

      <div class="card">
      {#if activeEnv === 'prod'}
        <p class="placeholder-msg">Próximamente</p>
      {:else if loading}
        <p class="loading-msg"><span class="spinner"></span> Cargando proyectos...</p>
      {:else if error}
        <p class="error-msg">{error}</p>
      {:else}
        <table>
          <thead>
            <tr>
              <th class="sortable" onclick={() => setSort('name')}>
                Aplicación<span class="sort-arrow {sortKey === 'name' ? 'active' : ''}">{sortKey === 'name' ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}</span>
              </th>
              <th class="folder-col">Origen</th>
              <th class="sortable" onclick={() => setSort('project')}>
                Proyecto<span class="sort-arrow {sortKey === 'project' ? 'active' : ''}">{sortKey === 'project' ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}</span>
              </th>
              <th class="sortable" onclick={() => setSort('stack')}>
                Stack<span class="sort-arrow {sortKey === 'stack' ? 'active' : ''}">{sortKey === 'stack' ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}</span>
              </th>
              <th class="sortable" onclick={() => setSort('branch')}>
                Branch<span class="sort-arrow {sortKey === 'branch' ? 'active' : ''}">{sortKey === 'branch' ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}</span>
              </th>
              <th class="app-col">DOM</th>
              <th class="sortable" onclick={() => setSort('type')}>
                Tipo de App<span class="sort-arrow {sortKey === 'type' ? 'active' : ''}">{sortKey === 'type' ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}</span>
              </th>
              <th class="sortable" onclick={() => setSort('port')}>
                Puerto<span class="sort-arrow {sortKey === 'port' ? 'active' : ''}">{sortKey === 'port' ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}</span>
              </th>
              <th class="sortable webhook-col" onclick={() => setSort('webhook')}>
                DEPLOY<span class="sort-arrow {sortKey === 'webhook' ? 'active' : ''}">{sortKey === 'webhook' ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}</span>
              </th>
              <th class="sortable" onclick={() => setSort('status')}>
                Estado<span class="sort-arrow {sortKey === 'status' ? 'active' : ''}">{sortKey === 'status' ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}</span>
              </th>
              <th class="sortable live-col" onclick={() => setSort('live')}>
                Live<span class="sort-arrow {sortKey === 'live' ? 'active' : ''}">{sortKey === 'live' ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {#each sortedProjects as project}
              {@const st = effectiveStatus(project.id)}
              {@const live = liveStatus(project)}
              <tr>
                <td class="project-name">{project.name}</td>
                <td class="folder-cell">
                  <span
                    class="folder-icon"
                    title="Carpeta: {project.id}"
                    aria-label="Carpeta del proyecto: {project.id}"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                    </svg>
                  </span>
                  {#if project.repo_url}
                    <a
                      class="repo-icon"
                      href={project.repo_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Repositorio: {repoLabel(project.repo_url)}"
                      aria-label="Abrir repositorio {repoLabel(project.repo_url)} en GitHub"
                    >
                      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/>
                      </svg>
                    </a>
                  {/if}
                </td>
                <td class="project-group">
                  {#if PROJECT_BY_APP[project.id]}
                    {PROJECT_BY_APP[project.id]}
                  {:else}
                    <span class="muted">—</span>
                  {/if}
                </td>
                <td>
                  <span class="badge {project.stack === 'svelte' ? 'badge-svelte' : project.stack === 'python' ? 'badge-python' : 'badge-config'}">
                    {project.stack === 'none' ? 'config' : project.stack}
                  </span>
                </td>
                <td class="branch">{project.branch}</td>
                <td class="app-cell">
                  {#if project.public_url}
                    <a
                      href={publicHref(project)}
                      class="public-link"
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Dominio público: {publicHref(project)}"
                      aria-label="Abrir dominio público de {project.name}"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                        <line x1="8" y1="13" x2="16" y2="13"/>
                        <line x1="8" y1="17" x2="16" y2="17"/>
                        <line x1="8" y1="9" x2="10" y2="9"/>
                      </svg>
                    </a>
                  {:else}
                    <span class="muted">—</span>
                  {/if}
                </td>
                <td class="app-chip-cell">
                  {#if project.app_url}
                    <a
                      href={appHref(project)}
                      class="app-link"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {project.stack === 'python' ? 'API ↗' : 'Webapp ↗'}
                    </a>
                  {:else}
                    <span class="muted">—</span>
                  {/if}
                </td>
                <td class="port-cell">
                  {#if appPort(project)}
                    <span class="port">{appPort(project)}</span>
                  {:else}
                    <span class="muted">—</span>
                  {/if}
                </td>
                <td class="webhook-cell">
                  <button
                    type="button"
                    class="deploy-btn"
                    onclick={(e) => triggerWebhook(e, project)}
                    disabled={st.kind === 'loading' || st.kind === 'running'}
                    aria-label="Desplegar {project.name}: {webhookUrl(project)}"
                    title={webhookUrl(project)}
                  >
                    🚀
                  </button>
                </td>
                <td class="status-cell">
                  {#if st.kind === 'loading'}
                    <span class="status loading">
                      <span class="spinner"></span> Disparado...
                    </span>
                  {:else if st.kind === 'running'}
                    <span class="status loading" title="Iniciado: {fmtTime(st.rec?.started_at)}">
                      <span class="spinner"></span> Desplegando...
                    </span>
                  {:else if st.kind === 'success'}
                    <span class="status success" title={st.rec ? `Tomó ${fmtDurationVerbose(st.rec.duration_s)} · ${fmtTime(st.rec.ended_at)}` : ''}>
                      ✓ Desplegado
                    </span>
                  {:else if st.kind === 'no_changes'}
                    <span class="status no-changes" title={st.rec ? `Verificado: ${fmtTime(st.rec.ended_at)}` : ''}>
                      = Sin cambios
                    </span>
                  {:else if st.kind === 'failed'}
                    <button
                      type="button"
                      class="status error status-clickable"
                      onclick={() => openDetail(st.rec)}
                      title="Ver detalle del fallo"
                    >
                      ✗ Falló{st.rec?.failed_step ? ` en ${st.rec.failed_step}` : ''}
                    </button>
                  {:else if st.kind === 'error'}
                    <span class="status error">✗ Error de red</span>
                  {:else}
                    <span class="status idle">— Listo</span>
                  {/if}
                </td>
                <td class="live-cell">
                  <span
                    class="live-dot live-{live}"
                    title="pm2 · {project.pm2_name}: {live}"
                    aria-label="Estado en vivo de {project.name}: {live}"
                  ></span>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
      </div>
    </div>

    <footer>
      <p>Flujo: <span class="flow">git pull → dependencias → pm2 restart</span></p>
    </footer>
  </div>

  {#if detailDeploy}
    <div
      class="modal-backdrop"
      onclick={closeDetail}
      onkeydown={(e) => { if (e.key === 'Escape') closeDetail(); }}
      role="presentation"
    >
      <div
        class="modal"
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Detalle del deploy"
        tabindex="-1"
      >
        <header class="modal-header">
          <h3>{detailDeploy.app} · <span class="status-tag {detailDeploy.status}">{detailDeploy.status}</span></h3>
          <button type="button" class="modal-close" onclick={closeDetail} aria-label="Cerrar">✕</button>
        </header>
        <div class="modal-meta">
          <div><strong>Paso fallido:</strong> {detailDeploy.failed_step || '—'}</div>
          <div><strong>Duración:</strong> {fmtDuration(detailDeploy.duration_s)}</div>
          <div><strong>Inicio:</strong> {fmtTime(detailDeploy.started_at)}</div>
          <div><strong>Fin:</strong> {fmtTime(detailDeploy.ended_at)}</div>
          <div><strong>Branch:</strong> {detailDeploy.branch || '—'}</div>
          <div><strong>Stack:</strong> {detailDeploy.stack || '—'}</div>
        </div>
        <h4>Error (últimas líneas)</h4>
        <pre class="error-tail">{detailDeploy.error_tail || '(sin output)'}</pre>
        <div class="modal-actions">
          {#if !detailLogContent && !detailLogLoading}
            <button type="button" class="btn-load-log" onclick={loadFullLog}>
              Ver log completo
            </button>
          {/if}
        </div>
        {#if detailLogLoading}
          <p class="loading-msg"><span class="spinner"></span> Cargando log...</p>
        {:else if detailLogContent}
          <h4>Log completo</h4>
          <pre class="full-log">{detailLogContent}</pre>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  :global(*, *::before, *::after) {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  :global(html, body) {
    width: 100%;
    height: 100%;
    font-family: 'Segoe UI', system-ui, sans-serif;
  }

  .app {
    width: 100%;
    min-height: 100vh;
    padding: 48px 0;
  }

  .container {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 32px;
  }

  header {
    text-align: left;
    padding: 0 40px;
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }

  h1 {
    font-size: 1.8rem;
    font-weight: 700;
    color: #1a3a5c;
    letter-spacing: -0.5px;
    margin: 0;
  }

  header p {
    color: #5a7a9a;
    margin: 0;
    margin-left: 12px;
    flex-basis: 100%;
    font-size: 1rem;
  }

  .loading-msg, .error-msg {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 24px 20px;
    font-size: 0.9rem;
  }

  .loading-msg {
    color: #2563eb;
  }

  .error-msg {
    color: #b91c1c;
  }

  .branch {
    font-family: 'Consolas', 'Courier New', monospace;
    font-size: 0.82rem;
    color: #6b7280;
  }

  .panel {
    display: flex;
    flex-direction: column;
  }

  .env-tabs {
    display: flex;
    gap: 4px;
    padding: 0 40px 0 16px;
  }

  .env-tab {
    padding: 8px 20px;
    border: 1px solid #e2e8f0;
    border-bottom: none;
    background: #f1f5f9;
    color: #64748b;
    font-size: 0.85rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    border-radius: 8px 8px 0 0;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }

  .env-tab:hover {
    background: #e2e8f0;
    color: #334155;
  }

  .env-tab.active {
    background: #2563eb;
    color: #fff;
    border-color: #2563eb;
  }

  .card {
    overflow: hidden;
  }

  .placeholder-msg {
    padding: 40px 20px;
    color: #94a3b8;
    font-size: 0.9rem;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    border: none;
  }

  thead tr {
    background: linear-gradient(90deg, #2563eb, #38bdf8);
  }

  th {
    padding: 14px 20px;
    text-align: left;
    font-size: 0.78rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    color: #ffffff;
    text-transform: uppercase;
    border: none;
  }

  th.sortable {
    cursor: pointer;
    user-select: none;
    transition: background 0.15s;
  }

  th.sortable:hover {
    background: rgba(255, 255, 255, 0.1);
  }

  .sort-arrow {
    margin-left: 6px;
    font-size: 0.7rem;
    opacity: 0.45;
  }

  .sort-arrow.active {
    opacity: 1;
  }

  tbody tr {
    transition: background 0.15s;
  }

  tbody tr:hover {
    background: rgba(37, 99, 235, 0.04);
  }

  td {
    padding: 16px 20px;
    vertical-align: middle;
    color: #334155;
    font-size: 0.9rem;
    border: none;
    text-align: left;
  }

  .project-name {
    font-family: 'Consolas', 'Courier New', monospace;
    font-weight: 600;
    color: #1e3a5f;
    font-size: 0.88rem;
    text-align: left;
  }

  .project-group {
    font-weight: 500;
    color: #475569;
    font-size: 0.88rem;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 70px;
    height: 28px;
    padding: 0 10px;
    border-radius: 20px;
    font-size: 0.76rem;
    font-weight: 600;
    letter-spacing: 0.03em;
    white-space: nowrap;
  }

  .badge-python {
    background: #dcfce7;
    color: #166534;
    border: 1px solid #86efac;
  }

  .badge-svelte {
    background: #ffedd5;
    color: #1e40af;
    border: 1px solid #fed7aa;
  }

  .badge-config {
    background: #e2e8f0;
    color: #475569;
    border: 1px solid #cbd5e1;
  }

  .folder-col {
    text-align: center;
  }

  .app-col {
    text-align: center;
  }

  .folder-cell {
    white-space: nowrap;
    text-align: center;
    width: 1%;
  }

  .folder-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    color: #d97706;
    border: 1px solid #fde68a;
    background: #fffbeb;
    border-radius: 6px;
    cursor: help;
    transition: background 0.15s, color 0.15s, border-color 0.15s, transform 0.1s;
  }

  .folder-icon svg {
    width: 16px;
    height: 16px;
  }

  .folder-icon:hover {
    background: #fef3c7;
    color: #b45309;
    border-color: #fcd34d;
    transform: scale(1.05);
  }

  .repo-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    margin-left: 6px;
    color: #24292f;
    border: 1px solid #d0d7de;
    background: #f6f8fa;
    border-radius: 6px;
    transition: background 0.15s, color 0.15s, border-color 0.15s, transform 0.1s;
  }

  .repo-icon svg {
    width: 16px;
    height: 16px;
  }

  .repo-icon:hover {
    background: #eaeef2;
    color: #0969da;
    border-color: #afb8c1;
    transform: scale(1.05);
  }

  .app-cell {
    white-space: nowrap;
    text-align: center;
    width: 1%;
  }

  .app-chip-cell {
    white-space: nowrap;
  }

  .public-link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    color: #7c3aed;
    border: 1px solid #ddd6fe;
    background: #f5f3ff;
    border-radius: 6px;
    text-decoration: none;
    transition: background 0.15s, color 0.15s, border-color 0.15s, transform 0.1s;
  }

  .public-link svg {
    width: 16px;
    height: 16px;
  }

  .public-link:hover {
    background: #ede9fe;
    color: #6d28d9;
    border-color: #c4b5fd;
    transform: scale(1.05);
  }

  .app-link {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 0.82rem;
    font-weight: 500;
    color: #0d9488;
    text-decoration: none;
    padding: 4px 12px;
    border: 1px solid #5eead4;
    border-radius: 20px;
    background: #f0fdfa;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }

  .app-link:hover {
    background: #ccfbf1;
    color: #0f766e;
    border-color: #2dd4bf;
  }

  .muted {
    color: #cbd5e1;
    font-size: 0.9rem;
  }

  .port-cell {
    white-space: nowrap;
  }

  .port {
    font-family: 'Consolas', 'Courier New', monospace;
    font-size: 0.82rem;
    color: #475569;
    background: #f1f5f9;
    padding: 3px 10px;
    border-radius: 6px;
    border: 1px solid #e2e8f0;
  }

  .webhook-col {
    text-align: center;
  }

  .webhook-cell {
    white-space: nowrap;
    text-align: center;
    width: 1%;
  }

  .deploy-btn {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border: 1px solid #93c5fd;
    background: #eff6ff;
    border-radius: 8px;
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
    transition: background 0.15s, border-color 0.15s, transform 0.1s;
  }

  .deploy-btn:hover:not(:disabled) {
    background: #dbeafe;
    border-color: #2563eb;
    transform: scale(1.05);
  }

  .deploy-btn:active:not(:disabled) {
    transform: scale(0.95);
  }

  .deploy-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .status-cell {
    white-space: nowrap;
    min-width: 130px;
  }

  .live-col {
    text-align: center;
  }

  .live-cell {
    text-align: center;
    white-space: nowrap;
    width: 1%;
  }

  .live-dot {
    display: inline-block;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #cbd5e1;
    box-shadow: 0 0 0 3px rgba(203, 213, 225, 0.25);
  }

  .live-dot.live-online {
    background: #22c55e;
    box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.25);
    animation: pulse-live 2s ease-in-out infinite;
  }

  .live-dot.live-stopped,
  .live-dot.live-errored,
  .live-dot.live-stopping {
    background: #ef4444;
    box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.25);
  }

  @keyframes pulse-live {
    0%, 100% { box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.25); }
    50% { box-shadow: 0 0 0 5px rgba(34, 197, 94, 0.12); }
  }

  .status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 0.82rem;
    font-weight: 500;
    padding: 4px 10px;
    border-radius: 20px;
  }

  .status.idle {
    color: #94a3b8;
  }

  .status.loading {
    color: #2563eb;
    background: #eff6ff;
    border: 1px solid #bfdbfe;
  }

  .status.success {
    color: #15803d;
    background: #f0fdf4;
    border: 1px solid #bbf7d0;
  }

  .status.no-changes {
    color: #64748b;
    background: #f1f5f9;
    border: 1px solid #cbd5e1;
  }

  .status.error {
    color: #b91c1c;
    background: #fef2f2;
    border: 1px solid #fecaca;
  }

  .status-clickable {
    cursor: pointer;
    font-family: inherit;
  }

  .status-clickable:hover {
    background: #fee2e2;
  }

  .spinner {
    width: 13px;
    height: 13px;
    border: 2px solid #bfdbfe;
    border-top-color: #2563eb;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    flex-shrink: 0;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  footer {
    text-align: center;
    padding: 0 40px;
    color: #64748b;
    font-size: 0.85rem;
  }

  .flow {
    font-family: 'Consolas', 'Courier New', monospace;
    background: rgba(37, 99, 235, 0.08);
    padding: 2px 8px;
    border-radius: 4px;
    color: #1e40af;
  }

  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(15, 23, 42, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 24px;
  }

  .modal {
    background: #fff;
    border-radius: 10px;
    max-width: 900px;
    width: 100%;
    max-height: 90vh;
    overflow-y: auto;
    padding: 20px 24px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
    border-bottom: 1px solid #e2e8f0;
    padding: 0 0 12px 0;
    background: transparent;
  }

  .modal-header h3 {
    margin: 0;
    font-size: 1.05rem;
    color: #1a3a5c;
    font-family: 'Consolas', 'Courier New', monospace;
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .status-tag {
    font-size: 0.7rem;
    padding: 2px 8px;
    border-radius: 12px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-family: inherit;
  }

  .status-tag.success {
    background: #f0fdf4;
    color: #15803d;
    border: 1px solid #bbf7d0;
  }

  .status-tag.failed {
    background: #fef2f2;
    color: #b91c1c;
    border: 1px solid #fecaca;
  }

  .modal-close {
    background: transparent;
    border: none;
    font-size: 1.2rem;
    cursor: pointer;
    color: #64748b;
    line-height: 1;
    padding: 4px 8px;
    border-radius: 4px;
  }

  .modal-close:hover {
    background: #f1f5f9;
  }

  .modal-meta {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 8px 16px;
    font-size: 0.85rem;
    color: #475569;
    margin-bottom: 16px;
  }

  .modal h4 {
    margin: 16px 0 8px;
    font-size: 0.78rem;
    color: #475569;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
  }

  .error-tail, .full-log {
    background: #0f172a;
    color: #e2e8f0;
    padding: 12px 16px;
    border-radius: 6px;
    font-family: 'Consolas', 'Courier New', monospace;
    font-size: 0.78rem;
    line-height: 1.45;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .full-log {
    max-height: 400px;
    overflow-y: auto;
  }

  .modal-actions {
    margin: 16px 0 8px;
  }

  .btn-load-log {
    background: #2563eb;
    color: #fff;
    border: none;
    padding: 8px 16px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.85rem;
    font-weight: 500;
  }

  .btn-load-log:hover {
    background: #1d4ed8;
  }
</style>
