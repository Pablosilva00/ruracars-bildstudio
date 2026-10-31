// RuraCars Bild-Studio – Bestand-Abgleich (Pablo Silva für RuraCars Wuppertal)
// Holt den aktuellen Fahrzeugbestand von ruracars.de/data/vehicles.json, legt Daten und
// die ersten Fotos jedes Fahrzeugs neben die App (bestand/) und merkt sich:
//   seit         – an welchem Tag ein Fahrzeug zum ersten Mal auftauchte (für „Neu im Bestand“)
//   alterPreis   – den vorherigen Preis, wenn der Preis gesenkt wurde (für „Preis gesenkt“)
//   entfernt     – an welchem Tag ein Fahrzeug aus dem Bestand verschwand (für „Verkauft“)
// Läuft automatisch über GitHub Actions (.github/workflows/bestand.yml). Keine Pakete nötig.

import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const QUELLE = (process.env.BESTAND_QUELLE || 'https://ruracars.de/').replace(/\/?$/, '/');
const ZIEL = process.env.BESTAND_ZIEL || 'ruracars-bildstudio/bestand';
const HEUTE = process.env.BESTAND_HEUTE || new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date());
const FOTOS_PRO_FAHRZEUG = 8;
const ENTFERNTE_BEHALTEN_TAGE = 30;
const PREIS_MERKEN_TAGE = 30;
const UA = 'RuraCars-Bild-Studio/1.0 (+https://pablosilva00.github.io/ruracars-bildstudio/)';
const KAROSSERIE = new Set(['avant', 'coupe', 'coupé', 'cabrio', 'cabriolet', 'sportback', 'sportbrake', 'touring', 'kombi', 'variant', 'limousine', 'roadster', 'spider', 'spyder', 'allroad', 'tourer']);

const tageZwischen = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);
const nurZiffern = s => String(s ?? '').replace(/\D/g, '');

async function holen(url, extraHeaders = {}) {
  let letzterFehler;
  for (let versuch = 1; versuch <= 3; versuch++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA, ...extraHeaders }, signal: AbortSignal.timeout(30000) });
      if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
      return r;
    } catch (e) {
      letzterFehler = e;
      await new Promise(res => setTimeout(res, 2000 * versuch));
    }
  }
  throw letzterFehler;
}

async function jsonLesen(datei, ersatz) {
  try { return JSON.parse(await readFile(datei, 'utf8')); } catch { return ersatz; }
}

// "Volkswagen T5 Multivan Multivan DPF Comfortline" -> { modell: "Volkswagen T5 Multivan", ausstattung: "DPF Comfortline" }
// "Audi A6 A6 Avant 50 TFSI e quattro"              -> { modell: "Audi A6 Avant",          ausstattung: "50 TFSI e quattro" }
export function titelTeilen(titel) {
  const w = String(titel || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const k = w.map(x => x.toLowerCase());
  let schnitt = -1;
  for (let i = 2; i < Math.min(w.length, 6); i++) {
    if (k.slice(0, i).includes(k[i])) { schnitt = i; break; }
  }
  if (schnitt < 0) schnitt = Math.min(2, w.length);
  const modell = w.slice(0, schnitt);
  const bekannt = new Set(modell.map(x => x.toLowerCase()));
  let j = schnitt;
  while (j < w.length && bekannt.has(k[j])) j++;
  if (j < w.length && KAROSSERIE.has(k[j]) && w.length - j > 1) { modell.push(w[j]); j++; }
  return { modell: modell.join(' ').slice(0, 40), ausstattung: w.slice(j).join(' ').slice(0, 60) };
}

export function kraftstoff(f) {
  const s = String(f || '').toLowerCase();
  if (/hybrid/.test(s) || (/elektro/.test(s) && /benzin|diesel/.test(s))) return 'Hybrid';
  if (/elektro/.test(s)) return 'Elektro';
  if (/diesel/.test(s)) return 'Diesel';
  if (/autogas|lpg/.test(s)) return 'Autogas';
  if (/erdgas|cng/.test(s)) return 'Erdgas';
  if (/benzin/.test(s)) return 'Benzin';
  return String(f || '').trim();
}

async function main() {
  // 1) Bestand von der Website lesen
  let liste;
  try {
    const r = await holen(QUELLE + 'data/vehicles.json');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    liste = await r.json();
  } catch (e) {
    console.warn(`ruracars.de gerade nicht erreichbar (${e.message}). Bestand bleibt unverändert.`);
    return;
  }
  if (!Array.isArray(liste)) throw new Error('vehicles.json hat ein unerwartetes Format (keine Liste). Bitte prüfen.');
  if (liste.length === 0) { console.warn('vehicles.json ist leer – Bestand bleibt unverändert.'); return; }

  await mkdir(ZIEL, { recursive: true });
  const bestandDatei = path.join(ZIEL, 'bestand.json');
  const cacheDatei = path.join(ZIEL, '_cache.json'); // Dateien mit "_" veröffentlicht GitHub Pages nicht
  const vorher = await jsonLesen(bestandDatei, null);
  const ersterLauf = !vorher;
  const alt = new Map((vorher?.fahrzeuge || []).map(f => [f.id, f]));
  const cache = await jsonLesen(cacheDatei, {});
  const neuerCache = {};
  const fahrzeuge = [];
  const gesehen = new Set();

  // 2) Aktuelle Fahrzeuge
  for (const v of liste) {
    const id = String(v.id || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 90);
    if (!id || gesehen.has(id)) continue;
    gesehen.add(id);
    const a = alt.get(id);
    const { modell, ausstattung } = titelTeilen(v.title);
    const preis = Number(v.price) || Number(nurZiffern(v.priceLabel)) || 0;

    let alterPreis = 0, preisGesenkt = '';
    if (a && a.preis && preis && preis < a.preis) { alterPreis = a.preis; preisGesenkt = HEUTE; }
    else if (a && a.alterPreis && preis && preis < a.alterPreis && a.preisGesenkt && tageZwischen(a.preisGesenkt, HEUTE) <= PREIS_MERKEN_TAGE) { alterPreis = a.alterPreis; preisGesenkt = a.preisGesenkt; }

    // Fotos (nur neue oder geänderte werden geladen)
    const ordner = path.join(ZIEL, id);
    await mkdir(ordner, { recursive: true });
    const fotos = [];
    const quellen = (Array.isArray(v.images) ? v.images : []).slice(0, FOTOS_PRO_FAHRZEUG);
    for (let i = 0; i < quellen.length; i++) {
      const url = new URL(String(quellen[i]).replace(/^\/+/, ''), QUELLE).href;
      const endung = (path.extname(new URL(url).pathname).toLowerCase().match(/^\.(webp|jpe?g|png)$/) || ['.jpg'])[0];
      const name = `${i + 1}${endung}`;
      const datei = path.join(ordner, name);
      const vorhanden = await readFile(datei).then(() => true, () => false);
      const c = cache[url];
      const kopf = {};
      if (vorhanden && c?.etag) kopf['if-none-match'] = c.etag;
      if (vorhanden && c?.lastModified) kopf['if-modified-since'] = c.lastModified;
      try {
        const r = await holen(url, kopf);
        if (r.status === 304) { neuerCache[url] = c; fotos.push(`${id}/${name}`); continue; }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const daten = Buffer.from(await r.arrayBuffer());
        if (daten.length < 1000) throw new Error('Datei zu klein');
        await writeFile(datei, daten);
        neuerCache[url] = { etag: r.headers.get('etag') || '', lastModified: r.headers.get('last-modified') || '' };
        fotos.push(`${id}/${name}`);
      } catch (e) {
        console.warn(`Foto nicht geladen: ${url} (${e.message})`);
        if (vorhanden) { if (c) neuerCache[url] = c; fotos.push(`${id}/${name}`); }
      }
    }
    // überzählige alte Fotos löschen
    const behalten = new Set(fotos.map(f => path.basename(f)));
    for (const d of await readdir(ordner)) if (!behalten.has(d)) await rm(path.join(ordner, d), { force: true });

    fahrzeuge.push({
      id,
      titel: String(v.title || '').replace(/\s+/g, ' ').trim(),
      modell, ausstattung,
      ez: /^\d{2}\/\d{4}$/.test(String(v.year || '').trim()) ? String(v.year).trim() : '',
      km: Number(nurZiffern(v.mileage)) || 0,
      ps: Number((String(v.power || '').match(/(\d+)\s*PS/i) || [])[1]) || 0,
      kraftstoff: kraftstoff(v.fuel),
      getriebe: String(v.transmission || '').trim(),
      preis, alterPreis, preisGesenkt,
      seit: a ? a.seit : (ersterLauf ? '' : HEUTE),
      entfernt: '',
      fotos,
      anzeige: /^https:\/\//.test(v.listingUrl || '') ? v.listingUrl : ''
    });
  }

  // 3) Nicht mehr online: noch 30 Tage behalten (für „Verkauft“-Beiträge), danach löschen
  for (const [id, a] of alt) {
    if (gesehen.has(id)) continue;
    const entfernt = a.entfernt || HEUTE;
    if (tageZwischen(entfernt, HEUTE) > ENTFERNTE_BEHALTEN_TAGE) { await rm(path.join(ZIEL, id), { recursive: true, force: true }); continue; }
    for (const [url, c] of Object.entries(cache)) if (url.includes(`/${id}/`)) neuerCache[url] = c;
    fahrzeuge.push({ ...a, entfernt, alterPreis: a.alterPreis || 0, preisGesenkt: a.preisGesenkt || '' });
  }

  // 4) Ordner von Fahrzeugen aufräumen, die in keiner Liste mehr stehen
  const ids = new Set(fahrzeuge.map(f => f.id));
  for (const d of await readdir(ZIEL, { withFileTypes: true })) if (d.isDirectory() && !ids.has(d.name)) await rm(path.join(ZIEL, d.name), { recursive: true, force: true });

  // 5) Speichern (geprueft ändert sich höchstens einmal am Tag)
  const ergebnis = { quelle: QUELLE + 'data/vehicles.json', geprueft: HEUTE, fahrzeuge };
  await writeFile(bestandDatei, JSON.stringify(ergebnis, null, 1) + '\n');
  await writeFile(cacheDatei, JSON.stringify(neuerCache, null, 1) + '\n');
  const aktiv = fahrzeuge.filter(f => !f.entfernt);
  console.log(`Bestand: ${aktiv.length} Fahrzeuge online, ${fahrzeuge.length - aktiv.length} nicht mehr online.`);
  for (const f of fahrzeuge) console.log(`  ${f.entfernt ? '–' : '•'} ${f.modell} | ${f.ausstattung} | ${f.preis} €${f.alterPreis ? ` (vorher ${f.alterPreis} €)` : ''}${f.seit ? ` | seit ${f.seit}` : ''}${f.entfernt ? ` | entfernt ${f.entfernt}` : ''} | ${f.fotos.length} Fotos`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
