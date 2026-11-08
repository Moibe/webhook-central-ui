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
    'constructor-agente-rag-dev': 'Buzzword Agentes',
    'buzzword-agentes-ui-dev': 'Buzzword Agentes',
    'host-asistentes-dev': 'Buzzword Agentes',
    'nexus_back': 'Biblioratum',
    'nexus_poc_svelte': 'Biblioratum',
    'nexus_back_dev': 'Biblioratum',
    'nexus_poc_svelte_dev': 'Biblioratum',
    'nexus_monitor': 'Biblioratum',
    'nexus_back_staging': 'Biblioratum',
    'nexus_poc_svelte_staging': 'Biblioratum',
    'infra-timelapse': 'Prototipo',
    'shape_up': 'Prototipo',
    'shape_up_dev': 'Prototipo',
    'inventario-ti': 'Infra',
    'santander_ia_dev': 'Santander',
    'santander_ia': 'Santander',
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

  // Actualizar una app dev con los datos de prod (refresh.sh): confirmar → lanzar →
  // seguir la corrida por el mismo polling de deploys.jsonl ("kind": "refresh").
  // Vocabulario: en la pantalla se dice "actualizar / actualización"; el backend (refresh.sh, los hooks
  // refrescar-*) y los identificadores de este archivo (refresh*) conservan "refresh".
  let refreshTarget = $state(null);
  let refreshTyped = $state('');
  let refreshPhase = $state('confirm'); // 'confirm' | 'sending' | 'running'
  let refreshRunId = $state(null);
  let refreshError = $state('');
  let refreshInput = $state();
  let refreshDialog = $state();
  // El mismo modal sirve para deshacer la última actualización ("kind": "refresh-undo")
  let refreshMode = $state('refrescar'); // 'refrescar' | 'deshacer'
  let lastRefreshRecs = $state({}); // app -> último registro de actualización o de deshacer

  // Etiquetas de la columna Estado y del detalle según el tipo de corrida
  const KIND_LABELS = {
    refresh: { running: 'Actualizando datos...', success: 'Datos de prod', failed: 'Falló la actualización', detail: 'actualización · ' },
    'refresh-undo': { running: 'Deshaciendo actualización...', success: 'Actualización deshecha', failed: 'Falló deshacer', detail: 'deshacer actualización · ' },
  };

  let detailDeploy = $state(null);
  let detailLogContent = $state('');
  let detailLogLoading = $state(false);

  let sortKey = $state('project');
  let sortDir = $state('asc');

  // Filtros por columna (estilo hoja de cálculo): clave de columna -> valores marcados.
  // Sin nada marcado en una columna = esa columna no filtra; con valores marcados solo
  // se ven las filas que tengan alguno de ellos. Entre columnas se combinan (Y).
  let filters = $state({});
  let filterOpen = $state(null); // { key, top, left } mientras el menú de una columna está abierto
  let filterSearch = $state('');
  let addonOpen = $state(null); // { id, top, left } mientras el menú de add-ons de una app está abierto

  const COLUMN_LABELS = {
    name: 'Aplicación', project: 'Proyecto', owner: 'Owner', stack: 'Stack', branch: 'Branch',
    envs: 'Ambientes', type: 'Tipo de App', port: 'Puerto', status: 'Estado', live: 'Live',
  };

  // Una misma app vive en varios ambientes como entradas separadas de apps.json
  // (nexus_back, nexus_back_dev, nexus_back_staging): se agrupan por el id sin el
  // sufijo de ambiente. Una entrada sin `env` cuenta como dev, igual que en las pestañas.
  const ENV_ORDER = ['dev', 'staging', 'prod'];
  const envOf = (p) => (p.env === 'staging' || p.env === 'prod' ? p.env : 'dev');
  const baseId = (id) => id.replace(/[-_](dev|staging)$/, '');

  const instancesByBase = $derived.by(() => {
    const map = {};
    for (const p of projects) {
      const inst = (map[baseId(p.id)] ??= {});
      inst[envOf(p)] ??= p.id;
    }
    return map;
  });

  // Ambientes donde está desplegada la app de esta fila (dev → staging → prod), con el id de cada instancia
  function appEnvs(project) {
    const inst = instancesByBase[baseId(project.id)] ?? {};
    return ENV_ORDER.filter((e) => inst[e]).map((e) => ({ env: e, id: inst[e] }));
  }

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
      case 'envs': {
        // Primero las que ya llegaron a prod, luego a staging, y al final las que solo están en dev
        const e = appEnvs(project).map((x) => x.env);
        return ['prod', 'staging', 'dev'].map((k) => (e.includes(k) ? 0 : 1)).join('');
      }
      default: return '';
    }
  }

  const envProjects = $derived.by(() => {
    return projects.filter((p) => envOf(p) === activeEnv);
  });

  // Texto de la celda tal como lo ve el usuario: es lo que se lista y se compara en el filtro
  function statusText(st) {
    const kind = st.rec?.kind;
    switch (st.kind) {
      case 'loading': return 'Disparado';
      case 'running': return KIND_LABELS[kind]?.running ?? 'Desplegando...';
      case 'success': return KIND_LABELS[kind]?.success ?? 'Desplegado';
      case 'no_changes': return 'Sin cambios';
      case 'failed': return KIND_LABELS[kind]?.failed ?? 'Falló';
      case 'error': return 'Error de red';
      default: return 'Listo';
    }
  }

  const LIVE_LABELS = { online: 'En línea', stopped: 'Detenida', errored: 'Con error', unknown: 'Sin dato' };

  function filterValue(project, key) {
    switch (key) {
      case 'name': return project.name || '—';
      case 'project': return PROJECT_BY_APP[project.id] ?? '—';
      case 'owner': return project.owner || '—';
      case 'stack': return project.stack === 'none' ? 'config' : (project.stack || '—');
      case 'branch': return project.branch || '—';
      case 'envs': return appEnvs(project).map((x) => ENV_LABELS[x.env]); // varios valores por fila
      case 'type': return !project.app_url ? '—' : project.stack === 'python' ? 'API' : 'Webapp';
      case 'port': return appPort(project) ?? '—';
      case 'status': return statusText(effectiveStatus(project.id));
      case 'live': {
        const l = liveStatus(project);
        return LIVE_LABELS[l] ?? l;
      }
      default: return '';
    }
  }

  // Una celda puede tener varios valores (Ambientes): siempre se trabaja con una lista
  const valuesOf = (project, key) => [].concat(filterValue(project, key));

  // ¿Cumple los filtros de todas las columnas (menos `except`, para armar las opciones de esa columna)?
  function matchesFilters(project, except = null) {
    for (const key of Object.keys(filters)) {
      if (key === except) continue;
      const sel = filters[key];
      if (sel?.length && !valuesOf(project, key).some((v) => sel.includes(v))) return false;
    }
    return true;
  }

  const activeFilterKeys = $derived(Object.keys(filters).filter((k) => filters[k]?.length));

  // Valores de una columna con cuántas filas los tienen, respetando los demás filtros
  function filterOptions(key) {
    const counts = new Map();
    for (const p of envProjects) {
      if (!matchesFilters(p, key)) continue;
      for (const v of valuesOf(p, key)) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    for (const v of filters[key] ?? []) if (!counts.has(v)) counts.set(v, 0);
    const rank = (v) => ENV_ORDER.findIndex((e) => ENV_LABELS[e] === v);
    return [...counts]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) =>
        key === 'envs'
          ? rank(a.value) - rank(b.value) // Dev, Staging, Prod
          : String(a.value).localeCompare(String(b.value), 'es', { numeric: true })
      );
  }

  function toggleFilterValue(key, value) {
    const cur = filters[key] ?? [];
    filters = { ...filters, [key]: cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value] };
  }

  function clearFilter(key) {
    const { [key]: _quitada, ...rest } = filters;
    filters = rest;
  }

  function openFilter(e, key) {
    e.stopPropagation(); // el botón vive dentro del th que ordena
    if (filterOpen?.key === key) {
      filterOpen = null;
      return;
    }
    addonOpen = null;
    const r = e.currentTarget.getBoundingClientRect();
    filterOpen = {
      key,
      top: r.bottom + 6,
      left: Math.max(8, Math.min(r.left, window.innerWidth - 240 - 8)),
    };
    filterSearch = '';
  }

  function onWindowPointerdown(e) {
    if (filterOpen && !e.target.closest?.('.filter-pop, .filter-btn')) filterOpen = null;
    if (addonOpen && !e.target.closest?.('.addon-pop, .addon-btn')) addonOpen = null;
  }

  const closePops = () => {
    filterOpen = null;
    addonOpen = null;
  };

  // Los valores de una pestaña no existen en las otras: al cambiar, se parte sin filtros
  function setEnv(env) {
    activeEnv = env;
    filters = {};
    closePops();
  }

  const visibleProjects = $derived(envProjects.filter((p) => matchesFilters(p)));

  const sortedProjects = $derived.by(() => {
    if (!sortKey) return visibleProjects;
    const arr = [...visibleProjects];
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
      const nextRefresh = {};
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const rec = JSON.parse(t);
          // El último evento por app gana (jsonl es append-only en orden cronológico)
          next[rec.app] = rec;
          // Aparte, la última actualización/deshacer: un deploy de código después no
          // debe esconder el botón de deshacer.
          if (rec.kind === 'refresh' || rec.kind === 'refresh-undo') nextRefresh[rec.app] = rec;
        } catch (_) {
          // línea malformada, ignorar
        }
      }
      backendDeploys = next;
      lastRefreshRecs = nextRefresh;
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

  // Cerrar un modal con clic en el fondo solo si el clic también EMPEZÓ en el fondo:
  // seleccionar texto dentro del modal y soltar afuera no debe cerrarlo.
  let pressOnBackdrop = false;
  function backdropDown(e) {
    pressOnBackdrop = e.target === e.currentTarget;
  }
  function backdropClick(e, close) {
    if (pressOnBackdrop && e.target === e.currentTarget) close();
    pressOnBackdrop = false;
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

  function canRefresh(project) {
    return isSuper && !!project.refresh_url && !!POWER_TOKEN && project.env === 'dev';
  }

  // Deshacer solo tiene sentido si la última actualización de la app cambió datos:
  // terminó bien, o falló después de mover lo de dev (dejó respaldo). Si ya se
  // deshizo, el último registro es el de deshacer y el botón desaparece.
  function canUndoRefresh(project) {
    if (!canRefresh(project) || !project.refresh_undo_url) return false;
    const r = lastRefreshRecs[project.id];
    return r?.kind === 'refresh' && r.event === 'finished' && (r.status === 'success' || !!r.respaldo);
  }

  // Add-ons de una app: acciones extra que no son el deploy (hoy, actualizar dev con los datos de prod y deshacerlo).
  // Salen de un menú junto al nombre; una app sin ninguno no lleva ese botón. Para sumar uno nuevo, se agrega aquí.
  function addonsOf(project) {
    const list = [];
    if (canRefresh(project)) {
      list.push({ key: 'refresh', label: 'Actualizar con datos de prod', hint: `Desde ${project.refresh_from ?? 'prod'}` });
    }
    if (canUndoRefresh(project)) {
      list.push({ key: 'undo', label: 'Deshacer la última actualización', hint: 'Dev regresa a como estaba antes' });
    }
    return list;
  }

  // "Constructor Agente RAG (Dev)" -> ["Constructor Agente RAG ", "(Dev)"]; un nombre de una palabra -> ["", nombre]
  function splitLastWord(name) {
    const i = name.lastIndexOf(' ');
    return i < 0 ? ['', name] : [name.slice(0, i + 1), name.slice(i + 1)];
  }

  function toggleAddons(e, project) {
    if (addonOpen?.id === project.id) {
      addonOpen = null;
      return;
    }
    filterOpen = null;
    const r = e.currentTarget.getBoundingClientRect();
    addonOpen = { id: project.id, top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - 280 - 8)) };
  }

  function runAddon(project, key) {
    addonOpen = null;
    openRefresh(project, key === 'undo' ? 'deshacer' : 'refrescar');
  }

  function openRefresh(project, mode = 'refrescar') {
    refreshMode = mode;
    refreshTarget = project;
    refreshTyped = '';
    refreshPhase = 'confirm';
    refreshRunId = null;
    refreshError = '';
  }

  function closeRefresh() {
    if (refreshPhase === 'sending') return;
    refreshTarget = null;
  }

  async function confirmRefresh() {
    const project = refreshTarget;
    if (!project || refreshPhase !== 'confirm' || refreshTyped !== project.id) return;
    refreshPhase = 'sending';
    refreshError = '';
    try {
      const qs = new URLSearchParams({ token: POWER_TOKEN });
      const url = refreshMode === 'deshacer' ? project.refresh_undo_url : project.refresh_url;
      const res = await fetch(`${WEBHOOK_BASE}${url}?${qs}`, { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (data?.ok && data.run_id) {
        refreshRunId = data.run_id;
        refreshPhase = 'running';
        refreshDeploys();
      } else {
        refreshError = data?.error ?? `HTTP ${res.status}`;
        refreshPhase = 'confirm';
      }
    } catch (_) {
      refreshError = 'Error de red';
      refreshPhase = 'confirm';
    }
  }

  // Registro de la corrida lanzada desde el modal (started → finished)
  const refreshRec = $derived.by(() => {
    if (!refreshTarget || !refreshRunId) return null;
    const rec = backendDeploys[refreshTarget.id];
    return rec?.id === refreshRunId ? rec : null;
  });

  $effect(() => {
    if (refreshTarget && refreshPhase === 'confirm') refreshInput?.focus();
    // Al lanzar, el campo desaparece: el foco pasa al diálogo para que Esc y
    // el teclado sigan dentro del modal.
    else if (refreshTarget && refreshPhase === 'running') refreshDialog?.focus();
  });

  function onWindowKeydown(e) {
    if (e.key === 'Escape' && (filterOpen || addonOpen)) {
      closePops();
      return;
    }
    if (e.key === 'Escape' && refreshTarget) closeRefresh();
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

<svelte:window
  onkeydown={onWindowKeydown}
  onpointerdown={onWindowPointerdown}
  onscroll={closePops}
  onresize={closePops}
/>

<!-- Encabezado de columna: el clic en el título ordena, el embudo abre el filtro de esa columna -->
{#snippet sortTh(key, label, cls = '', filterable = true)}
  <th class="sortable {cls}" onclick={() => setSort(key)}>
    <span class="th-inner">
      <span class="th-label">{label}<span class="sort-arrow {sortKey === key ? 'active' : ''}">{sortKey === key ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}</span></span>
      {#if filterable}
        <button
          type="button"
          class="filter-btn {filters[key]?.length ? 'active' : ''}"
          onclick={(e) => openFilter(e, key)}
          aria-label="Filtrar por {COLUMN_LABELS[key]}{filters[key]?.length ? ` (${filters[key].length} marcados)` : ''}"
          aria-expanded={filterOpen?.key === key}
          title={filters[key]?.length ? `Filtrando: ${filters[key].join(', ')}` : `Filtrar por ${COLUMN_LABELS[key]}`}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z" />
          </svg>
        </button>
      {/if}
    </span>
  </th>
{/snippet}

<!-- Iconos de los add-ons (trazo Lucide, toman el color del contenedor) -->
{#snippet puzzleIcon()}
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z" />
  </svg>
{/snippet}

{#snippet refreshIcon()}
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <ellipse cx="10" cy="5" rx="7" ry="2.5"/>
    <path d="M3 5v12c0 1.4 3.1 2.5 7 2.5"/>
    <path d="M3 11c0 1.4 3.1 2.5 7 2.5"/>
    <path d="M17 5v4"/>
    <path d="M21.5 15.5a4 4 0 0 0-7.4-1.5"/>
    <path d="M14 11.5V14h2.5"/>
    <path d="M14.5 18.5a4 4 0 0 0 7.4 1.5"/>
    <path d="M22 22.5V20h-2.5"/>
  </svg>
{/snippet}

{#snippet undoIcon()}
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M9 14 4 9l5-5"/>
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>
  </svg>
{/snippet}

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
            onclick={() => setEnv(env)}
          >
            {ENV_LABELS[env]}
          </button>
        {/each}
        {#if activeFilterKeys.length}
          <div class="filter-summary">
            <span>Mostrando {sortedProjects.length} de {envProjects.length}</span>
            <button type="button" class="filter-clear-all" onclick={() => (filters = {})}>Limpiar filtros</button>
          </div>
        {/if}
      </div>

      <div class="card" onscroll={closePops}>
      {#if loading}
        <p class="loading-msg"><span class="spinner"></span> Cargando proyectos...</p>
      {:else if error}
        <p class="error-msg">{error}</p>
      {:else}
        <table>
          <thead>
            <tr>
              {@render sortTh('name', 'Aplicación')}
              {@render sortTh('envs', 'Ambientes')}
              <th class="folder-col">Origen</th>
              {@render sortTh('project', 'Proyecto')}
              {@render sortTh('owner', 'Owner')}
              {@render sortTh('stack', 'Stack')}
              {@render sortTh('branch', 'Branch')}
              <th class="app-col">DOM</th>
              {@render sortTh('type', 'Tipo de App')}
              {@render sortTh('port', 'Puerto')}
              {@render sortTh('webhook', 'DEPLOY', 'webhook-col', false)}
              {@render sortTh('status', 'Estado')}
              {@render sortTh('live', 'Live', 'live-col')}
            </tr>
          </thead>
          <tbody>
            {#each sortedProjects as project}
              {@const st = effectiveStatus(project.id)}
              {@const live = liveStatus(project)}
              {@const hasAddons = addonsOf(project).length > 0}
              <tr>
                <td class="project-name">
                  {#if hasAddons}
                    <!-- El botón va pegado a la última palabra: si el nombre se parte en dos renglones, no queda solo -->
                    {@const [head, tail] = splitLastWord(project.name)}
                    {head}<span class="nowrap">{tail}<button
                        type="button"
                        class="addon-btn"
                        class:open={addonOpen?.id === project.id}
                        onclick={(e) => toggleAddons(e, project)}
                        aria-haspopup="menu"
                        aria-expanded={addonOpen?.id === project.id}
                        aria-label="Add-ons de {project.name}"
                        title="Add-ons"
                      >{@render puzzleIcon()}</button></span>
                  {:else}
                    {project.name}
                  {/if}
                </td>
                <td class="envs-cell">
                  <div class="env-chips">
                    {#each appEnvs(project) as e (e.env)}
                      {#if user.tabs.includes(e.env) && e.env !== activeEnv}
                        <button type="button" class="env-chip chip-{e.env} chip-link" onclick={() => setEnv(e.env)} title="Ir a {ENV_LABELS[e.env]} ({e.id})">{e.env === 'staging' ? 'Stag' : ENV_LABELS[e.env]}</button>
                      {:else}
                        <span class="env-chip chip-{e.env}" title="{ENV_LABELS[e.env]}: {e.id}">{e.env === 'staging' ? 'Stag' : ENV_LABELS[e.env]}</span>
                      {/if}
                    {/each}
                  </div>
                </td>
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
                    {#if project.stack === 'python'}<svg class="stack-icon" viewBox="0 0 24 24" fill="#3776ab" aria-hidden="true"><path d="M14.25.18l.9.2.73.26.59.3.45.32.34.34.25.34.16.33.1.3.04.26.02.2-.01.13V8.5l-.05.63-.13.55-.21.46-.26.38-.3.31-.33.25-.35.19-.35.14-.33.1-.3.07-.26.04-.21.02H8.77l-.69.05-.59.14-.5.22-.41.27-.33.32-.27.35-.2.36-.15.37-.1.35-.07.32-.04.27-.02.21v3.06H3.17l-.21-.03-.28-.07-.32-.12-.35-.18-.36-.26-.36-.36-.35-.46-.32-.59-.28-.73-.21-.88-.14-1.05-.05-1.23.06-1.22.16-1.04.24-.87.32-.71.36-.57.4-.44.42-.33.42-.24.4-.16.36-.1.32-.05.24-.01h.16l.06.01h8.16v-.83H6.18l-.01-2.75-.02-.37.05-.34.11-.31.17-.28.25-.26.31-.23.38-.2.44-.18.51-.15.58-.12.64-.1.71-.06.77-.04.84-.02 1.27.05zm-6.3 1.98l-.23.33-.08.41.08.41.23.34.33.22.41.09.41-.09.33-.22.23-.34.08-.41-.08-.41-.23-.33-.33-.22-.41-.09-.41.09zm13.09 3.95l.28.06.32.12.35.18.36.27.36.35.35.47.32.59.28.73.21.88.14 1.04.05 1.23-.06 1.23-.16 1.04-.24.86-.32.71-.36.57-.4.45-.42.33-.42.24-.4.16-.36.09-.32.05-.24.02-.16-.01h-8.22v.82h5.84l.01 2.76.02.36-.05.34-.11.31-.17.29-.25.25-.31.24-.38.2-.44.17-.51.15-.58.13-.64.09-.71.07-.77.04-.84.01-1.27-.04-1.07-.14-.9-.2-.73-.25-.59-.3-.45-.33-.34-.34-.25-.34-.16-.33-.1-.3-.04-.25-.02-.2.01-.13v-5.34l.05-.64.13-.54.21-.46.26-.38.3-.32.33-.24.35-.2.35-.14.33-.1.3-.06.26-.04.21-.02.13-.01h5.84l.69-.05.59-.14.5-.21.41-.28.33-.32.27-.35.2-.36.15-.36.1-.35.07-.32.04-.28.02-.21V6.07h2.09l.14.01zm-6.47 14.25l-.23.33-.08.41.08.41.23.33.33.23.41.08.41-.08.33-.23.23-.33.08-.41-.08-.41-.23-.33-.33-.23-.41-.08-.41.08z"/></svg>{:else if project.stack === 'svelte'}<svg class="stack-icon" viewBox="0 0 24 24" fill="#ff3e00" aria-hidden="true"><path d="M10.354 21.125a4.44 4.44 0 0 1-4.765-1.767 4.109 4.109 0 0 1-.703-3.107 3.898 3.898 0 0 1 .134-.522l.105-.321.287.21a7.21 7.21 0 0 0 2.186 1.092l.208.063-.02.208a1.253 1.253 0 0 0 .226.83 1.337 1.337 0 0 0 1.435.533 1.231 1.231 0 0 0 .343-.15l5.59-3.562a1.164 1.164 0 0 0 .524-.778 1.242 1.242 0 0 0-.211-.937 1.338 1.338 0 0 0-1.435-.533 1.23 1.23 0 0 0-.343.15l-2.133 1.36a4.078 4.078 0 0 1-1.135.499 4.44 4.44 0 0 1-4.765-1.766 4.108 4.108 0 0 1-.702-3.108 3.855 3.855 0 0 1 1.742-2.582l5.589-3.563a4.072 4.072 0 0 1 1.135-.499 4.44 4.44 0 0 1 4.765 1.767 4.109 4.109 0 0 1 .703 3.107 3.943 3.943 0 0 1-.134.522l-.105.321-.286-.21a7.204 7.204 0 0 0-2.187-1.093l-.208-.063.02-.207a1.255 1.255 0 0 0-.226-.831 1.337 1.337 0 0 0-1.435-.532 1.231 1.231 0 0 0-.343.15L8.62 9.368a1.162 1.162 0 0 0-.524.778 1.24 1.24 0 0 0 .211.937 1.338 1.338 0 0 0 1.435.533 1.235 1.235 0 0 0 .344-.151l2.132-1.36a4.067 4.067 0 0 1 1.135-.498 4.44 4.44 0 0 1 4.765 1.766 4.108 4.108 0 0 1 .702 3.108 3.857 3.857 0 0 1-1.742 2.583l-5.589 3.562a4.072 4.072 0 0 1-1.135.499m10.358-17.95C18.484-.015 14.082-.96 10.9 1.068L5.31 4.63a6.412 6.412 0 0 0-2.896 4.295 6.753 6.753 0 0 0 .666 4.336 6.43 6.43 0 0 0-.96 2.396 6.833 6.833 0 0 0 1.168 5.167c2.229 3.19 6.63 4.135 9.812 2.108l5.59-3.562a6.41 6.41 0 0 0 2.896-4.295 6.756 6.756 0 0 0-.665-4.336 6.429 6.429 0 0 0 .958-2.396 6.831 6.831 0 0 0-1.167-5.168Z"/></svg>{:else if project.stack === 'none'}<svg class="stack-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>{/if}{project.stack === 'none' ? 'config' : project.stack}
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
                      {#if project.stack === 'python'}
                        <svg class="type-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                          <rect width="20" height="8" x="2" y="2" rx="2" /><rect width="20" height="8" x="2" y="14" rx="2" />
                          <line x1="6" x2="6.01" y1="6" y2="6" /><line x1="6" x2="6.01" y1="18" y2="18" />
                        </svg>
                        API ↗
                      {:else}
                        <svg class="type-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                          <rect x="2" y="4" width="20" height="16" rx="2" /><path d="M10 4v4" /><path d="M2 8h20" /><path d="M6 4v4" />
                        </svg>
                        Webapp ↗
                      {/if}
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
                      <span class="spinner"></span> {KIND_LABELS[st.rec?.kind]?.running ?? 'Desplegando...'}
                    </span>
                  {:else if st.kind === 'success'}
                    <span class="status success" title={st.rec ? `${KIND_LABELS[st.rec.kind] && st.rec.resumen ? st.rec.resumen + ' · ' : ''}Tomó ${fmtDurationVerbose(st.rec.duration_s)} · ${fmtTime(st.rec.ended_at)}` : ''}>
                      ✓ {KIND_LABELS[st.rec?.kind]?.success ?? 'Desplegado'}
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
                      ✗ {KIND_LABELS[st.rec?.kind]?.failed ?? 'Falló'}{st.rec?.failed_step ? ` en ${st.rec.failed_step}` : ''}
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
                <td colspan="13" class="placeholder-msg">
                  {activeFilterKeys.length ? 'Ningún proyecto coincide con los filtros' : activeEnv === 'staging' ? 'Aún no hay proyectos en Staging' : activeEnv === 'prod' ? 'Aún no hay proyectos en producción' : 'No hay proyectos'}
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

  {#if filterOpen}
    {@const fkey = filterOpen.key}
    {@const opts = filterOptions(fkey)}
    {@const q = filterSearch.trim().toLowerCase()}
    {@const shown = q ? opts.filter((o) => String(o.value).toLowerCase().includes(q)) : opts}
    {@const selected = filters[fkey] ?? []}
    <div
      class="filter-pop env-{activeEnv}"
      style="top: {filterOpen.top}px; left: {filterOpen.left}px"
      role="dialog"
      aria-label="Filtrar por {COLUMN_LABELS[fkey]}"
      tabindex="-1"
    >
      {#if opts.length > 8}
        <input class="filter-search" type="search" placeholder="Buscar..." bind:value={filterSearch} />
      {/if}
      <div class="filter-list">
        {#each shown as o (o.value)}
          <label class="filter-opt">
            <input type="checkbox" checked={selected.includes(o.value)} onchange={() => toggleFilterValue(fkey, o.value)} />
            <span class="filter-opt-text" title={o.value}>{o.value}</span>
            <span class="filter-opt-count">{o.count}</span>
          </label>
        {:else}
          <p class="filter-none">Sin coincidencias</p>
        {/each}
      </div>
      <div class="filter-foot">
        <button type="button" class="filter-clear" disabled={!selected.length} onclick={() => clearFilter(fkey)}>Limpiar</button>
      </div>
    </div>
  {/if}

  {#if powerTarget}
    {@const pp = powerTarget.project}
    {@const stopping = powerTarget.action === 'stop'}
    <div
      class="modal-backdrop"
      onpointerdown={backdropDown}
      onclick={(e) => backdropClick(e, closePower)}
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

  {#if addonOpen}
    {@const ap = projects.find((p) => p.id === addonOpen.id)}
    {@const items = ap ? addonsOf(ap) : []}
    {#if items.length}
      {@const ast = effectiveStatus(ap.id)}
      <div class="addon-pop" role="menu" aria-label="Add-ons de {ap.name}" style="top: {addonOpen.top}px; left: {addonOpen.left}px">
        <p class="addon-title">Add-ons</p>
        {#each items as it (it.key)}
          <button
            type="button"
            role="menuitem"
            class="addon-item"
            disabled={ast.kind === 'loading' || ast.kind === 'running'}
            onclick={() => runAddon(ap, it.key)}
          >
            <span class="addon-ico addon-ico-{it.key}">{#if it.key === 'undo'}{@render undoIcon()}{:else}{@render refreshIcon()}{/if}</span>
            <span class="addon-text">
              <span class="addon-label">{it.label}</span>
              <span class="addon-hint">{it.hint}</span>
            </span>
          </button>
        {/each}
      </div>
    {/if}
  {/if}

  {#if refreshTarget}
    {@const rp = refreshTarget}
    {@const deshacer = refreshMode === 'deshacer'}
    <div
      class="modal-backdrop"
      onpointerdown={backdropDown}
      onclick={(e) => backdropClick(e, closeRefresh)}
      onkeydown={(e) => { if (e.key === 'Escape') closeRefresh(); }}
      role="presentation"
    >
      <div
        class="modal refresh-modal"
        bind:this={refreshDialog}
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => { if (e.key === 'Escape') closeRefresh(); e.stopPropagation(); }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="refresh-title"
        tabindex="-1"
      >
        <header class="modal-header">
          <h3 id="refresh-title">{deshacer ? 'Deshacer la última actualización de' : 'Actualizar'} {rp.name}</h3>
          <button type="button" class="modal-close" onclick={closeRefresh} aria-label="Cerrar" disabled={refreshPhase === 'sending'}>✕</button>
        </header>
        {#if refreshPhase !== 'running' && deshacer}
          <p class="power-text">
            <strong>{rp.id}</strong> regresa a como estaba antes de la actualización
            {#if lastRefreshRecs[rp.id]?.ended_at}del <strong>{fmtTime(lastRefreshRecs[rp.id].ended_at)}</strong>{/if}:
            vuelven sus asistentes, proyectos, cuentas, fuentes de datos, registros, bases de conocimiento y documentos.
          </p>
          <ul class="refresh-list">
            <li>Lo que dev tiene ahora (la copia de prod y lo que hayas hecho desde entonces) no se borra: se aparta en el mismo respaldo del server.</li>
            <li>Prod no se toca.</li>
            <li>Cada actualización se puede deshacer una sola vez.</li>
            <li>La API dev se detiene unos segundos y las sesiones abiertas en dev se cierran.</li>
          </ul>
        {:else if refreshPhase !== 'running'}
          <p class="power-text">
            Se copian los datos de <strong>{rp.refresh_from ?? 'prod'}</strong> sobre los de <strong>{rp.id}</strong>:
            asistentes, proyectos, cuentas, fuentes de datos, registros, bases de conocimiento y documentos.
          </p>
          <ul class="refresh-list">
            <li>Prod solo se lee; no se modifica nada ahí.</li>
            <li>Lo que hoy tiene dev se mueve a un respaldo en el server (se guardan las últimas 3 veces) y deja de verse en dev. Si te arrepientes, lo regresas con «Deshacer la última actualización» en el menú de add-ons.</li>
            <li>La API dev se detiene unos segundos y las sesiones abiertas en dev se cierran.</li>
          </ul>
        {/if}
        {#if refreshPhase !== 'running'}
          <label class="power-label" for="refresh-confirm">
            Escribe <code>{rp.id}</code> para confirmar:
          </label>
          <input
            id="refresh-confirm"
            class="power-input"
            type="text"
            autocomplete="off"
            spellcheck="false"
            bind:this={refreshInput}
            bind:value={refreshTyped}
            disabled={refreshPhase === 'sending'}
            onkeydown={(e) => { if (e.key === 'Enter') confirmRefresh(); }}
          />
          {#if refreshError}
            <p class="power-error" role="alert">✗ {refreshError}</p>
          {/if}
          <div class="power-actions">
            <button type="button" class="btn-power-cancel" onclick={closeRefresh} disabled={refreshPhase === 'sending'}>Cancelar</button>
            <button
              type="button"
              class="btn-power-confirm"
              onclick={confirmRefresh}
              disabled={refreshPhase === 'sending' || refreshTyped !== rp.id}
            >
              {refreshPhase === 'sending' ? 'Lanzando…' : deshacer ? 'Deshacer actualización' : 'Actualizar dev'}
            </button>
          </div>
        {:else if !refreshRec || refreshRec.event !== 'finished'}
          <p class="refresh-progress" role="status">
            <span class="spinner"></span>
            {deshacer ? 'Regresando los datos que tenía dev… suele tardar unos segundos.' : 'Copiando los datos de prod… suele tardar menos de un minuto.'}
          </p>
          <p class="refresh-meta">Puedes cerrar esta ventana: el trabajo sigue en el server y su avance se ve en la columna Estado.</p>
          <div class="power-actions">
            <button type="button" class="btn-power-cancel" onclick={closeRefresh}>Cerrar</button>
          </div>
        {:else if refreshRec.status === 'success'}
          <p class="refresh-ok" role="status">
            ✓ Listo en {fmtDurationVerbose(refreshRec.duration_s)}: {deshacer ? 'dev volvió a como estaba antes de la actualización.' : 'dev ya tiene los datos de prod.'}
          </p>
          {#if refreshRec.resumen}
            <p class="refresh-meta">{refreshRec.resumen}</p>
          {/if}
          {#if refreshRec.respaldo}
            <p class="refresh-meta">{deshacer ? 'Lo que tenía dev (la copia de prod) quedó en' : 'Lo que tenía dev quedó en'} <code>{refreshRec.respaldo}</code></p>
          {/if}
          <div class="power-actions">
            <button type="button" class="btn-power-confirm" onclick={closeRefresh}>Cerrar</button>
          </div>
        {:else}
          <p class="power-error" role="alert">
            ✗ Falló en el paso «{refreshRec.failed_step || '?'}»: {refreshRec.error || 'revisa el log'}
          </p>
          <div class="power-actions">
            <button type="button" class="btn-power-cancel" onclick={() => { const r = refreshRec; refreshTarget = null; openDetail(r); }}>Ver log</button>
            <button type="button" class="btn-power-confirm" onclick={closeRefresh}>Cerrar</button>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  {#if detailDeploy}
    <div
      class="modal-backdrop"
      onpointerdown={backdropDown}
      onclick={(e) => backdropClick(e, closeDetail)}
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
          <h3>{detailDeploy.app} · {KIND_LABELS[detailDeploy.kind]?.detail ?? ''}<span class="status-tag {detailDeploy.status}">{detailDeploy.status}</span></h3>
          <button type="button" class="modal-close" onclick={closeDetail} aria-label="Cerrar">✕</button>
        </header>
        <div class="modal-meta">
          {#if detailDeploy.error}
            <div class="detail-error"><strong>Error:</strong> {detailDeploy.error}</div>
          {/if}
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

  /* Con la tabla más ancha que la ventana se desplaza de lado en vez de cortar
     columnas (antes Estado y Live quedaban fuera de la pantalla sin forma de llegar) */
  .card {
    overflow-x: auto;
    overflow-y: hidden;
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
    /* Relleno horizontal de las celdas. Con 13 columnas, 20px dejaba la tabla en ~1500px
       de ancho mínimo; con 12px mide ~1350 y cabe sin desplazarse en una pantalla de 1366. */
    --cell-x: 12px;
    width: 100%;
    border-collapse: collapse;
    border: none;
  }

  thead tr {
    background: linear-gradient(90deg, var(--env-main), var(--env-light));
  }

  th {
    padding: 14px var(--cell-x);
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

  /* Filtro por columna: embudo junto a la flecha de orden */
  .th-inner {
    display: inline-flex;
    align-items: center;
  }

  /* El embudo queda pegado a la flecha, pero su margen derecho negativo lo mete en el
     relleno de la celda: así casi no le suma ancho a una tabla que ya es ancha */
  .filter-btn {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-left: 2px;
    margin-right: calc(var(--cell-x) * -1);
    width: 16px;
    height: 20px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: #fff;
    opacity: 0.55;
    cursor: pointer;
    transition: background 0.15s, opacity 0.15s, color 0.15s;
  }

  .filter-btn svg {
    width: 11px;
    height: 11px;
  }

  .filter-btn:hover,
  .filter-btn[aria-expanded='true'] {
    opacity: 1;
    background: rgba(255, 255, 255, 0.22);
  }

  .filter-btn.active {
    opacity: 1;
    background: #fff;
    color: var(--env-main);
  }

  .filter-btn.active svg {
    fill: currentColor;
  }

  .filter-summary {
    margin-left: auto;
    align-self: center;
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 0.8rem;
    color: var(--muted-foreground);
  }

  .filter-clear-all,
  .filter-clear {
    padding: 4px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
    color: var(--foreground);
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
  }

  .filter-clear-all:hover,
  .filter-clear:hover:not(:disabled) {
    background: var(--muted);
  }

  .filter-clear:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .filter-pop {
    position: fixed;
    z-index: 900;
    width: 240px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    background: #fff;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 12px 32px rgba(15, 23, 42, 0.18);
    font-size: 0.82rem;
    font-weight: 500;
    color: var(--foreground);
  }

  .filter-search {
    width: 100%;
    box-sizing: border-box;
    padding: 7px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: inherit;
    outline: none;
  }

  .filter-search:focus {
    border-color: var(--env-main);
  }

  .filter-list {
    max-height: 240px;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .filter-opt {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-radius: 6px;
    cursor: pointer;
  }

  .filter-opt:hover {
    background: var(--muted);
  }

  .filter-opt input {
    margin: 0;
    accent-color: var(--env-main);
  }

  .filter-opt-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .filter-opt-count {
    font-size: 0.75rem;
    color: var(--muted-foreground);
  }

  .filter-none {
    margin: 0;
    padding: 10px 8px;
    text-align: center;
    color: var(--muted-foreground);
  }

  .filter-foot {
    display: flex;
    justify-content: flex-end;
    padding-top: 6px;
    border-top: 1px solid var(--border);
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
    padding: 16px var(--cell-x);
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

  /* Logo del stack dentro del chip (Simple Icons) */
  .stack-icon {
    width: 13px;
    height: 13px;
    margin-right: 5px;
    flex-shrink: 0;
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

  /* Ambientes donde esta la app: etiquetas solidas con el color de cada pestana,
     las tres siempre en una linea (staging se abrevia "Stag") */
  .env-chips {
    display: flex;
    flex-wrap: nowrap;
    gap: 3px;
  }

  .env-chip {
    display: inline-flex;
    align-items: center;
    height: 18px;
    padding: 0 5px;
    border-radius: 5px;
    color: #fff;
    font-size: 0.66rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    white-space: nowrap;
    border: 0;
    font-family: inherit;
  }

  /* Etiqueta de otro ambiente: lleva a esa pestaña */
  .chip-link {
    cursor: pointer;
    transition: filter 0.15s, transform 0.15s;
  }

  .chip-link:hover {
    filter: brightness(1.12);
    transform: translateY(-1px);
  }

  .chip-dev { background: var(--primary); }
  .chip-staging { background: #d97706; }
  .chip-prod { background: #059669; }

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
    width: 24px;
    height: 24px;
    color: #d97706;
    border: 1px solid #fde68a;
    background: #fffbeb;
    border-radius: 8px;
    cursor: help;
    transition: background 0.15s, color 0.15s, border-color 0.15s, transform 0.1s;
  }

  .folder-icon svg {
    width: 14px;
    height: 14px;
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
    width: 24px;
    height: 24px;
    margin-left: 6px;
    color: #24292f;
    border: 1px solid #d0d7de;
    background: #f6f8fa;
    border-radius: 8px;
    transition: background 0.15s, color 0.15s, border-color 0.15s, transform 0.1s;
  }

  .repo-icon svg {
    width: 14px;
    height: 14px;
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

  /* Ícono del tipo de app (Lucide: server para API, app-window para Webapp) */
  .type-icon {
    width: 13px;
    height: 13px;
    margin-right: 1px;
    flex-shrink: 0;
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

  .nowrap {
    white-space: nowrap;
  }

  /* Add-ons: botón chico junto al nombre de la app (solo si tiene alguno) y el menú que abre */
  .addon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    margin-left: 8px;
    padding: 0;
    vertical-align: middle;
    border: 1px solid var(--border);
    background: #fff;
    color: var(--muted-foreground);
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }

  .addon-btn svg {
    width: 13px;
    height: 13px;
  }

  .addon-btn:hover,
  .addon-btn.open {
    background: var(--muted);
    color: var(--foreground);
    border-color: #cbd5e1;
  }

  .addon-btn:focus-visible {
    outline: 2px solid var(--env-main);
    outline-offset: 2px;
  }

  .addon-pop {
    position: fixed;
    z-index: 900;
    width: 280px;
    box-sizing: border-box;
    padding: 6px;
    background: #fff;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 12px 32px rgba(15, 23, 42, 0.18);
    font-size: 0.82rem;
    color: var(--foreground);
  }

  .addon-title {
    margin: 0;
    padding: 4px 8px 6px;
    font-size: 0.68rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted-foreground);
  }

  .addon-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 7px 8px;
    border: 0;
    background: none;
    border-radius: 6px;
    cursor: pointer;
    text-align: left;
    font: inherit;
    color: inherit;
  }

  .addon-item:hover:not(:disabled) {
    background: var(--muted);
  }

  .addon-item:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .addon-item:focus-visible {
    outline: 2px solid var(--env-main);
    outline-offset: -2px;
  }

  /* El icono conserva los colores que tenían los botones de la columna: actualizar ámbar, deshacer gris */
  .addon-ico {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border: 1px solid #fcd34d;
    background: #fffbeb;
    color: #b45309;
    border-radius: 8px;
  }

  .addon-ico-undo {
    border-color: #cbd5e1;
    background: #f8fafc;
    color: #475569;
  }

  .addon-ico svg {
    width: 17px;
    height: 17px;
  }

  .addon-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .addon-label {
    font-weight: 600;
  }

  .addon-hint {
    font-size: 0.74rem;
    color: var(--muted-foreground);
  }

  .refresh-modal {
    max-width: 560px;
  }

  .refresh-modal .modal-header h3 {
    font-family: inherit;
  }

  .refresh-list {
    margin: 0 0 16px 18px;
    font-size: 0.85rem;
    color: #475569;
    line-height: 1.55;
  }

  .refresh-progress,
  .refresh-ok {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.92rem;
    font-weight: 500;
    margin: 4px 0 10px;
  }

  .refresh-progress {
    color: var(--primary);
  }

  .refresh-ok {
    color: #15803d;
  }

  .refresh-meta {
    font-size: 0.82rem;
    color: #64748b;
    line-height: 1.5;
    margin-bottom: 10px;
    overflow-wrap: anywhere;
  }

  .detail-error {
    grid-column: 1 / -1;
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
