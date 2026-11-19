import { IntegrationError, readJson, send, type HttpOptions } from './http.ts';

/**
 * Google Geocoding API (v3 JSON, checked Nov 2026):
 *   GET https://maps.googleapis.com/maps/api/geocode/json?address=...&key=...
 *   status OK | ZERO_RESULTS | OVER_QUERY_LIMIT | OVER_DAILY_LIMIT |
 *          REQUEST_DENIED | INVALID_REQUEST | UNKNOWN_ERROR
 *   results[].geometry.location { lat, lng }, formatted_address, place_id, partial_match
 * https://developers.google.com/maps/documentation/geocoding/requests-geocoding
 *
 * Only facility addresses are geocoded. A resident's home address is health
 * information and never leaves the database.
 */
export const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

export type GeocodeResult = {
  latitude: number;
  longitude: number;
  placeId: string;
  formattedAddress: string;
  /** Google matched only part of the address; ask a person to confirm. */
  partialMatch: boolean;
};

type ApiResponse = {
  status: string;
  error_message?: string;
  results?: {
    formatted_address: string;
    place_id: string;
    partial_match?: boolean;
    geometry: { location: { lat: number; lng: number } };
  }[];
};

const STATUS_RETRYABLE: Record<string, boolean> = {
  OVER_QUERY_LIMIT: true,
  UNKNOWN_ERROR: true,
  OVER_DAILY_LIMIT: false,
  REQUEST_DENIED: false,
  INVALID_REQUEST: false,
};

export class GoogleGeocoder {
  constructor(private readonly config: HttpOptions & { apiKey: string; region?: string }) {}

  /** Returns undefined when Google has no match for the address. */
  async geocode(address: string): Promise<GeocodeResult | undefined> {
    const params = new URLSearchParams({ address, key: this.config.apiKey });
    if (this.config.region) params.set('region', this.config.region);

    const response = await send('google-geocoding', `${GEOCODE_URL}?${params}`, { method: 'GET' }, {
      ...this.config,
      onError: async (res) => new IntegrationError('google-geocoding', 'request_failed', res.status >= 500, res.status),
    });
    const body = await readJson<ApiResponse>(response);
    if (!body) throw new IntegrationError('google-geocoding', 'invalid_response', true);

    if (body.status === 'ZERO_RESULTS') return undefined;
    if (body.status !== 'OK') {
      throw new IntegrationError('google-geocoding', body.status.toLowerCase(), STATUS_RETRYABLE[body.status] ?? false);
    }
    const [first] = body.results ?? [];
    if (!first) return undefined;
    return {
      latitude: first.geometry.location.lat,
      longitude: first.geometry.location.lng,
      placeId: first.place_id,
      formattedAddress: first.formatted_address,
      partialMatch: first.partial_match === true,
    };
  }
}
