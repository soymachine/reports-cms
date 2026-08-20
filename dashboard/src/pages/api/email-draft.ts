import type { APIRoute } from 'astro';
import db, { parseLead } from '../../lib/db';

export const prerender = false;

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }
  const leadId = Number(body?.lead_id);
  if (!leadId) return Response.json({ ok: false, error: 'missing lead_id' }, { status: 400 });

  const lead = parseLead(db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId));
  if (!lead) return Response.json({ ok: false, error: 'lead not found' }, { status: 404 });

  const pairs = (lead.generated as any[]).filter((g) => g.original_img && g.generated_img);

  const beforeAfterBlocks = pairs
    .map(
      (g, i) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px 0;">
    <tr>
      <td colspan="2" style="font-family:monospace;font-size:12px;color:#666;padding:0 0 8px 0;">Página ${esc(g.page)}</td>
    </tr>
    <tr>
      <td width="50%" style="padding:0 6px 0 0;vertical-align:top;">
        <div style="font-family:monospace;font-size:11px;color:#999;padding:0 0 4px 0;">ANTES</div>
        <img src="{{IMG_PAGE_${i + 1}_ANTES}}" alt="Página ${esc(g.page)} original" width="100%" style="border:1px solid #ddd;border-radius:6px;display:block;" />
      </td>
      <td width="50%" style="padding:0 0 0 6px;vertical-align:top;">
        <div style="font-family:monospace;font-size:11px;color:#999;padding:0 0 4px 0;">DESPUÉS</div>
        <img src="{{IMG_PAGE_${i + 1}_DESPUES}}" alt="Página ${esc(g.page)} rediseñada" width="100%" style="border:1px solid #ddd;border-radius:6px;display:block;" />
      </td>
    </tr>
  </table>`
    )
    .join('\n');

  const greeting = lead.contact1_name ? `Hola ${esc(String(lead.contact1_name).split(' ')[0])},` : 'Hola,';

  const html = `<!doctype html>
<html>
<body style="margin:0;padding:24px;background:#ffffff;font-family:Georgia,serif;color:#222;">
  <div style="max-width:640px;margin:0 auto;">
    <p style="font-size:15px;line-height:1.6;">${greeting}</p>
    <p style="font-size:15px;line-height:1.6;">
      Soy de <strong>Think Things</strong>, un estudio de diseño gráfico de Barcelona especializado en
      informes y visualización de datos. Hemos estado revisando los informes públicos de
      <strong>${esc(lead.organisation)}</strong> y creemos que hay una oportunidad clara de elevar su
      impacto visual.
    </p>
    <p style="font-size:15px;line-height:1.6;">
      Como ejercicio, hemos rediseñado ${pairs.length > 0 ? `${pairs.length} página(s)` : 'algunas páginas'}
      de uno de vuestros reports. Aquí podéis ver el antes y el después:
    </p>
    ${beforeAfterBlocks || '<p style="font-size:13px;color:#999;font-family:monospace;">[adjuntar ejemplos antes/después]</p>'}
    <p style="font-size:15px;line-height:1.6;">
      Si os interesa explorar cómo podría verse vuestro próximo informe, estaré encantado de
      enseñaros más ejemplos en una llamada breve.
    </p>
    <p style="font-size:15px;line-height:1.6;">
      Un saludo,<br/>
      <strong>Think Things</strong><br/>
      <span style="font-size:13px;color:#666;">Estudio de diseño gráfico — Barcelona</span>
    </p>
  </div>
</body>
</html>`;

  db.prepare("UPDATE leads SET email_draft = ?, updated_at = datetime('now') WHERE id = ?").run(html, leadId);

  return Response.json({ ok: true, html, pairs: pairs.length });
};
