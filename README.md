# Wayfare

Next GO, TTC subway, bus and streetcar departures, and when to leave to catch them.

Live at https://wayfare.huzaim.ca/

## What it does

- GO trains and buses, live from Metrolinx.
- TTC subway lines 1, 2, 4, 5 and 6, plus buses and streetcars.
- Pick a station. See the next departures. See when to leave.
- Sort by distance if you share your location. Your location never leaves your device.

## How it works

- Static site on GitHub Pages. No accounts, no cookies, no analytics, no ads.
- One small Cloudflare Worker sits in front of the transit APIs. It holds the Metrolinx key and caches responses. It stores nothing about you.

## What it does not do

- No YRT, MiWay, Brampton or DRT yet. Each needs its own adapter.
- Times are the next few departures from the live feed, not the full day timetable.
- Walking time is straight line distance with a detour factor, not a routed path.

## Privacy

No accounts. No tracking. Settings live on your device only. Full policy: privacy.html.

Unofficial. Not affiliated with the TTC, GO Transit or Metrolinx.
