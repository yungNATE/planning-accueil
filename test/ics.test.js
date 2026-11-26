// Fichiers .ics : conformité RFC 5545 vérifiée avec ical.js (Mozilla).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ICAL from 'ical.js';
import { parsePlanning } from '../src/parse-planning.js';
import { buildCalendar, employeeEvents, escapeText, foldLine } from '../src/ics.js';
import { readOctober } from './helpers.js';

const planning = parsePlanning(readOctober(), { source: 'PLANNING_OCTOBRE_26.xlsx' });
const stamp = '2026-11-24T16:55:00.000Z';
const calendars = planning.employees.map((employee) => ({
  employee,
  text: buildCalendar({
    name: `Accueil – ${employee.name} – Octobre 2026`,
    events: employeeEvents(employee, { title: 'Accueil', source: planning.source, stamp }),
  }),
}));

/** @param {string} text */
function parseCalendar(text) {
  const component = new ICAL.Component(ICAL.parse(text));
  for (const vtz of component.getAllSubcomponents('vtimezone')) ICAL.TimezoneService.register(vtz);
  return component.getAllSubcomponents('vevent').map((v) => new ICAL.Event(v));
}

/** @param {any} time */
const utc = (time) => time.toJSDate().toISOString();

test('chaque fichier est lu par ical.js et contient un événement par créneau', () => {
  for (const { employee, text } of calendars) {
    const events = parseCalendar(text);
    assert.equal(events.length, employee.slotCount, employee.name);
  }
});

test('UID uniques et stables', () => {
  for (const { text } of calendars) {
    const uids = parseCalendar(text).map((e) => e.uid);
    assert.equal(new Set(uids).size, uids.length);
  }
  assert.match(calendars[1].text, /UID:20260929-nathan@planning-accueil\r\n/);
});

test('fins de ligne CRLF et lignes de 75 octets au plus', () => {
  for (const { text } of calendars) {
    assert.ok(!/[^\r]\n/.test(text), 'saut de ligne sans CR');
    for (const line of text.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line);
  }
});

test('heure d’hiver : Nathan le 25 octobre 15h–22h à Paris = 14h–21h UTC', () => {
  const nathan = calendars.find((c) => c.employee.name === 'Nathan');
  const event = parseCalendar(nathan.text).find((e) => e.startDate.toString().startsWith('2026-10-25'));
  assert.equal(utc(event.startDate), '2026-10-25T14:00:00.000Z');
  assert.equal(utc(event.endDate), '2026-10-25T21:00:00.000Z');
  // La veille, encore à l'heure d'été : 15h à Paris = 13h UTC
  const tom = calendars.find((c) => c.employee.name === 'Tom');
  const saturday = parseCalendar(tom.text).find((e) => e.startDate.toString().startsWith('2026-10-24'));
  assert.equal(utc(saturday.startDate), '2026-10-24T06:00:00.000Z');
});

test('échappement des valeurs texte', () => {
  assert.equal(escapeText('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne');
});

test('repli à 75 octets sans couper un caractère accentué', () => {
  const line = `DESCRIPTION:${'é'.repeat(100)}`;
  const folded = foldLine(line);
  for (const part of folded.split('\r\n')) assert.ok(Buffer.byteLength(part) <= 75);
  assert.equal(folded.replace(/\r\n /g, ''), line);
});

test('créneau de nuit et créneau finissant à 24h', () => {
  const text = buildCalendar({
    name: 'Test',
    events: employeeEvents(
      { slug: 'test', days: { '2026-03-28': { raw: '22H-6H / 20H-24H', cell: 'C7', slots: [{ start: '20:00', end: '24:00', overnight: false }, { start: '22:00', end: '06:00', overnight: true }] } } },
      { title: 'Accueil', source: 'test.xlsx', stamp },
    ),
  });
  const [a, b] = parseCalendar(text);
  // Nuit du 28 au 29 mars 2026 : passage à l'heure d'été
  assert.equal(utc(a.startDate), '2026-03-28T19:00:00.000Z');
  assert.equal(utc(a.endDate), '2026-03-28T23:00:00.000Z');
  assert.equal(utc(b.startDate), '2026-03-28T21:00:00.000Z');
  assert.equal(utc(b.endDate), '2026-03-29T04:00:00.000Z');
  assert.equal(b.uid, '20260328-test-2@planning-accueil');
});
