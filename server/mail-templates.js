// Los textos de los correos. El transporte (mail.js) solo manda; aquí viven el asunto y el HTML.
//
// La API de correo toma UN cuerpo HTML y quien lo lee suele tener Outlook, que ignora casi todo el CSS moderno: todo va
// con estilos en línea y la estructura es una tabla de ancho fijo (sin flex, sin variables CSS, sin imágenes remotas).
//
// Todo lo que viene de fuera (usuario, contraseña, enlace) se escapa: el usuario lo escribió un administrador y no debe
// poder meter marcado en un correo.

// El nombre que ve la gente en la app (Header.svelte), no el del repositorio
export const BRAND = 'Buzzword IA DevOps';

const PRIMARY = '#4268fb'; // --primary de app.css
const INK = '#1f2937';
const MUTED = '#6b7280';
const LINE = '#e2e8f0';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);

// Solo http(s): el enlace sale del entorno del servidor, pero nunca debe poder ser `javascript:` ni nada parecido
const safeUrl = (url) => (/^https?:\/\/[^\s"'<>]+$/i.test(url ?? '') ? url : '');

const row = (label, value, last) =>
  `<tr><td style="padding:${last ? '4px 18px 4px' : '16px 18px 4px'};font-size:12px;color:${MUTED}">${label}</td></tr>` +
  `<tr><td style="padding:0 18px ${last ? '16px' : '12px'};font-size:18px;font-weight:bold;letter-spacing:1px;color:${INK};` +
  `font-family:Consolas,'Courier New',monospace">${esc(value)}</td></tr>`;

// El relleno va en la CELDA, no en el <a>: Outlook de escritorio ignora el padding de los enlaces
function button(url) {
  return (
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px"><tr>' +
    `<td bgcolor="${PRIMARY}" style="background:${PRIMARY};border-radius:8px;padding:12px 22px">` +
    `<a href="${esc(url)}" style="display:inline-block;color:#ffffff;font-size:15px;font-weight:bold;` +
    'text-decoration:none">Entrar al panel</a></td></tr></table>' +
    `<p style="margin:0 0 20px;font-size:12px;color:${MUTED}">Si el botón no abre, copia y pega este enlace en tu navegador:<br>` +
    `<span style="word-break:break-all">${esc(url)}</span></p>`
  );
}

// El correo con el usuario y la contraseña temporal. Devuelve `{ subject, html }`.
export function passwordEmail({ username, password, appUrl }) {
  const url = safeUrl(appUrl);
  const html =
    `<div style="background:#f1f4f9;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;color:${INK};line-height:1.5">` +
    // width="560" para Outlook de escritorio (ignora max-width); el estilo lo deja fluido en pantallas chicas
    '<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;margin:0 auto">' +
    // franja de marca
    `<tr><td bgcolor="${PRIMARY}" style="background:${PRIMARY};padding:20px 28px;border-radius:12px 12px 0 0">` +
    `<span style="color:#ffffff;font-size:18px;font-weight:bold">${esc(BRAND)}</span></td></tr>` +
    // tarjeta
    '<tr><td bgcolor="#ffffff" style="background:#ffffff;padding:28px 28px 12px">' +
    `<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:${INK}">Tus accesos temporales</h1>` +
    `<p style="margin:0 0 16px;font-size:14px">Hola, <strong>${esc(username)}</strong>. Ya tienes acceso al panel de ${esc(BRAND)}. ` +
    'Con estos datos puedes entrar:</p>' +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f8fafc" ` +
    `style="margin:0 0 20px;background:#f8fafc;border:1px solid ${LINE};border-radius:8px">` +
    row('Usuario', username, false) +
    row('Contraseña temporal', password, true) +
    '</table>' +
    (url ? button(url) : '') +
    '<p style="margin:0 0 16px;font-size:14px">Al entrar por primera vez se te pedirá elegir una contraseña propia ' +
    '(mínimo 8 caracteres). La temporal deja de servir en cuanto la cambias.</p>' +
    '</td></tr>' +
    // pie
    `<tr><td bgcolor="#f8fafc" style="background:#f8fafc;padding:16px 28px 20px;font-size:12px;color:${MUTED};` +
    `border-top:1px solid ${LINE};border-radius:0 0 12px 12px">` +
    'No compartas tu contraseña con nadie. Si no esperabas este correo, ignóralo y avisa a quien administra el panel.<br><br>' +
    `Este correo lo manda el servicio de notificaciones (remitente «ART») a nombre de ${esc(BRAND)}. ` +
    'Se generó automáticamente: por favor, no respondas a este mensaje.' +
    '</td></tr></table></div>';
  return { subject: `Tus accesos a ${BRAND}`, html };
}
