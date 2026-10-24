<script>
  // Confirmación propia, con el molde de ConfirmarAccion de Nexus: reemplaza al confirm() del navegador.
  // Como un alertdialog: no se cierra con clic fuera, solo con Cancelar, Escape o confirmando.
  let { open = false, title, message, confirmLabel = 'Confirmar', cancelLabel = 'Cancelar', onConfirm, onCancel } = $props();

  let cancelBtn = $state();

  $effect(() => {
    if (open) cancelBtn?.focus();
  });
</script>

{#if open}
  <div class="overlay" role="presentation" onkeydown={(e) => { if (e.key === 'Escape') onCancel(); }}>
    <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="cd-title" aria-describedby="cd-msg" tabindex="-1">
      <div class="icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/>
          <path d="M12 9v4"/><path d="M12 17h.01"/>
        </svg>
      </div>
      <h3 id="cd-title">{title}</h3>
      <p id="cd-msg">{message}</p>
      <div class="actions">
        <button type="button" class="btn-cancel" bind:this={cancelBtn} onclick={onCancel}>{cancelLabel}</button>
        <button type="button" class="btn-danger" onclick={onConfirm}>{confirmLabel}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 70;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgba(0, 0, 0, 0.1);
    backdrop-filter: blur(4px);
  }

  .dialog {
    width: 100%;
    max-width: 400px;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 8px;
    padding: 24px;
    background: var(--background);
    border: 1px solid var(--border);
    border-radius: 14px;
    box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
  }

  .icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    border-radius: 999px;
    background: rgba(220, 38, 38, 0.1);
    color: var(--destructive);
    margin-bottom: 4px;
  }

  .icon svg {
    width: 22px;
    height: 22px;
  }

  h3 {
    font-size: 1.05rem;
    font-weight: 600;
    margin: 0;
  }

  p {
    font-size: 0.875rem;
    color: var(--muted-foreground);
    line-height: 1.5;
  }

  .actions {
    display: flex;
    gap: 8px;
    margin-top: 16px;
    width: 100%;
  }

  button {
    flex: 1;
    padding: 9px 12px;
    border-radius: var(--radius);
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
  }

  .btn-cancel {
    border: 1px solid var(--border);
    background: var(--background);
    color: var(--foreground);
  }

  .btn-cancel:hover {
    background: var(--muted);
  }

  .btn-danger {
    border: 1px solid transparent;
    background: rgba(220, 38, 38, 0.1);
    color: var(--destructive);
  }

  .btn-danger:hover {
    background: rgba(220, 38, 38, 0.2);
  }

  button:focus-visible {
    outline: 3px solid var(--ring);
    outline-offset: 1px;
  }
</style>
