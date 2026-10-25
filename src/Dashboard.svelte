<script>

  let { user, onLogout } = $props();

  const WEBHOOK_BASE = 'http://172.10.30.15:8090';
  const APPS_URL = '/api/apps';
  const DEPLOYS_URL = '/api/deploys';
  const LOGS_BASE = '/api/logs';
  const ENV_LABELS = { dev: 'Dev', staging: 'Staging', prod: 'Prod' };
  const PM2_STATUS_URL = WEBHOOK_BASE + '/hooks/pm2-status';
  const POWER_URL = WEBHOOK_BASE + '/hooks/power';
  const POWER_TOKEN = import.meta.env.VITE_POWER_TOKEN ?? '';
  // Apps que no se apagan desde aquí (el botón vive en ellas); mismo filtro en power.sh
  const POWER_PROTECTED = ['webhook-listener', 'webhook-central-ui'];
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
    'nexus_back_dev': 'Nexus IA',
    'nexus_poc_svelte_dev': 'Nexus IA',
    'nexus_monitor': 'Nexus IA',
    'infra-timelapse': 'Prototipo',
    'shape_up': 'Prototipo',
    'shape_up_dev': 'Prototipo',
  };

  let projects = $state([]);
  let loading = $state(true);
  let error = $state(null);
  let hookStates = $state({}); // estado local transitorio entre el click y la próxima lectura del backend
  let preClickIds = $state({}); // rec.id que estaba en backendDeploys al hacer click; cualquier id distinto = deploy nuevo
  let mergeStates = $state({}); // project.id -> {kind: 'loading'|'success'|'no_changes'|'error', message?, prUrl?, prNumber?}

  let backendDeploys = $state({}); // app -> último registro leído de deploys.jsonl
  let pollOk = $state(false); // false hasta el primer poll exitoso
  let pm2Status = $state({}); // pm2_name -> status ('online', 'stopped', 'errored', ...)

  let powerTarget = $state(null); // { project, action: 'stop'|'start' }
  let powerTyped = $state('');
  let powerBusy = $state(false);
  let powerError = $state('');

  let detailDeploy = $state(null);
  let detailLogContent = $state('');
  let detailLogLoading = $state(false);

  let sortKey = $state('project');
  let sortDir = $state('asc');

  const isSuper = user.role === 'superadmin';
  let activeEnv = $state(user.tabs[0] ?? 'dev');

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
      case 'owner': return (project.owner ?? '￿').toLowerCase();
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

  const envProjects = $derived.by(() => {
    return projects.filter((p) =>
      activeEnv === 'dev' ? p.env !== 'staging' && p.env !== 'prod' : p.env === activeEnv
    );
  });

  const sortedProjects = $derived.by(() => {
    if (!sortKey) return envProjects;
    const arr = [...envProjects];
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
      if (res.status === 401) return onLogout(false);
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
      if (res.status === 401) return onLogout(false);
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

  function canPower(project) {
    return isSuper && !!project.pm2_name && !!POWER_TOKEN && !POWER_PROTECTED.includes(project.pm2_name);
  }

  // En dev basta un clic de confirmación; en prod (o sin env) hay que escribir el id
  function powerNeedsTyping(project) {
    return project.env !== 'dev';
  }

  function openPower(project) {
    powerTarget = { project, action: liveStatus(project) === 'online' ? 'stop' : 'start' };
    powerTyped = '';
    powerError = '';
  }

  function closePower() {
    if (powerBusy) return;
    powerTarget = null;
  }

  async function confirmPower() {
    if (!powerTarget || powerBusy) return;
    const { project, action } = powerTarget;
    if (powerNeedsTyping(project) && powerTyped !== project.id) return;

    powerBusy = true;
    powerError = '';
    try {
      const qs = new URLSearchParams({ action, id: project.id, token: POWER_TOKEN });
      const res = await fetch(`${POWER_URL}?${qs}`, { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (data?.ok) {
        powerTarget = null;
        await refreshPm2Status();
      } else {
        powerError = data?.error ?? `HTTP ${res.status}`;
      }
    } catch (_) {
      powerError = 'Error de red';
    }
    powerBusy = false;
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
    return project.stack === 'python' ? project.public_url + (project.docs_path || '/docs') : project.public_url;
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

  async function triggerMerge(event, project) {
    event.preventDefault();
    if (!project.merge_url) return;
    if (mergeStates[project.id]?.kind === 'loading') return;

    mergeStates[project.id] = { kind: 'loading' };
    try {
      const res = await fetch(WEBHOOK_BASE + project.merge_url, { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (data?.ok && data?.no_changes) {
        mergeStates[project.id] = { kind: 'no_changes', message: data.message };
      } else if (data?.ok && data?.merged) {
        mergeStates[project.id] = { kind: 'success', prUrl: data.pr_url, prNumber: data.pr_number };
      } else {
        mergeStates[project.id] = {
          kind: 'error',
          message: data?.error ?? `HTTP ${res.status}`,
          prUrl: data?.pr_url,
        };
      }
    } catch (e) {
      mergeStates[project.id] = { kind: 'error', message: 'Error de red' };
    }
    setTimeout(() => {
      if (mergeStates[project.id]?.kind !== 'loading') delete mergeStates[project.id];
    }, 8000);
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

    {#if user.tabs.length === 0}
      <p class="placeholder-msg">Tu usuario aún no tiene pestañas asignadas. Pídele acceso al superadmin.</p>
    {:else}

    <div class="panel env-{activeEnv}">
      <div class="env-tabs">
        {#each user.tabs as env (env)}
          <button
            type="button"
            class="env-tab env-{env} {activeEnv === env ? 'active' : ''}"
            onclick={() => activeEnv = env}
          >
            {ENV_LABELS[env]}
          </button>
        {/each}
      </div>

      <div class="card">
      {#if loading}
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
              <th class="sortable" onclick={() => setSort('owner')}>
                Owner<span class="sort-arrow {sortKey === 'owner' ? 'active' : ''}">{sortKey === 'owner' ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}</span>
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
                <td class="owner-cell">
                  {#if project.owner}
                    {project.owner}
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
                  <div class="webhook-btn-group">
                    {#if project.merge_url}
                      {@const ms = mergeStates[project.id]}
                      <button
                        type="button"
                        class="merge-btn {ms?.kind ?? ''}"
                        onclick={(e) => triggerMerge(e, project)}
                        disabled={ms?.kind === 'loading'}
                        aria-label="Promover {project.name} a {project.branch}"
                        title={ms?.kind === 'success' ? `Mergeado: PR #${ms.prNumber}` : ms?.kind === 'no_changes' ? ms.message : ms?.kind === 'error' ? ms.message : `Promover a ${project.branch}`}
                      >
                        {#if ms?.kind === 'loading'}
                          <span class="spinner"></span>
                        {:else if ms?.kind === 'success'}
                          ✓
                        {:else if ms?.kind === 'no_changes'}
                          =
                        {:else if ms?.kind === 'error'}
                          ✗
                        {:else}
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <circle cx="18" cy="18" r="3"/>
                            <circle cx="6" cy="6" r="3"/>
                            <path d="M6 21V9a9 9 0 0 0 9 9"/>
                          </svg>
                        {/if}
                      </button>
                    {/if}
                    {#if project.deploy_url}
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
                    {/if}
                  </div>
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
                  {#if canPower(project)}
                    <button
                      type="button"
                      class="live-dot live-btn live-{live}"
                      onclick={() => openPower(project)}
                      title="pm2 · {project.pm2_name}: {live} — clic para {live === 'online' ? 'apagar' : 'encender'}"
                      aria-label="Estado en vivo de {project.name}: {live}. Clic para {live === 'online' ? 'apagar' : 'encender'}"
                    ></button>
                  {:else}
                    <span
                      class="live-dot live-{live}"
                      title="pm2 · {project.pm2_name}: {live}"
                      aria-label="Estado en vivo de {project.name}: {live}"
                    ></span>
                  {/if}
                </td>
              </tr>
            {:else}
              <tr class="empty-row">
                <td colspan="12" class="placeholder-msg">
                  {activeEnv === 'staging' ? 'Aún no hay proyectos en Staging' : activeEnv === 'prod' ? 'Aún no hay proyectos en producción' : 'No hay proyectos'}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
      </div>
    </div>

    {/if}

    <footer>
      <p>Flujo: <span class="flow">git pull → dependencias → pm2 restart</span></p>
    </footer>
  </div>

  {#if powerTarget}
    {@const pp = powerTarget.project}
    {@const stopping = powerTarget.action === 'stop'}
    <div
      class="modal-backdrop"
      onclick={closePower}
      onkeydown={(e) => { if (e.key === 'Escape') closePower(); }}
      role="presentation"
    >
      <div
        class="modal power-modal"
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={stopping ? 'Apagar app' : 'Encender app'}
        tabindex="-1"
      >
        <header class="modal-header">
          <h3>{stopping ? 'Apagar' : 'Encender'} {pp.name}</h3>
          <button type="button" class="modal-close" onclick={closePower} aria-label="Cerrar">✕</button>
        </header>
        <p class="power-text">
          {#if stopping}
            Se detendrá el proceso <strong>{pp.pm2_name}</strong> en pm2 y la app dejará de responder hasta que la vuelvas a encender.
          {:else}
            Se iniciará el proceso <strong>{pp.pm2_name}</strong> en pm2.
          {/if}
        </p>
        {#if powerNeedsTyping(pp)}
          <label class="power-label" for="power-confirm">
            Escribe <code>{pp.id}</code> para confirmar:
          </label>
          <input
            id="power-confirm"
            class="power-input"
            type="text"
            autocomplete="off"
            bind:value={powerTyped}
            onkeydown={(e) => { if (e.key === 'Enter') confirmPower(); }}
          />
        {/if}
        {#if powerError}
          <p class="power-error">✗ {powerError}</p>
        {/if}
        <div class="power-actions">
          <button type="button" class="btn-power-cancel" onclick={closePower} disabled={powerBusy}>Cancelar</button>
          <button
            type="button"
            class="btn-power-confirm"
            onclick={confirmPower}
            disabled={powerBusy || (powerNeedsTyping(pp) && powerTyped !== pp.id)}
          >
            {powerBusy ? 'Procesando…' : stopping ? 'Apagar' : 'Encender'}
          </button>
        </div>
      </div>
    </div>
  {/if}

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
    font-family: var(--font-sans);
  }

  .app {
    width: 100%;
    min-height: 100vh;
    padding: 12px 0 48px;
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

  header p {
    color: var(--muted-foreground);
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
    color: var(--primary);
  }

  .error-msg {
    color: var(--destructive);
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

  /* Color por entorno: pestaña y header de la tabla comparten tono */
  .env-dev   { --env-main: var(--primary); --env-light: #8da2fb; }
  .env-staging { --env-main: #d97706; --env-light: #fbbf24; }
  .env-prod  { --env-main: #059669; --env-light: #34d399; }

  .env-tabs {
    display: flex;
    gap: 4px;
    padding: 0 40px 0 16px;
  }

  .env-tab {
    padding: 8px 20px;
    border: 1px solid var(--border);
    border-bottom: none;
    background: var(--muted);
    color: #64748b;
    font-size: 0.85rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    border-radius: 8px 8px 0 0;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }

  .env-tab:hover {
    background: var(--border);
    color: #334155;
  }

  .env-tab.active {
    background: var(--env-main);
    color: #fff;
    border-color: var(--env-main);
  }

  .env-tab {
    border-top: 3px solid var(--env-main);
  }

  .card {
    overflow: hidden;
  }

  td.placeholder-msg {
    text-align: center;
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
    background: linear-gradient(90deg, var(--env-main), var(--env-light));
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

  tbody tr.empty-row:hover {
    background: none;
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

  .owner-cell,
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
    background: var(--border);
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
    border-radius: 8px;
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
    border-radius: 8px;
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
    border-radius: 8px;
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
    background: var(--muted);
    padding: 3px 10px;
    border-radius: 8px;
    border: 1px solid var(--border);
  }

  .webhook-col {
    text-align: center;
  }

  .webhook-cell {
    white-space: nowrap;
    text-align: center;
    width: 1%;
  }

  .webhook-btn-group {
    display: inline-flex;
    align-items: center;
    gap: 6px;
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
    border-color: var(--primary);
    transform: scale(1.05);
  }

  .deploy-btn:active:not(:disabled) {
    transform: scale(0.95);
  }

  .deploy-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .merge-btn {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border: 1px solid #c7d2fe;
    background: #eef2ff;
    color: #4338ca;
    border-radius: 8px;
    cursor: pointer;
    font-size: 0.95rem;
    font-weight: 700;
    line-height: 1;
    transition: background 0.15s, border-color 0.15s, transform 0.1s;
  }

  .merge-btn svg {
    width: 16px;
    height: 16px;
  }

  .merge-btn:hover:not(:disabled) {
    background: #e0e7ff;
    border-color: #4f46e5;
    transform: scale(1.05);
  }

  .merge-btn:active:not(:disabled) {
    transform: scale(0.95);
  }

  .merge-btn:disabled {
    cursor: not-allowed;
  }

  .merge-btn.success {
    background: #f0fdf4;
    border-color: #bbf7d0;
    color: #15803d;
  }

  .merge-btn.no_changes {
    background: var(--muted);
    border-color: #cbd5e1;
    color: #64748b;
  }

  .merge-btn.error {
    background: #fef2f2;
    border-color: #fecaca;
    color: var(--destructive);
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
    /* Azul pálido + aro oscuro: legible con daltonismo (no depende de rojo/verde) */
    width: 14px;
    height: 14px;
    background: #bfdbfe;
    border: 2px solid var(--primary-hover);
    box-shadow: 0 0 0 4px rgba(147, 197, 253, 0.55);
    animation: none;
  }

  button.live-btn {
    border: 2px solid transparent;
    padding: 0;
    cursor: pointer;
    vertical-align: middle;
  }

  button.live-btn:hover,
  button.live-btn:focus-visible {
    outline: 2px solid #334155;
    outline-offset: 3px;
  }

  .power-text {
    font-size: 0.9rem;
    color: #334155;
    margin: 4px 0 14px;
    line-height: 1.5;
  }

  .power-label {
    display: block;
    font-size: 0.85rem;
    color: #334155;
    margin-bottom: 6px;
  }

  .power-input {
    width: 100%;
    padding: 8px 10px;
    border: 1px solid #cbd5e1;
    border-radius: 8px;
    font-size: 0.9rem;
    margin-bottom: 12px;
  }

  .power-error {
    color: var(--destructive);
    font-size: 0.85rem;
    margin-bottom: 12px;
  }

  .power-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 6px;
  }

  .btn-power-cancel,
  .btn-power-confirm {
    padding: 8px 16px;
    border-radius: 8px;
    font-size: 0.88rem;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid #cbd5e1;
    background: #fff;
    color: #334155;
  }

  .btn-power-confirm {
    background: var(--primary-hover);
    border-color: var(--primary-hover);
    color: #fff;
  }

  .btn-power-confirm:disabled,
  .btn-power-cancel:disabled {
    opacity: 0.5;
    cursor: not-allowed;
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
    color: var(--primary);
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
    background: var(--muted);
    border: 1px solid #cbd5e1;
  }

  .status.error {
    color: var(--destructive);
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
    border-top-color: var(--primary);
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
    border-bottom: 1px solid var(--border);
    padding: 0 0 12px 0;
    background: transparent;
  }

  .modal-header h3 {
    margin: 0;
    font-size: 1.05rem;
    color: var(--foreground);
    font-family: 'Consolas', 'Courier New', monospace;
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .status-tag {
    font-size: 0.7rem;
    padding: 2px 8px;
    border-radius: 14px;
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
    color: var(--destructive);
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
    background: var(--muted);
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
    color: var(--border);
    padding: 12px 16px;
    border-radius: 8px;
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
    background: var(--primary);
    color: #fff;
    border: none;
    padding: 8px 16px;
    border-radius: 8px;
    cursor: pointer;
    font-size: 0.85rem;
    font-weight: 500;
  }

  .btn-load-log:hover {
    background: var(--primary-hover);
  }
</style>
