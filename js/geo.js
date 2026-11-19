import { WALK } from './config.js';

export function haversine(a, b) {
  const R = 6371000, r = x => (x * Math.PI) / 180;
  const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

// Called only after the person taps a button. The result stays in memory and is never sent anywhere.
export function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('unsupported'));
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      reject,
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 }
    );
  });
}

export const walkMinutes = (from, to) => Math.max(1, Math.ceil((haversine(from, to) * WALK.detour) / WALK.mps / 60));
export const fmtDistance = m => (m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
