// The one setting you must change: the URL of your deployed Worker, no trailing slash needed.
export const WORKER_URL = '';

export const REFRESH_MS = 20000;
export const WALK = { mps: 1.3, detour: 1.25 }; // walking speed and a straight-line-to-street detour factor
export const TTC_SURFACE_COLOR = '#E31837';

export const AGENCIES = {
  go: { name: 'GO Transit', mark: 'GO' },
  ttc: { name: 'TTC', mark: 'TTC' }
};
// Official agency logos, downloaded from Wikimedia Commons. Each has a colour
// version (for light backgrounds) and a white version (for dark backgrounds);
// main.js picks between them from the current palette. Both are trademarks of
// their owners; Wayfare is unofficial and not affiliated with either agency.
export const LOGOS = {
  go: { color: 'assets/go.svg', white: 'assets/go-white.svg' },
  ttc: { color: 'assets/ttc.svg', white: 'assets/ttc-white.svg' }
};

// toUnion / fromUnion are the compass letters shown for trains heading to or away from Union.
// Edit freely: this is a preference table, not data from Metrolinx.
export const GO_LINES = {
  LW: { name: 'Lakeshore West', color: '#AD1A46', toUnion: 'E', fromUnion: 'W' },
  LE: { name: 'Lakeshore East', color: '#DA291C', toUnion: 'W', fromUnion: 'E' },
  MI: { name: 'Milton',         color: '#FF8200', toUnion: 'E', fromUnion: 'W' },
  KI: { name: 'Kitchener',      color: '#007A33', toUnion: 'E', fromUnion: 'W' },
  RH: { name: 'Richmond Hill',  color: '#0096C3', toUnion: 'S', fromUnion: 'N' },
  ST: { name: 'Stouffville',    color: '#8B5B29', toUnion: 'S', fromUnion: 'N' },
  BR: { name: 'Barrie',         color: '#0059B3', toUnion: 'S', fromUnion: 'N' },
  UP: { name: 'UP Express',     color: '#2688C7', toUnion: 'E', fromUnion: 'W' }
};
export const GO_BUS = { name: 'GO Bus', color: '#00843D' };

// Letter -> terminal. Used to turn the arrival text into N/E/S/W. Line 1 is a U shape, so
// here N means "toward Finch" and S means "toward Vaughan Metropolitan Centre". Change if you prefer.
export const SUBWAY = {
  '1': { name: 'Line 1', color: '#FFC800', N: 'Finch', S: 'Vaughan' },
  '2': { name: 'Line 2', color: '#008741', E: 'Kennedy', W: 'Kipling' },
  '4': { name: 'Line 4', color: '#B4006E', E: 'Don Mills', W: 'Sheppard' },
  '5': { name: 'Line 5', color: '#D24619', E: 'Kennedy', W: 'Mount Dennis' },
  '6': { name: 'Line 6', color: '#898D8D', E: 'Finch West', W: 'Humber' }
};
