'use strict';

/** Returns YYYY-MM-DD for the Monday of the ISO week containing `date`. */
function isoWeekMonday(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7; // Mon=1 .. Sun=7
  d.setUTCDate(d.getUTCDate() - day + 1);
  return d.toISOString().slice(0, 10);
}

function mondaysBack(n, fromDate = new Date()) {
  const out = [];
  const base = new Date(isoWeekMonday(fromDate));
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() - i * 7);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function firstOfMonth(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`;
}

module.exports = { isoWeekMonday, mondaysBack, firstOfMonth };
