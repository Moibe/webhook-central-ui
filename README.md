# Svelte + Vite

## Enviar la contraseña temporal por correo

En **Usuarios**, el sobre de cada fila le manda al usuario su contraseña temporal por correo. Usa el servicio de
notificaciones de ART Broker, el mismo que Nexus (Biblioratum): código en `server/mail.js` (transporte) y
`server/mail-templates.js` (el correo). El remitente lo decide el servicio y sale como «ART».

Se configura en `.env.server` (raíz del proyecto, en el servidor; plantilla en `.env.server.example`), con las mismas
variables de Nexus: `CORREO_API_URL`, `CORREO_API_USUARIO` y `CORREO_API_CONTRASENA`. No va en `.env` (lo lee Vite al
compilar) y nunca se sube a git. Se relee en cada llamada: no hace falta reiniciar. Sin esas tres variables el sobre
queda apagado.

- Solo funciona mientras el usuario no cambie su contraseña temporal (después solo existe el hash). Para volver a
  mandarla, **Restablecer** genera una nueva.
- El celular (SMS/WhatsApp) sigue sin funcionalidad.
- Los logs dicen a quién se le mandó y quién lo pidió; nunca el cuerpo (ahí va la contraseña), el token ni las credenciales.
- Pruebas: `npm test` (servicio de ART falseado en localhost; no llama al real).

---

This template should help get you started developing with Svelte in Vite.

## Recommended IDE Setup

[VS Code](https://code.visualstudio.com/) + [Svelte](https://marketplace.visualstudio.com/items?itemName=svelte.svelte-vscode).

## Need an official Svelte framework?

Check out [SvelteKit](https://github.com/sveltejs/kit#readme), which is also powered by Vite. Deploy anywhere with its serverless-first approach and adapt to various platforms, with out of the box support for TypeScript, SCSS, and Less, and easily-added support for mdsvex, GraphQL, PostCSS, Tailwind CSS, and more.

## Technical considerations

**Why use this over SvelteKit?**

- It brings its own routing solution which might not be preferable for some users.
- It is first and foremost a framework that just happens to use Vite under the hood, not a Vite app.

This template contains as little as possible to get started with Vite + Svelte, while taking into account the developer experience with regards to HMR and intellisense. It demonstrates capabilities on par with the other `create-vite` templates and is a good starting point for beginners dipping their toes into a Vite + Svelte project.

Should you later need the extended capabilities and extensibility provided by SvelteKit, the template has been structured similarly to SvelteKit so that it is easy to migrate.

**Why include `.vscode/extensions.json`?**

Other templates indirectly recommend extensions via the README, but this file allows VS Code to prompt the user to install the recommended extension upon opening the project.

**Why enable `checkJs` in the JS template?**

It is likely that most cases of changing variable types in runtime are likely to be accidental, rather than deliberate. This provides advanced typechecking out of the box. Should you like to take advantage of the dynamically-typed nature of JavaScript, it is trivial to change the configuration.

**Why is HMR not preserving my local component state?**

HMR state preservation comes with a number of gotchas! It has been disabled by default in both `svelte-hmr` and `@sveltejs/vite-plugin-svelte` due to its often surprising behavior. You can read the details [here](https://github.com/sveltejs/svelte-hmr/tree/master/packages/svelte-hmr#preservation-of-local-state).

If you have state that's important to retain within a component, consider creating an external store which would not be replaced by HMR.

```js
// store.js
// An extremely simple external store
import { writable } from 'svelte/store'
export default writable(0)
```
