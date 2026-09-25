/* daas-hebrew.js — DAAS Hebrew calendar module (dependency-free, no network).
 *
 * Engine: the platform's own ICU Hebrew calendar via
 *   Intl.DateTimeFormat('en-u-ca-hebrew', { timeZone: 'UTC' }).formatToParts()
 * applied to UTC-noon instants, so no local time zone can shift a date.
 * Hebrew → civil is done by indexing a per-Hebrew-year table (civil day of
 * 1 Tishrei + month lengths), itself built from Intl and cached.
 *
 * All civil dates are 'YYYY-MM-DD' strings, treated as pure calendar dates.
 *
 * Loads as: classic <script> (sets globalThis.DaasHebrew), CommonJS
 * (module.exports), or ESM/Deno side-effect import (read globalThis.DaasHebrew).
 * Deliberately no `export` keyword — that would break the classic script.
 *
 * Anniversary rules (owner's decision — birthdays and yahrzeits alike):
 *  - After nightfall → Hebrew date of the NEXT civil day.
 *  - Adar of a regular year → Adar II in a leap year, Adar in a regular year.
 *  - Adar I / Adar II → same month in a leap year, Adar in a regular year.
 *  - A 30th that doesn't exist in the target year (30 Cheshvan, 30 Kislev,
 *    30 Adar I → regular Adar) → the 29th of that month.
 *  - Otherwise same month and day.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.DaasHebrew = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DAY_MS = 86400000;

  // Canonical month codes (stored / compared in code) and display names.
  var NAMES = {
    tishrei: 'Tishrei', cheshvan: 'Cheshvan', kislev: 'Kislev', teves: 'Teves',
    shevat: 'Shevat', adar: 'Adar', adar1: 'Adar I', adar2: 'Adar II',
    nissan: 'Nissan', iyar: 'Iyar', sivan: 'Sivan', tammuz: 'Tammuz', av: 'Av', elul: 'Elul'
  };
  var LEAP = ['tishrei', 'cheshvan', 'kislev', 'teves', 'shevat', 'adar1', 'adar2',
              'nissan', 'iyar', 'sivan', 'tammuz', 'av', 'elul'];

  // Intl month name → code. Keys are lower-cased with everything except
  // letters/digits stripped. Node 22 ICU emits: Tishri, Heshvan, Kislev, Tevet,
  // Shevat, Adar (regular), Adar I, Adar II, Nisan, Iyar, Sivan, Tamuz, Av, Elul
  // — for both month:'long' and month:'numeric'. Aliases cover other engines.
  var ALIASES = {
    tishri: 'tishrei', tishrei: 'tishrei',
    heshvan: 'cheshvan', cheshvan: 'cheshvan', marheshvan: 'cheshvan', marcheshvan: 'cheshvan', hesvan: 'cheshvan',
    kislev: 'kislev', kislew: 'kislev',
    tevet: 'teves', teves: 'teves', tebeth: 'teves',
    shevat: 'shevat', shvat: 'shevat', shebat: 'shevat', sevat: 'shevat',
    adar: 'adar', adari: 'adar1', adar1: 'adar1', adarii: 'adar2', adar2: 'adar2',
    nisan: 'nissan', nissan: 'nissan',
    iyar: 'iyar', iyyar: 'iyar',
    sivan: 'sivan', tamuz: 'tammuz', tammuz: 'tammuz', av: 'av', ab: 'av', elul: 'elul'
  };

  var fmt = null;   // lazily created shared formatter
  function formatter() {
    if (!fmt) fmt = new Intl.DateTimeFormat('en-u-ca-hebrew',
      { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });
    return fmt;
  }

  // ── civil day numbers (days since 1970-01-01, pure integers) ──
  function isoToDay(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    if (!m) throw new Error('DaasHebrew: bad ISO date "' + iso + '"');
    return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY_MS);
  }
  function dayToIso(n) {
    var d = new Date(n * DAY_MS);
    var y = d.getUTCFullYear(), mo = d.getUTCMonth() + 1, da = d.getUTCDate();
    return String(y).padStart(4, '0') + '-' + (mo < 10 ? '0' : '') + mo + '-' + (da < 10 ? '0' : '') + da;
  }
  function todayIso() {   // caller's local calendar date (pass fromIso to be explicit)
    var d = new Date();
    return dayToIso(Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS));
  }

  // ── raw Intl conversion for one civil day, memoised ──
  var rawCache = new Map();
  function rawHeb(n) {
    var hit = rawCache.get(n);
    if (hit) return hit;
    var parts = formatter().formatToParts(new Date(n * DAY_MS + DAY_MS / 2));   // UTC noon
    var y, mo, d;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p.type === 'year') y = parseInt(p.value.replace(/\D/g, ''), 10);
      else if (p.type === 'day') d = parseInt(p.value.replace(/\D/g, ''), 10);
      else if (p.type === 'month') mo = p.value;
    }
    var code = ALIASES[String(mo).toLowerCase().replace(/[^a-z0-9]/g, '')];
    if (!code || !y || !d) throw new Error('DaasHebrew: unrecognised Intl output "' + mo + '"');
    hit = { year: y, month: code, day: d };
    if (rawCache.size > 20000) rawCache.clear();
    rawCache.set(n, hit);
    return hit;
  }

  // ── per-Hebrew-year table: civil day of 1 Tishrei, month order, lengths ──
  var REF_DAY = isoToDay('2024-10-03'), REF_YEAR = 5785;   // 1 Tishrei 5785 (anchor for the estimate)
  var yearCache = new Map();

  function roshHashanaDay(hy) {
    // Estimate by mean year length, then hop 29 days at a time until inside
    // Tishrei of hy (a 30-day month can't be skipped by 29-day hops).
    var n = REF_DAY + Math.round((hy - REF_YEAR) * 365.2468);
    for (var guard = 0; guard < 200; guard++) {
      var h = rawHeb(n);
      if (h.year === hy && h.month === 'tishrei') return n - (h.day - 1);
      n += (h.year < hy) ? 29 : -29;
    }
    throw new Error('DaasHebrew: cannot locate Rosh Hashana ' + hy);
  }

  function yearInfo(hy) {
    var info = yearCache.get(hy);
    if (info) return info;
    var start = roshHashanaDay(hy), s = start, months = [], len = {}, off = {};
    // Walk month by month: a month has 30 days iff its start+29 is still day 30.
    for (var k = 0; k < 13; k++) {
      var h = rawHeb(s);
      if (h.year !== hy) break;
      var L = rawHeb(s + 29).day === 30 ? 30 : 29;
      months.push(h.month); len[h.month] = L; off[h.month] = s - start; s += L;
    }
    info = { year: hy, start: start, length: s - start, leap: months.length === 13,
             months: months, len: len, off: off };
    yearCache.set(hy, info);
    return info;
  }

  function isLeapYear(hy) { return yearInfo(hy).leap; }
  function monthsOfYear(hy) { return yearInfo(hy).months.slice(); }
  function daysInMonth(hy, code) {
    var L = yearInfo(hy).len[code];
    if (!L) throw new Error('DaasHebrew: month ' + code + ' not in year ' + hy);
    return L;
  }
  function monthName(code) { return NAMES[code] || ''; }

  // Hebrew {year, month, day} → civil day number.
  function hebToDay(hy, code, day) {
    var info = yearInfo(hy);
    if (!(code in info.off)) throw new Error('DaasHebrew: month ' + code + ' not in year ' + hy);
    return info.start + info.off[code] + day - 1;
  }

  function decorate(y, code, d) {
    var name = NAMES[code];
    return { year: y, month: code, day: d, monthName: name, leap: isLeapYear(y),
             label: d + ' ' + name + ' ' + y };
  }

  // Civil → Hebrew. afterNightfall → Hebrew date of the next civil day.
  function toHebrew(iso, opts) {
    var n = isoToDay(iso) + (opts && opts.afterNightfall ? 1 : 0);
    var h = rawHeb(n);
    return decorate(h.year, h.month, h.day);
  }

  function formatHebrew(h, opts) {
    var withYear = !(opts && opts.year === false);
    return h.day + ' ' + (NAMES[h.month] || h.monthName) + (withYear ? ' ' + h.year : '');
  }

  function hebrewMonthOf(iso, opts) { return toHebrew(iso, opts).month; }

  // Where an anniversary of Hebrew date `origin` falls in Hebrew year hy (RULES above).
  function observedDate(origin, hy) {
    var targetLeap = isLeapYear(hy), m = origin.month, d = origin.day;
    if (m === 'adar') m = targetLeap ? 'adar2' : 'adar';                     // regular-year Adar
    else if (m === 'adar1' || m === 'adar2') m = targetLeap ? m : 'adar';   // leap-year Adars
    var L = daysInMonth(hy, m);
    if (d > L) d = L;   // 30 Cheshvan / 30 Kislev / 30 Adar I→Adar → the 29th
    return { year: hy, month: m, day: d };
  }

  // Next civil date on/after fromIso (strictly after if includeToday=false)
  // on which the anniversary of `origin` falls. Never earlier than the origin's own year.
  function nextOccurrence(origin, fromIso, opts) {
    var includeToday = !(opts && opts.includeToday === false);
    var from = isoToDay(fromIso || todayIso());
    var min = includeToday ? from : from + 1;
    var hy = Math.max(rawHeb(from).year, origin.year);
    for (var i = 0; i < 3; i++, hy++) {
      var o = observedDate(origin, hy), n = hebToDay(o.year, o.month, o.day);
      if (n >= min) {
        var h = decorate(o.year, o.month, o.day);
        return { iso: dayToIso(n), daysAway: n - from,
                 hebrew: { year: h.year, month: h.month, day: h.day, monthName: h.monthName, label: h.label } };
      }
    }
    return null;   // unreachable in practice
  }

  function nextHebrewBirthday(dobIso, afterNightfall, fromIso) {
    return nextOccurrence(toHebrew(dobIso, { afterNightfall: !!afterNightfall }), fromIso);
  }
  function nextYahrzeit(passingIso, afterNightfall, fromIso) {
    return nextOccurrence(toHebrew(passingIso, { afterNightfall: !!afterNightfall }), fromIso);
  }

  // Next civil anniversary on/after fromIso. Feb 29 → Feb 28 in non-leap civil years.
  function nextCivilAnniversary(iso, fromIso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    if (!m) throw new Error('DaasHebrew: bad ISO date "' + iso + '"');
    var from = isoToDay(fromIso || todayIso()), y = new Date(from * DAY_MS).getUTCFullYear();
    for (var i = 0; i < 2; i++, y++) {
      var mo = +m[2], d = +m[3];
      var civLeap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
      if (mo === 2 && d === 29 && !civLeap) d = 28;
      var n = Math.round(Date.UTC(y, mo - 1, d) / DAY_MS);
      if (n >= from) return { iso: dayToIso(n), daysAway: n - from };
    }
    return null;
  }

  // Yom Tov days (work forbidden) falling in civil year Y, sorted ISO strings.
  var YT = [['tishrei', 1], ['tishrei', 2], ['tishrei', 10], ['tishrei', 15], ['tishrei', 16],
            ['tishrei', 22], ['tishrei', 23], ['nissan', 15], ['nissan', 16], ['nissan', 21],
            ['nissan', 22], ['sivan', 6], ['sivan', 7]];
  var DIASPORA_ONLY = { 'tishrei-16': 1, 'tishrei-23': 1, 'nissan-16': 1, 'nissan-22': 1, 'sivan-7': 1 };
  function yomTovDates(civilYear, opts) {
    var diaspora = !(opts && opts.diaspora === false), out = [];
    var lo = Math.round(Date.UTC(civilYear, 0, 1) / DAY_MS), hi = Math.round(Date.UTC(civilYear + 1, 0, 1) / DAY_MS);
    // Civil year Y overlaps Hebrew years Y+3760 (Jan–Sep) and Y+3761 (Sep–Dec).
    for (var hy = civilYear + 3760; hy <= civilYear + 3761; hy++) {
      for (var i = 0; i < YT.length; i++) {
        if (!diaspora && DIASPORA_ONLY[YT[i][0] + '-' + YT[i][1]]) continue;
        var n = hebToDay(hy, YT[i][0], YT[i][1]);
        if (n >= lo && n < hi) out.push(dayToIso(n));
      }
    }
    return out.sort();
  }

  return {
    MONTH_CODES: LEAP.concat(['adar']), MONTH_NAMES: NAMES,
    toHebrew: toHebrew, isLeapYear: isLeapYear, daysInMonth: daysInMonth,
    monthsOfYear: monthsOfYear, monthName: monthName, formatHebrew: formatHebrew,
    observedDate: observedDate, nextOccurrence: nextOccurrence,
    nextHebrewBirthday: nextHebrewBirthday, nextYahrzeit: nextYahrzeit,
    nextCivilAnniversary: nextCivilAnniversary, hebrewMonthOf: hebrewMonthOf,
    yomTovDates: yomTovDates, hebrewToCivil: function (hy, code, day) { return dayToIso(hebToDay(hy, code, day)); }
  };
});
