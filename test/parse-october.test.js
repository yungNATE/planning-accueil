// Planning réel d'octobre 2026 : sert de référence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlanning } from '../src/parse-planning.js';
import { readOctober } from './helpers.js';

const planning = parsePlanning(readOctober(), { source: 'PLANNING_OCTOBRE_26.xlsx' });
const byName = Object.fromEntries(planning.employees.map((e) => [e.name, e]));

test('le fichier est lu sans erreur', () => {
  assert.deepEqual(planning.errors, []);
  assert.equal(planning.ok, true);
  assert.equal(planning.month, '2026-10');
});

test('quatre employés, la faute « SYVAIN » est rattachée à Sylvain avec un avertissement', () => {
  assert.deepEqual(planning.employees.map((e) => e.name), ['Louna', 'Nathan', 'Sylvain', 'Tom']);
  const warning = planning.warnings.find((w) => w.message.includes('SYVAIN'));
  assert.ok(warning, 'avertissement attendu pour SYVAIN');
  assert.equal(warning.cell, 'B30');
});

test('période du lundi 28 septembre au dimanche 1er novembre 2026, débordements compris', () => {
  assert.equal(planning.start, '2026-09-28');
  assert.equal(planning.end, '2026-11-01');
  assert.equal(planning.days.length, 35);
});

test('nombre de créneaux par employé', () => {
  assert.equal(byName.Louna.slotCount, 4);
  assert.equal(byName.Sylvain.slotCount, 24);
  assert.equal(byName.Tom.slotCount, 24);
  assert.equal(byName.Nathan.slotCount, 25);
  assert.equal(planning.employees.reduce((n, e) => n + e.slotCount, 0), 77);
});

test('cas précis', () => {
  // RH = OFF
  assert.deepEqual(byName.Nathan.days['2026-09-28'].slots, []);
  assert.equal(byName.Nathan.days['2026-09-28'].raw, 'RH');
  // Nom décalé en B14 : les horaires de la ligne 13 sont bien rattachés à Nathan
  assert.deepEqual(byName.Nathan.days['2026-09-29'].slots, [{ start: '08:00', end: '15:30', overnight: false }]);
  assert.equal(byName.Nathan.days['2026-09-29'].cell, 'D13');
  // MA = OFF
  assert.deepEqual(byName.Tom.days['2026-09-29'].slots, []);
  assert.equal(byName.Tom.days['2026-09-29'].raw, 'MA');
  // Jour du passage à l'heure d'hiver
  assert.deepEqual(byName.Nathan.days['2026-10-25'].slots, [{ start: '15:00', end: '22:00', overnight: false }]);
  // Louna n'apparaît que dans le premier bloc ; ses cases vides sont OFF
  assert.equal(byName.Louna.days['2026-10-11'].slots.length, 0);
  assert.equal(byName.Louna.days['2026-10-12'], undefined);
});
