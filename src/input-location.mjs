// Optional user-supplied attachment. Error text must never contain coordinates.
export function normalizeInputLocation(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 4
    || !["latitude", "longitude", "accuracy", "timestamp"].every(key => Object.hasOwn(value, key))) {
    throw new TypeError("location must contain latitude, longitude, accuracy, and timestamp");
  }
  const { latitude, longitude, accuracy, timestamp } = value;
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
    || !Number.isFinite(accuracy) || accuracy < 0
    || !Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 8_640_000_000_000_000) {
    throw new TypeError("location coordinates, accuracy, or timestamp are invalid");
  }
  return { latitude: latitude || 0, longitude: longitude || 0, accuracy: accuracy || 0, timestamp };
}

// The location a user shared with a message, as the marked text block the worker adds
// to the message it sends to the core: the model sees it; displays leave it out.
export const HARNESS_LOCATION_BLOCK = "location";
export function locationBlock(value) {
  const location = normalizeInputLocation(value);
  return { type: "text", harness: HARNESS_LOCATION_BLOCK,
    text: `User-shared device location (not independently verified): latitude ${location.latitude}; longitude ${location.longitude}; accuracy ${location.accuracy} m; captured at ${new Date(location.timestamp).toISOString()}.` };
}