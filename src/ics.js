// @ts-check
/**
 * Générateur iCalendar (RFC 5545), sans dépendance et sans API Node.
 * Les horaires sont écrits en heure locale avec TZID=Europe/Paris et un bloc VTIMEZONE :
 * ils restent justes au changement d'heure, quel que soit le fuseau de la machine qui génère le fichier.
 */
import { addDays, formatHour } from './util.js';

const CRLF = '\r\n';
const PRODID = '-//planning-accueil//Plannings Accueil//FR';
export const TZID = 'Europe/Paris';

const VTIMEZONE_PARIS = [
  'BEGIN:VTIMEZONE',
  `TZID:${TZID}`,
  'X-LIC-LOCATION:Europe/Paris',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'TZNAME:CEST',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'TZNAME:CET',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
];

/**
 * Échappe une valeur TEXT (RFC 5545 §3.3.11).
 * @param {string} value
 */
export function escapeText(value) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

const encoder = new TextEncoder();

/**
 * Replie une ligne à 75 octets UTF-8 (RFC 5545 §3.1), sans couper un caractère multi-octets.
 * @param {string} line
 */
export function foldLine(line) {
  const out = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    if (bytes + size > 75) {
      out.push(current);
      current = ` ${ch}`;
      bytes = 1 + size;
    } else {
      current += ch;
      bytes += size;
    }
  }
  out.push(current);
  return out.join(CRLF);
}

/** « 2026-10-25 » + « 15:30 » → « 20261025T153000 » ; « 24:00 » passe au lendemain à 00:00. */
function localDateTime(/** @type {string} */ date, /** @type {string} */ time) {
  let d = date;
  let t = time;
  if (t === '24:00') { d = addDays(d, 1); t = '00:00'; }
  return `${d.replace(/-/g, '')}T${t.replace(':', '')}00`;
}

/** ISO 8601 UTC → « 20261124T165500Z » */
function utcStamp(/** @type {string} */ iso) {
  return `${iso.replace(/[-:]/g, '').replace(/\.\d+/, '').slice(0, 15)}Z`;
}

/**
 * @typedef {{
 *   uid: string, date: string, start: string, end: string, overnight: boolean,
 *   summary: string, description?: string, location?: string, stamp: string
 * }} CalendarEvent
 */

/**
 * Événements d'un employé à partir des journées parsées.
 * UID stable : <AAAAMMJJ>-<slug>[-n]@planning-accueil (n à partir du 2e créneau de la journée).
 * @param {{ slug: string, days: Record<string, import('./parse-planning.js').DayEntry> }} employee
 * @param {{ title: string, location?: string, source: string, stamp: string }} options
 * @returns {CalendarEvent[]}
 */
export function employeeEvents(employee, options) {
  /** @type {CalendarEvent[]} */
  const events = [];
  for (const [date, day] of Object.entries(employee.days)) {
    day.slots.forEach((slot, i) => {
      events.push({
        uid: `${date.replace(/-/g, '')}-${employee.slug}${i ? `-${i + 1}` : ''}@planning-accueil`,
        date,
        start: slot.start,
        end: slot.end,
        overnight: slot.overnight,
        summary: `${options.title} ${formatHour(slot.start)}–${formatHour(slot.end)}`,
        description: `Saisie dans le planning : ${day.raw}\nFichier : ${options.source}`,
        location: options.location || undefined,
        stamp: options.stamp,
      });
    });
  }
  return events;
}

/**
 * Construit le texte d'un fichier .ics.
 * @param {{ name: string, events: CalendarEvent[], subscription?: boolean }} calendar
 */
export function buildCalendar({ name, events, subscription = false }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`,
    `NAME:${escapeText(name)}`,
    `X-WR-TIMEZONE:${TZID}`,
  ];
  if (subscription) lines.push('REFRESH-INTERVAL;VALUE=DURATION:PT6H', 'X-PUBLISHED-TTL:PT6H');
  lines.push(...VTIMEZONE_PARIS);

  const sorted = [...events].sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
  for (const ev of sorted) {
    const endDate = ev.overnight ? addDays(ev.date, 1) : ev.date;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${ev.uid}`,
      `DTSTAMP:${utcStamp(ev.stamp)}`,
      `DTSTART;TZID=${TZID}:${localDateTime(ev.date, ev.start)}`,
      `DTEND;TZID=${TZID}:${localDateTime(endDate, ev.end)}`,
      `SUMMARY:${escapeText(ev.summary)}`,
    );
    if (ev.description) lines.push(`DESCRIPTION:${escapeText(ev.description)}`);
    if (ev.location) lines.push(`LOCATION:${escapeText(ev.location)}`);
    lines.push('TRANSP:OPAQUE', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join(CRLF) + CRLF;
}
