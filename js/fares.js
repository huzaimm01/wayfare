// Fare estimates. Figures verified Nov 2026:
// - TTC PRESTO: adult $3.30, senior $2.25. A post-secondary student taps
//   the adult fare on TTC; the student saving is on GO. Monthly fare
//   capping: TTC rides are free after 47 paid trips in a calendar month.
// - GO standard single fare comes from data/go-fares.json (GTFS zone
//   matrix). PRESTO adult pays 15.7% less (trips 1-35 in a month),
//   youth/post-secondary 40% off the standard fare, seniors 55% off.
//   Same-trip loyalty: trips 36-40 are 88.3% off, 41+ free.
// - One Fare: with PRESTO or a tapped card, the TTC leg of a TTC+GO trip
//   is free. UP Express is NOT part of One Fare.
// - UP Express Union-Pearson adult PRESTO is $9.25; student/senior are
//   derived from the same standard-fare ratios.
let goFares = null;
export async function loadGoFares() {
  if (!goFares) goFares = await (await fetch('data/go-fares.json')).json();
  return goFares;
}

const PRESTO = 0.843, STUDENT = 0.6, SENIOR = 0.45;
export const TTC_FARE = { adult: 3.3, student: 3.3, senior: 2.25 };
export const UP_ADULT_PRESTO = 9.25;

export const money = n => '$' + n.toFixed(2);

export function goFareFor(fares, fromCode, toCode, rider = 'adult') {
  const std = fares.fares[fares.zoneOf[fromCode]]?.[fares.zoneOf[toCode]];
  if (std == null) return null;
  return rider === 'student' ? std * STUDENT : rider === 'senior' ? std * SENIOR : std * PRESTO;
}
export function upFare(rider = 'adult') {
  const std = UP_ADULT_PRESTO / PRESTO;
  return rider === 'student' ? std * STUDENT : rider === 'senior' ? std * SENIOR : UP_ADULT_PRESTO;
}

// legs: router legs. Returns {total, parts, note}.
export async function fareFor(legs, rider = 'adult') {
  const goLegs = legs.filter(l => l.kind === 'ride' && l.mode === 'go' && l.line !== 'UP');
  const upLegs = legs.filter(l => l.kind === 'ride' && l.line === 'UP');
  const ttcLegs = legs.filter(l => l.kind === 'ride' && l.mode === 'subway');
  const parts = [];
  let unknown = false;
  if (goLegs.length) {
    const fares = await loadGoFares();
    const from = goLegs[0].from.replace('go:', ''), to = goLegs[goLegs.length - 1].to.replace('go:', '');
    const f = goFareFor(fares, from, to, rider);
    if (f == null) unknown = true;
    else parts.push({ label: `GO ${from} to ${to}`, amount: f });
  }
  if (upLegs.length) parts.push({ label: 'UP Express', amount: upFare(rider) });
  if (ttcLegs.length && !goLegs.length) parts.push({ label: 'TTC', amount: TTC_FARE[rider] });
  const total = unknown ? null : parts.reduce((s, p) => s + p.amount, 0);
  const notes = [];
  if (goLegs.length && ttcLegs.length) notes.push('TTC is free on this trip with One Fare.');
  if (ttcLegs.length) notes.push('TTC rides are free after 47 paid trips this month.');
  if (goLegs.length) notes.push('GO rides 41+ in a month are free.');
  return { total, parts, note: notes.join(' ') };
}
