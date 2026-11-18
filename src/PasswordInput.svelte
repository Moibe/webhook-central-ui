<script>
  // Campo de contraseña con ojito para mostrarla u ocultarla
  let { id, value = $bindable(''), autocomplete = 'current-password', required = false } = $props();

  let visible = $state(false);
</script>

<div class="pw">
  <input {id} type={visible ? 'text' : 'password'} {autocomplete} {required} spellcheck="false" bind:value />
  <button
    type="button"
    class="eye"
    onclick={() => (visible = !visible)}
    aria-pressed={visible}
    aria-label={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'}
    title={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'}
  >
    {#if visible}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="2" y1="2" x2="22" y2="22"/></svg>
    {:else}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
    {/if}
  </button>
</div>

<style>
  .pw {
    position: relative;
    display: flex;
  }

  input {
    flex: 1;
    min-width: 0;
    padding: 9px 40px 9px 11px;
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 0.95rem;
  }

  /* Edge pone su propio ojito en los campos de contraseña: se oculta para no tener dos */
  input::-ms-reveal,
  input::-ms-clear {
    display: none;
  }

  .eye {
    position: absolute;
    top: 50%;
    right: 6px;
    transform: translateY(-50%);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--muted-foreground);
    cursor: pointer;
    transition: color 0.15s, background 0.15s;
  }

  .eye:hover,
  .eye:focus-visible {
    color: var(--foreground);
    background: var(--muted);
  }

  .eye svg {
    width: 18px;
    height: 18px;
  }
</style>
